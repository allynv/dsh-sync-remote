# dsh-sync-remote

把本机的 DSH Web GUI 发布到公网，同时让本机端口**只监听回环**，VPS 上**不装任何常驻服务**（只用自带的 `sshd` 和 Nginx）。

```
外部浏览器 → https://dsh.dsh.example.com (443)
                ↓  Nginx 终止 TLS，proxy_pass http://127.0.0.1:3090（保留 Host）
          VPS:127.0.0.1:3090            ← 本插件请求的 SSH 反向隧道监听点
                ↓  sshd 转发（ssh2 forwardIn）
          本机 127.0.0.1:3090           ← 插件的 Passkey 网关
                ↓  校验签名会话 Cookie
          本机 127.0.0.1:3080           ← DSH Web 本体（仅回环）
```

三个模块都在一个插件进程里：**M1 SSH 反向隧道**（`ssh2`）、**M2 Passkey 网关**（`@simplewebauthn/server`）、**M3 透明反向代理**。

---

## 一、先说两处必须纠正的地方

你原方案里这两条与实际代码不符，照做会直接失败：

**1. 不要改写 `Host`，要保留它。**
DSH 的浏览器信任围栏（`packages/client/connection/src/api-request-trust.ts`）接受三类 `Host`：回环、监听地址本身、以及配置里的 `trustedHosts`。请求返回 **403 不是"必须改写 Host"的信号，而是"这个 Host 不在受信列表里"的信号**——正确做法是启动 DSH 时加 `--trusted-host dsh.dsh.example.com`。

改写 `Host` 为 `127.0.0.1:3080` 反而会**破坏 DSH 自己的登录态**：它的会话 Cookie 名字由 Host 派生（`browser-auth.ts` 的 `requestAudience`/`cookieName`），改 Host 后 Cookie 名对不上，页面永远 401；而 `Origin` 一旦被剥掉，DSH 的跨站检查也就失效了。所以本插件的代理层**原样透传 `Host`、`Origin`、`Referer`、`Sec-Fetch-*`**，只丢弃逐跳头（`connection`、`transfer-encoding` 等）。

**2. 实时通道是 `/api/remote.mux`，不是 `/api/events.mux`。**
`WebSocket` 走 `packages/api/gateway/src/stream-protocol.ts` 里的 `/api/remote.mux`；另外 `packages/client/hmr` 的 `/plugins/events` 是 SSE。两者本插件都支持（升级请求按字节透传，SSE 不禁缓冲）。

这样安排之后，**DSH 自己的启动令牌 + 签名 Cookie 仍然生效**，Passkey 网关是在它前面的**另一道门**，而不是替代它。多一道默认拒绝的好处是：光有启动 URL 也进不来。

---

## 二、安装

```powershell
# 1) 依赖：运行时 5 个（ssh2 / @simplewebauthn/server / @deepseek-ai/schemastery / @deepseek-ai/cosmokit / qrcode-generator）
pnpm install        # 或 npm install --ignore-scripts --cache .npm-cache

# 2) 构建浏览器半边（src/app.ts、src/client.ts → lib/app.js、lib/client.js）
npm run build

# 3) 类型检查：宿主项目（无 DOM lib）+ 客户端项目（有 DOM lib），两次都必须为 0 报错
npm run check

# 4) 自测（配置派生、Cookie 签名、状态文件、代理头、WebSocket 往返、隧道退避、apply 入口、控制台输出、探测时机、一次性注册链接、自动登录重定向、路径与构建产物护栏）
#    检查条目会随版本增长，数量以最后一行输出为准，不要在文档里写死。
npm test            # = npm run build && node test/selfcheck.mts && node test/client.spec.mts

# 5) 装进 web profile（在 DSH 里让 agent 调用 plugin_manager install_bundle，
#    target 传本目录绝对路径，例如 F:\Repos\allyn-plugins\dsh-sync-remote）
#    已装（application: applied）。没填 publicOrigin 时插件保持空闲、只打一行日志，
#    启动后到「设置 → 远程访问」里填一次即可生效。
```

开发期也可以不装 bundle，直接覆盖挂载（`cordis.yml` 里的插件名相对**该文件**解析，所以命令里用本目录的绝对路径即可）：

```powershell
dsh --profile web --patch <本仓库目录>\cordis.yml
```

### 为什么是 TypeScript，以及哪一半需要构建

**宿主半边**（`gateway.ts`、`tunnel.ts`、`index.ts`…）是 `.ts`，由 Node 26 的**类型擦除**直接执行——`package.json` 的 `exports` 就指向 `./src/index.ts`，这一半没有产物，改完即生效。代价与约束：

| 约束 | 原因 / 对策 |
| :--- | :--- |
| 相对导入必须写 `.ts` 扩展名（`from './config.ts'`） | 擦除模式**不会**把 `./x.js` 回退成 `x.ts`（实测报 `ERR_MODULE_NOT_FOUND`）。`tsconfig` 里用 `allowImportingTsExtensions` + `noEmit` 让 `tsc` 接受这种写法。 |
| 不能写 `enum` / `namespace` / 构造函数参数属性 | Node 的 strip-only 模式直接抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。`tsconfig` 开了 `erasableSyntaxOnly`，让 `tsc` 在编辑期就拦住这三种写法。 |
| 类型检查要自己跑 | 擦除不检查类型：不跑 `npm run check`，TS 就只是装饰。 |

**浏览器半边**（`src/client.ts` 设置页、`src/app.ts` 登录页脚本）必须**构建**：浏览器不会做类型擦除，而 DSH 只把 `exports["./client"]` 指到的文件原样交给页面。所以：

```powershell
npm run build          # 先清空 lib/ 再 tsc -p tsconfig.build.json → lib/app.js, lib/client.js（有类型错误就不写产物）
                       # 清空是必要的：outDir 里有陈旧文件时，增量发射可能留下与源码不符的产物
npm run build:watch    # 开发时挂在旁边
npm run check          # 两次类型检查：宿主项目(无 DOM lib) + 浏览器项目(有 DOM lib，含客户端测试)
npm test               # 先 build，再跑两套测试
```

配置分成三份，各司其职：`tsconfig.json`（宿主类型检查，**故意没有 DOM lib**）、`tsconfig.client.json`（浏览器半边 + 客户端测试的类型检查，`noEmit`，含 `dom` 与 `node` 类型）、`tsconfig.build.json`（**只负责 emit**：`rootDir: src` → `lib/`，`types: []`，`noEmitOnError`）。

| 事实 | 说明 |
| :--- | :--- |
| 产物不入库 | `lib/` 在 `.gitignore` 里：克隆后先 `npm ci && npm run build` 再启动 dsh。缺产物时 `src/pages.ts` **加载即报错并告诉你跑哪条命令**（不是浏览器白页）。 |
| 改了客户端源码要重新 build | 然后刷新页面；若页面仍是旧 bundle，重启 `dsh`（该 bundle 由 DSH 在插件激活时读取）。 |
| 两套 `tsconfig`，职责分开 | 宿主项目**故意不含 DOM lib**（免得有人在 `gateway.ts` 里顺手写 `document`）；`tsconfig.client.json` 含 `dom`，而 DSH 专有的两个全局（模块表 `__ModuleLoader__`、`styles`）**就地声明在 `src/client.ts` 顶部**——它是经典脚本，脚本的顶层声明本来就是全局的，所以不需要单独的 `.d.ts`，也不需要重定义 `window`/`document`；`tsconfig.build.json` 只 emit，且 `noEmitOnError`——类型不过就不写产物，避免出现半坏的 bundle。 |
| `client.ts` 里只允许类型导入 | 值导入会让产物带上 `./xxx.ts` 这种浏览器解析不了的说明符；`test/selfcheck.mts` 有一条断言盯着产物里不许出现相对导入。 |
| **客户端半边是「经典脚本」，不是 ES 模块** | DSH 用 `document.createElement('script')`（无 `type="module"`）加载客户端 bundle，它自己的 bundle 也是 CJS——所以 `src/client.ts` **绝不能**出现顶层 `export`/`import`（在 TS 里给文件加 `export {}` 是最顺手的"变成模块"写法，但那会让产物带着 `export` 进浏览器，设置页直接白屏 `Unexpected token 'export'`）。登录页脚本 `src/app.ts` 相反：它以 `<script type="module">` 提供，因此可以有 `export {}`（顶层 `await` 需要它）。`test/selfcheck.mts` 对两者各有一条断言。 |

`tsconfig.json` 的关键项：`strict: true`、`noEmit: true`、`allowImportingTsExtensions: true`、`erasableSyntaxOnly: true`、`module/moduleResolution: nodenext`、`noUnusedLocals/Parameters: true`。共享类型放在 [src/types.ts](src/types.ts)（`Logger`、`PasskeyRecord`、`StateDocument`），配置/隧道类型定义在 [src/config.ts](src/config.ts)。

> 登录页脚本 [src/app.ts](src/app.ts) 以前是 `pages.ts` 里的一段**字符串**（不参与类型检查）；现在它是真 TS：WebAuthn 的选项/响应都有类型，`credentials.get/create` 的 `null` 也被显式处理。它仍然**零 import**（CSP 是 `script-src 'self'`，浏览器不需要解析任何说明符）。
>
> 设置页本体 [src/client.ts](src/client.ts) 是**真 TS**（不再是 `// @ts-check` + JSDoc 的 JS），由 `lib/client.js` 提供给浏览器；它用到的 DSH 专有全局就地声明在该文件顶部（见上）。
>
> 两个测试文件是 `.mts`：宿主那套在 `tsconfig.json` 的 `include` 里，客户端那套（`test/client.spec.mts`）在 `tsconfig.client.json` 的 `include` 里，`npm run check` 两次都会跑到，所以 `strict` 覆盖测试代码本身。

### 设置页面与扫码注册（推荐路径）

装好之后不必再碰环境变量（**插件也不读它们**）：**设置 → 远程访问**（Remote access）里就是全部参数。

> **升级提示**：这一版起插件不再读 `DSH_GW_*` / `VPS_*`。如果你之前用环境变量部署，升级后请打开设置页把**公网地址、VPS 地址、SSH 用户、私钥路径**填一次并保存（保存后这些值就落在 profile 补丁里，以后与升级无关）。在此之前公网入口是关闭的，本机 `http://127.0.0.1:3080` 照常可用。

| 能力 | 说明 |
| :--- | :--- |
| 全部参数可编辑 | 10 个字段分两组（基本 / SSH 反向隧道），每个字段标出**当前值来自哪一层**：`来自插件配置` / `默认值` / `未设置`。 |
| 固定值只读显示 | 网关监听地址、本机 DSH、RP ID、认证器显示名、状态文件、VPS 监听地址、已固定主机密钥——都列在「固定值（不可修改）」里，不占输入框。主机密钥旁边有「重新信任」：清掉记录并让隧道重连、重新固定。 |
| 值写在哪里 | 写进 **profile 补丁**（`~/.dsh/profiles/web/cordis.patch.yml`）里本插件那一行的 `config`。升级不丢，YAML 仍可手改（见「三、配置」）。 |
| 保存后发生什么 | DSH 的 Config 变更会让本行 **dispose 后重新 `apply()`**：先关掉旧监听与隧道，再按新值重绑 —— 不需要重启 `dsh` 进程。 |
| 运行状态 | 网关是否在监听、隧道状态与重连次数、以及 DSH 围栏对该 authority 的预检结果（`该 Host 被接受` / `被拒绝：给 dsh web 加 --trusted-host`）。 |

#### 注册：一个二维码，一次性，用过即失效

| 行为 | 说明 |
| :--- | :--- |
| 地址短 | 链接形如 `https://<你的域名>/auth?token=…`，扫码/朗读/粘贴都只有这一小段。网关的路径都是**根路径**，没有任何命名空间前缀，也没有旧路径别名。 |
| 只有一个入口 | 页面里就一个「生成注册二维码」/「重新生成」。没有第二个"登录链接"二维码。 |
| 一次性 | 点一次生成一个**新的随机令牌**，扫这个二维码完成注册后**立即失效**；页面、控制台、`enroll-url.txt` 三处的链接同时作废。 |
| 10 分钟上限 | 没人用的链接 **10 分钟**后自动失效：网关停止接受它、`enroll-url.txt` 随之删除，页面的倒计时归零后二维码消失。 |
| 重新生成 | 还有设备要注册，就再点一次（旧的立刻失效）。页面会明说这一条。 |
| 已登录的浏览器点链接 = 进主页 | 如果点链接的浏览器**已经有网关会话**，说明这台设备不需要注册：网关返回 `303 → /`（或它记着的目标页）**直接进 DSH**，并且**不消耗令牌**——在错的设备上点开，不会把给手机准备的链接弄废。要在同一台已登录的浏览器上"再加一把 Passkey"（例如 Windows Hello 旁边再加安全密钥），加 `&add=1` 走这条明确的例外。 |
| 首台设备免点击 | 进程启动时**若一把 Passkey 都没有**，会自动生成一条链接并打印到控制台/写入文件（无头部署也能装第一台）；页面打开时会自己重新生成一张二维码。 |
| 不落盘 | 令牌只存在内存里：重启即失效，状态文件里没有任何注册凭据。`enroll-url.txt` 只在该链接有效期间存在，用完/超时/重启即删除。 |
| 注册完自动登录 | 新设备注册完 Passkey 就自动进入 DSH：网关先放行，若 DSH 自己的会话还没建立（返回 401），网关会**一次性**把浏览器重定向到带启动令牌的地址，让 DSH 设置它自己的 Cookie。每次浏览器每分钟只尝试一次，失败就直接显示 DSH 的登录页，不会循环。 |

两点行为说明：

1. **配置写错不再让整行失败。** 以前 `resolveConfig` 抛错会让该插件行加载失败；现在它记一条 `error` 日志、网关保持关闭、**行保持激活**，并在设置页顶部显示原因。理由很直接：设置页是修配置的地方，而行一旦失败就会从设置服务里消失，连修复界面都没了。（`resolveConfig` 本身仍然拒绝非法值，测试照旧。）
   > 注意区分两种状态：**「还没填公网地址」不算错误**——插件只打一行 info，页面显示橙色引导（"填好公网地址并保存即可开启公网入口"）；只有**填了但值不合法**（不是绝对 URL、带路径、端口越界、隧道三项缺一等）才显示红色横幅并给出具体原因。
2. **状态载荷里没有令牌。** 设置页轮询的状态接口只报告"有没有待用链接、什么时候过期"；令牌只在点「生成」的那一次响应里出现，并已渲染成二维码。

安全边界：四个接口注册在 DSH 自己的 `/api` 通道上（`ctx.connection.fetch`），因此**先过 DSH 的浏览器信任围栏与操作员会话**才轮到本插件。注册链接是凭据，未登录的请求拿不到它（部署验收里有一项专门验证这一点）；SSH 私钥口令声明为 `role('secret')`。

> 客户端半边（`src/client.ts`）是**真 TypeScript**，构建产物 `lib/client.js` 由浏览器直接取 `package.json` 的 `exports["./client"]` 运行；改完记得 `npm run build`（`npm test` 会先构建）。

## 三、配置

> 本节是**参考手册**。日常改配置请用上面的设置页面；下面这份 YAML 是等价的另一种写法（手改 profile 补丁时用）。

**插件不读任何环境变量**：配置只有两个来源 —— 插件行自己的 `config`（设置页面写进 profile 补丁的那一层）与内置默认值。所以不会出现"一半在环境变量、一半在配置文件"的状态。

### 可编辑字段（10 个）

| 字段 | 含义 | 默认 |
| :--- | :--- | :--- |
| `publicOrigin` | 浏览器访问的公网 origin | **无（必填）** |
| `serverPort` | **服务端端口（映射端口）**：VPS 上 `sshd` 以 `127.0.0.1:<这个端口>` 监听转发，Nginx 反代到这里（本机网关也用同一端口，所以 `ssh -R` 两端一致） | **无（必填）**：必须与 Nginx 的 `proxy_pass` 一致，猜错时隧道看着正常而公网 502 |
| `clientPort` | **客户端端口**：本机 `dsh web` 的端口（始终按 `127.0.0.1` 连接） | **无（必填）**：占位符建议 `3080`，但你写什么就是什么 |
| `sessionTtlHours` | 网关会话有效期（小时） | **无（必填）**：占位符建议 `720`（30 天） |
| `tunnel.enabled` | 是否开隧道。**唯一例外**：它不是"要你填的值"，而是对下面三项的开关，所以不写也按"三项齐备=开"推导（界面里明写"自动"） | 由 host/user/key 推导 |
| `tunnel.host` | VPS 地址（SSH 目标）。**设置页默认遮蔽显示**（像密码框），右侧眼睛图标可切换显隐；仓库里不含任何真实地址，占位符是文档用 IP | **无（必填）** |
| `tunnel.port` | **VPS 的 SSH 端口**（你的 `ssh` 命令里省略的 `-p`，不是上面那个穿透监听端口） | **无（必填）**：占位符建议 `22` |
| `tunnel.user` | SSH 用户 | **无（必填）** |
| `tunnel.privateKeyFile` | 私钥**绝对路径** | **无（必填）** |
| `tunnel.passphrase` | 私钥口令（`role('secret')`，永不下发到浏览器） | 无（口令可能真的不存在，"未设置"是一个真实取值，不是默认值） |

**规则：凡是设置页里有输入框的，配置里就必须有，且代码里不许有默认值。** 只有 `tunnel.enabled` 是刻意的例外（开关，状态由必填的三项推导）；除它以外，缺任何一项都会被明确拒绝并点名该字段，例如
`dsh-sync-remote: serverPort is required — it must be the port the VPS listens on AND the one Nginx proxies to, …`。
`test/selfcheck.mts` 里有一条 `every value with a box in the settings form is required` 逐字段验证这条规则（缺哪个都必须报 "<path> is required"），防止以后有人再加回隐藏默认值。

### 字段 ↔ `ssh` 命令对照

插件做的等价事情就是一条 `ssh -R`，字段与命令参数的对应关系是：

```
ssh [-i <tunnel.privateKeyFile>] -p <tunnel.port> -N -R <serverPort>:127.0.0.1:<serverPort> <tunnel.user>@<tunnel.host>
```

（注意 `-R` 的右边是**本机网关**的端口 = `serverPort`，不是 `clientPort`；网关再把请求转给 `clientPort` 上的 `dsh web`。）

| 命令里的部分 | 含义 | 插件字段 |
| :--- | :--- | :--- |
| `-p <n>` | **VPS 的 SSH 端口**（省略即 22） | `tunnel.port` |
| `-R <p>` | VPS 上监听哪个端口（映射端口，VPS 侧 `127.0.0.1:<p>`） | `serverPort` |
| `-R …:127.0.0.1:` | VPS 侧绑回环 | `tunnel.remoteHost`（固定 `127.0.0.1`） |
| `-R …:<p>` | 转发到本机哪个端口（本网关） | 由 `serverPort` 派生（两端一致） |
| `-i <file>` | 私钥 | `tunnel.privateKeyFile` |
| `user@host` | SSH 目标 | `tunnel.user` / `tunnel.host` |
| （不出现在命令里） | 本机 `dsh web` 的端口，由网关转给它 | `clientPort` |

**设置页面直接显示这一行**（「固定值（不可修改）」里的「等价命令」），控制台启动时也会打印一次。最常见的填错就是把 `-p` 的位置也填成隧道端口，页面会显示成
`ssh … -p 3090 -N -R 3090:127.0.0.1:3090 …` —— 一眼就能看出 `-p` 该是 22。

### 固定值（不是字段，页面只显示）

| 值 | 为什么不能改 |
| :--- | :--- |
| 网关监听地址 `127.0.0.1` | 公网入口在 VPS 上，本机绑到网卡会让会话 Cookie 走明文 |
| 状态文件 `~/.dsh/dsh-sync-remote/state.json` | 里面是签名密钥与已注册的 Passkey，路径写错等于换了一份身份 |
| WebAuthn RP ID | 必须等于公网 origin 的 hostname，否则浏览器直接拒绝 |
| 认证器显示名 `DeepSeek Harness` | 只是弹窗里的名字，没有可配价值 |
| 本机 DSH 地址 | 由 `clientPort` 拼出 `http://127.0.0.1:<clientPort>` |
| VPS 监听地址 `127.0.0.1` | Nginx 就在那台机器上，绑回环是唯一正确的选择 |
| 已固定主机密钥 | 首次连接时自动记录（TOFU）；页面可「重新信任」清掉它 |

```yaml
- insert:
    - id: dsh-sync-remote
      name: '@allynv/dsh-sync-remote'
      config:
        publicOrigin: https://dsh.example.com
        serverPort: 3090
        clientPort: 3080
        tunnel:
          host: 203.0.113.10
          user: root
          privateKeyFile: C:\Users\me\.ssh\id_ed25519
```

> **私钥格式**：ssh2 只认 OpenSSH 默认格式、PKCS#1（`BEGIN RSA PRIVATE KEY`）、SEC1（`BEGIN EC PRIVATE KEY`）和 PuTTY PPK。
> **PKCS#8（`BEGIN PRIVATE KEY`，openssl 默认产物）会被拒绝**，插件会给出一条明确报错。用 `ssh-keygen -t ed25519 -f <file>` 重新生成即可。

> **未配置 = 功能关闭，配置错误 = 大声失败但行保持激活。**
> 没填 `publicOrigin` 时插件只打一行 "no public origin configured yet" 然后什么都不做；
> 填了但值不合法（origin 不是 URL、端口越界、隧道三项缺一等）时，插件打一条 `error` 说明原因、**网关保持关闭**，而**插件行仍然激活** —— 这是刻意的：设置页面是修配置的地方，行一旦失败就会从设置服务里消失，连修复界面都没了。原因会显示在页面顶部。

## 四、启动 DSH（关键一步）

```powershell
dsh --profile web --public-url https://dsh.dsh.example.com/ --trusted-host dsh.dsh.example.com
```

- `--public-url` 让控制台打印/打开 `https://dsh.dsh.example.com/?token=…`（一次性登录链接）。
- `--trusted-host` 让 `/api` 围栏接受公网 Host；**缺少它，插件启动日志会直接报 403 并给出修复命令**。
- `--public-url` 一旦设置，`dsh web:` 那行给的是**公网地址**，本机浏览器打不开它；所以插件会**额外补一行本机地址**：

  ```
  dsh-sync-remote: http://127.0.0.1:3080/?token=…
  ```

  端口取配置里的「Web 端口」（`clientPort`），令牌在**打印那一刻**向 Host 取（`authenticatedUrl()`），所以新起的进程、重载后的行都跟着最新的令牌走，不是写死的字符串。它和 `dsh web:` 那行是同一个进程凭据，**敏感度相同**。

**控制台约定（正常启动只多这一行）**：插件不用 `ctx.logger`（那个 logger 在 `dsh web` profile 里不落控制台），而是直接写 `console`。其中：

| 会打印 | 不打印（走设置页） |
| :--- | :--- |
| 上面那行本机链接 | 解析后的配置、状态文件、端口 |
| 配置被拒绝的 `error` | 网关已监听、预检通过 |
| 隧道/上游的失败与异常（认证失败、主机密钥首次固定、断开重连、上游无响应、围栏 403/非 401 应答） | 登录成功、注册成功、隧道事件流 |
| 一次性注册链接（含首台设备的自动生成） | 隧道关闭、隧道端口转发正常 |

想恢复全量日志：把 [src/index.ts](src/index.ts) 里 `loggerFor()` 的 `info: () => {}` 改回 `console.log` 即可。

插件启动时会主动探测一次本机 3080：

| 探测结果 | 含义 |
| :--- | :--- |
| `401` | Host 已被受信列表接受 ✅（属例行 `info`，不上控制台） |
| `403` | 少了 `--trusted-host`，插件会打印修复命令 |
| 无响应 | DSH 本体没起来 |

> 这次探测**等 Loader 装载完成之后**才发（插件向 Host 要 `loader.await()`，和 `web-app` 打印 `dsh web:` 用的是同一个时机）。否则 `/api` 的路由还没挂上，探测会拿到 404 并误报一条 "expected 401" —— 那描述的是启动瞬间，不是你的部署。

## 五、VPS 侧

1. `sshd_config`：保持默认 `GatewayPorts no` 即可。本机请求的是 `127.0.0.1:3090`，OpenSSH 会据此绑定回环，**无需放行 3090 端口**（也无需 `AllowTcpForwarding yes` 之外的额外开关）。
2. Nginx：

```nginx
location / {
    proxy_pass http://127.0.0.1:3090;

    # 保留浏览器看到的 Host：DSH 的信任围栏（--trusted-host）按它判定
    # 注意 $host 是"请求行里的主机名，其次 Host 头"，也就是客户端可控的；
    # 这一点对本插件已无影响（诊断端点改用状态文件令牌），但别把它当成鉴权边界。
    proxy_set_header Host $host;
    proxy_http_version 1.1;

    # 必须：WebSocket（/api/remote.mux）与 SSE（/plugins/events）
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;   # 需在 http{} 里配 map
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    # 建议：DSH 以明文 HTTP 签发 Cookie（不带 Secure），在 HTTPS 外层补上
    proxy_cookie_flags ~ secure httponly;
}
```

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
```

3. 证书由 Nginx 管。站点根路径直接 `proxy_pass` 到 3090 即可；网关自己应答下面这些**根路径**，其余全部转发给 DSH GUI：

   ```
   /auth                一次性注册链接（?token=…）与注册页
   /auth/options  /auth/verify      登录仪式
   /enroll  /enroll/options  /enroll/verify   注册仪式
   /signin              登录页          /app.js   登录页脚本
   /bootstrap           登录页能力探测   /logout   退出（POST）
   /status              只读状态（需 statusToken）  /passkeys/remove   删除设备（POST）
   ```

   路径是**精确匹配**：`/auth/extra`、`/statuses` 这类邻近路径会照常转发给 GUI。

## 六、首次使用

1. **注册 Passkey**：打开 **设置 → 远程访问**，点「生成注册二维码」，用要注册的设备扫它（或复制链接打开）。
   该链接**只能用一次**：注册成功即失效；要再给一台设备注册就再点一次。首台设备在**没有任何 Passkey 时**由插件启动时自动生成一条（会打印在日志里、同时写到状态文件同目录的 `enroll-url.txt`）。
2. **登录**：注册完成会自动进入 DSH —— 网关放行后，若浏览器还没有 DSH 自己的会话，网关会一次性把它重定向到带启动令牌的地址，让 DSH 签发它的签名 Cookie（30 天，之后这步不再需要）。若重定向后仍被拒（例如浏览器禁用了 Cookie），才会看到 DSH 自己的登录页。
3. 想加第二台设备：进设置页再生成一个二维码即可。
4. 想删设备：设置页里的「已注册设备」列表，最后一把 Passkey 会被禁用（Host 侧也会拒绝），避免把自己锁死。
5. 想重新信任 VPS：设置页「已固定主机密钥」旁边的「重新信任」——清掉记录并让隧道重连、重新固定。

## 七、安全边界（务必了解）

- **Passkey 网关是唯一对外的门**。任何未通过校验的请求都不会到达 3080；异常一律 500/拒绝，不泄露上游。
- 登录态是 `HttpOnly + Secure + SameSite=Strict` 的 HMAC 签名 Cookie，服务端还会校验签发/过期时间；`Secure` 由**公网 origin**决定（不是本机 http 监听），所以隧道/反代下也正确。
- 登录页与注册页带严格 CSP（`default-src 'none'`），注册令牌用常量时间比较，注册/登录接口按来源地址限流（5 分钟 30 次）。
- **DSH 自己的令牌链接仍然是一把钥匙**：Passkey 只是额外一道门。别把 `dsh web` 打印的 `?token=…` URL 贴到公开渠道——它本身就是进程凭据。
- 网关会把 DSH 的 401 原样回给 XHR（不返回 HTML）。
- **`/status` 的闸门是状态文件里的签名密钥，不是 Host**。之前的实现只检查 `Host` 是否为回环，而 DSH 官方要求反代**保留浏览器 Host**，所以任何远程客户端都能伪造 `Host: 127.0.0.1` 绕过它（探测过你当前 Nginx 恰好写死了 Host 才没被利用，但那是巧合，不是边界）。现在必须带**独立的只读令牌** `statusToken`（状态文件里，**不是**签名密钥），推荐用请求头 `x-dsh-gw-status` 传递——它不会进 Nginx 的 `$request` 访问日志；`?token=` 仍作为兼容别名可用。令牌只能读取状态，**无法伪造任何 cookie**：
  ```powershell
  curl.exe -sS -H "x-dsh-gw-status: $(Get-Content "$env:USERPROFILE\.dsh\dsh-sync-remote\state.json" | ConvertFrom-Json | Select-Object -ExpandProperty statusToken)" "http://127.0.0.1:3090/status"
  ```
- 未注册时插件启动会自动生成一条一次性注册链接，除日志外还会写一份到 `<stateFile 同目录>\enroll-url.txt`（0600）；**链接被使用、被替换或进程退出时，该文件立即删除**（它是凭据，不该留在磁盘上）。
- 注册链接是**一次性**的：令牌只存在网关进程内存里，状态文件没有任何注册凭据，重启即失效。想再注册一台设备就再生成一个。
- 隧道主机密钥首次连接 TOFU 并写入状态文件；想重新信任就让页面清掉它（或删掉状态文件里的 `sshHostKey`）。
- 状态文件损坏/版本不符会让插件**加载失败**而不是清空凭据——否则下一次注册就会变成对陌生人开放。

## 八、验收步骤

分四段。A、B 两段是命令；C、D 段必须你本人做（需要认证器和手机）。

### A 段 · 代码自检（不依赖任何环境，随时可跑）

```powershell
cd F:\Repos\dsh-plugins\dsh-sync-remote
node test/selfcheck.mts
```

期望：最后一行为 `N/N checks passed`（N 随版本增长），退出码 0。这一段证明的是**代码本身**：签名 Cookie、配置解析与来源标注（含"环境变量完全不影响结果"）、状态文件、代理头改写、经代理的真实 WebSocket 101 往返、隧道退避与主机密钥、设置页的 Config schema / 状态载荷 / 路由拒绝路径、一次性注册链接的生成-替换-退役、DSH 自动登录重定向（含防循环）、`apply()` 入口、拒绝配置时不卸载、以及销毁。

### B 段 · 部署验收（一条命令，对着你真在跑的服务）

脚本**不需要任何环境变量**：它从状态文件取签名密钥，再问运行中的网关要事实（公网 origin、本机 Web 地址、隧道状态）。

```powershell
node test/acceptance.mts                  # 含公网侧检查
node test/acceptance.mts --local          # 只查本机/回环，公网侧跳过
node test/acceptance.mts --port 3091      # 网关端口不是默认 3090 时
node test/acceptance.mts --state <file>   # 状态文件不是默认路径时
```

它会依次判定：

| 检查 | 通过标准 |
| :--- | :--- |
| 网关是否在监听并报告状态 | `/status` + 请求头 `x-dsh-gw-status: <state.statusToken>` 回 200；`origin`、`web`、`bind` 从这份状态里读出，后面所有检查都用它 |
| 本机 DSH Web 是否在跑 | 状态里的 `web` 地址回 401 或 200 |
| 状态文件里的签名密钥 | 文件存在、有 `secret` 和 `passkeys` |
| **DSH 信任围栏是否接受公网 Host** | `Host: <公网 authority>` 请求 `/api` 回 **401**；回 403 就直接告诉你该加 `--trusted-host` |
| 围栏是否仍拒绝陌生 Host | `Host: fence-probe.invalid` 回 403 |
| 网关自身端点是否挡住未认证请求 | `POST /enroll/options`（无授权）回 403；登录页带 CSP |
| **一次性链接规则** | 不带令牌的 `/auth`（无 grant、无会话）回 403 |
| ceremony 端点是否匹配当前注册状态 | 未注册时 `POST /auth/options` 回 400 `no passkey is registered`；已注册时回 200 |
| 状态端点是否只认本机令牌 | 不带 token 访问 `/status` 回 403（**Host 怎么写都一样**）；带该请求头回 200 |
| 公网登录页 | `GET https://…/signin` 回 200、带 CSP、引用 `/app.js` |
| 公网未认证导航 | `GET https://…/` 回 303 → `/signin` |
| 公网 `/api` 未认证 | 回 401 且 body 含 `passkey authentication required`（说明没被转发到 DSH） |
| **经公网的真实 WebSocket 升级** | 未带会话时回 `HTTP/1.1 401`；若超时→Nginx 没转发 Upgrade |
| 公网状态端点 | 不带 token 回 403；顺便用伪造的 `Host: 127.0.0.1` 再打一次，仍然必须是 403 |
| **设置接口的匿名拒绝** | `GET https://…/api/sync-remote.state` 必须回网关的 401，且 body 里**绝不能出现** `/auth?token=` |

期望：`PASS: N passed, 0 failed`。任何一条 FAIL 都会打印具体原因和修复方向。

### C 段 · 人工验收（必须你来做）

0. **设置页面**：在 GUI 里打开 **设置 → 远程访问**。
   期望：新的菜单项；10 个字段带"来自哪一层"的标注；「固定值（不可修改）」列出监听地址/状态文件/RP ID/VPS 监听/已固定主机密钥；注册区显示二维码与已注册设备；顶部显示网关/隧道/围栏状态。
   改一个值（例如会话有效期）→ 保存 → 页面提示已保存，状态自动刷新，`~/.dsh/profiles/web/cordis.patch.yml` 里多出该字段，而网关与隧道**重新绑定**（终端不会再刷一遍监听日志，只会再打印一次本机链接；绑定结果看设置页顶部状态）。
1. **注册 Passkey**：点「生成注册二维码」，用要注册的设备扫它。
   期望：弹出指纹/面容/PIN/安全密钥 → 完成后**自动进入 DSH**（网关会一次性重定向到带启动令牌的地址）。
   > **插件日志就在运行 `dsh` 的那个终端窗口里**：它**不**走 `ctx.logger`（该 logger 在 `dsh web` profile 里不落控制台，只有 `web-app` 自己 `console.log` 的 `dsh web:` 两行可见），所以本插件改用 `console` 打印。正常启动它只往那里加**一行** `dsh-sync-remote: http://127.0.0.1:3080/?token=…`；出错与一次性注册链接才会另外出现（见「四、启动 DSH」的控制台约定表）。
   > `C:\Users\<you>\.dsh\logs\startup-*.log` 是**启动失败**时的诊断快照，正常启动不写，别去那里找。
   > 没注册任何 Passkey 时，登录页会把这句话写在按钮下方并禁用按钮——**登录页不是注册页**，注册必须带一次性链接。
   > 链接用完就失效：再点一次生成新的。日志滚掉了就读 `enroll-url.txt`（只在该链接有效期间存在）。
2. **登录**：正常情况下第 1 步结束就已经进来了（见上）。若被 DSH 拒绝而看到它自己的登录页，打开 `dsh web` 打印的 `https://dsh.dsh.example.com/?token=…` 即可（这一步每台浏览器只需要一次）。
3. **实时同步**：电脑和手机同时打开 GUI，一边发一条消息。
   期望：另一边**实时**出现（走 `/api/remote.mux`）。这一步是"WebSocket 代理是否真的通"的唯一硬证据。
4. **Cookie 属性**：DevTools → Application → Cookies，确认 `dsh-gw-session` 是
   `HttpOnly`、`Secure`、`SameSite=Strict`。
5. **断开恢复**：把 VPS 网络断 1 分钟再恢复。
   期望：日志出现 `tunnel lost (…) reconnecting in … ms`（恢复后的 `… is listening on 127.0.0.1:3090 …` 属于例行 `info`，已不再上控制台；隧道状态看设置页）。
6. **错误凭据**：在设置页里把私钥路径改成错文件、或把 SSH 用户名写错，保存。
   期望：明确的认证失败信息（不是无限刷屏）；设置页顶部显示该原因。
7. **锁死保护**：在设置页里删到只剩 1 把 Passkey。
   期望：最后一个的删除按钮被禁用（Host 侧也会拒绝：`refusing to remove the last passkey`）。
8. **一次性链接**：生成二维码后，把同一个链接再打开一次（或注册完成后再查 `enroll-url.txt`）。
   期望：链接已失效（403）、文件已删除；点「重新生成」得到的新链接可用、且旧的立即失效。

### D 段 · VPS 侧确认

```sh
sudo ss -ltnp | grep 3090        # 期望：127.0.0.1:3090（sshd 监听，不是 0.0.0.0）
sudo nginx -t && sudo systemctl reload nginx
```

期望 `3090` 只绑回环；`0.0.0.0:3090` 说明 `GatewayPorts` 被打开了，需要关掉。

### 已实测（对着本机真实 DSH 3080 跑通，不是模拟）

| 请求 | 结果 | 证明了什么 |
| :--- | :--- | :--- |
| `GET /status?token=…` | `200` + JSON | 网关起来了；不带 token 一律 403 |
| `GET /signin` | `200` + `default-src 'none'` CSP | 登录页与脚本正常，策略生效（无旧路径别名：网关的路径都是根路径） |
| `GET /auth?token=…` | `200` + 签名 `dsh-gw-enroll` | 一次性注册链接可用（一次性链接就是 `/auth?token=…`，没有别名） |
| `GET /auth?token=…`（已用过/已过期） | `403` | 链接只能用一次、10 分钟有效 |
| `GET /`（未认证导航） | `303 → /signin` | 未认证请求在网关就被挡住，没到 3080 |
| `GET /api`（未认证） | `401 passkey authentication required` | 同上，且返回裸 401 而非 HTML |
| `GET /api`（带网关会话） | `401 "unauthorized"` | **这是 DSH 自己回的 401** → 请求确实穿过代理到了 3080 的围栏 |
| `GET /`（带网关会话） | `401 "dsh web authentication required…"` | Host 被原样保留（DSH 视作回环），DSH 自己的 Cookie 仍然生效 |
| `GET /api`（Host `evil.example`） | `403 "forbidden"` | **403 来自"Host 不受信"，不是"必须改写 Host"** —— 你原描述的反面 |

### 关于本机端口（实测记录）

最初部署时本机 `127.0.0.1:3090` 上另有一个 DSH Web 实例，与网关默认端口冲突；那次之后该实例已不在，网关现在直接占用 **3090**，`remote` 显示 `203.0.113.10:22 → 127.0.0.1:3090`，与 Nginx 的 `proxy_pass http://127.0.0.1:3090` 一致。

本地端口可以和 VPS 端口不同，但**不推荐**：设页里的「隧道端口」就是两端同一个端口（VPS 上监听、Nginx 反代、本机网关监听），改它要同时改 Nginx。若确实要错开，手改 profile 补丁里的 `port` 与 `tunnel.remotePort` 两个值。

端口被占时插件会明确报 `EADDRINUSE` 并给出这条建议，不会静默失败。

### 从环境变量迁移（这一版的变化）

插件现在**不读任何环境变量**。如果你之前用 `DSH_GW_*` / `VPS_*` 部署过：

1. 启动 DSH（本机 `http://127.0.0.1:3080` 照常可用，公网入口此时是关的）。
2. 打开「设置 → 远程访问」，把**公网地址、隧道端口、Web 端口、VPS 地址、SSH 用户、私钥路径**填上并保存。
3. 保存即生效（插件行会重启并重新绑端口）。此前设过的环境变量可以删掉了，留着也不影响任何东西——它们在页面里既不会显示，也不会被读取。

## 九、模块与文件

| 文件 | 职责 |
| :--- | :--- |
| [src/index.ts](src/index.ts) | 插件入口：装配、启动探测、日志、生命周期；`PluginContext` 声明 `effect` 与可选的 `inject`；一次性链接的文件生命周期 |
| [src/types.ts](src/types.ts) | 跨模块共享类型：`Logger`、`PasskeyRecord`、`PasskeySummary`、`StateDocument` |
| [src/config.ts](src/config.ts) | 设置表单的 `Config` schema（10 个字段）、`resolveConfig()`（不读环境变量、派生固定值）、`provenance()` |
| [src/state.ts](src/state.ts) | 状态文件：签名密钥、WebAuthn userID、Passkey、主机指纹；原子写 |
| [src/session-cookie.ts](src/session-cookie.ts) | HMAC 签名 Cookie 的签发/校验（`SignedPayload`、`CookieAttributes`） |
| [src/webauthn.ts](src/webauthn.ts) | 注册/登录 ceremony，challenge 一次性、5 分钟过期 |
| [src/gateway.ts](src/gateway.ts) | HTTP+WebSocket 反向代理、鉴权、一次性注册令牌（mint/消费/TTL）、DSH 自动登录重定向、限流、预检 |
| [src/tunnel.ts](src/tunnel.ts) | `ssh2` 反向隧道、保活、指数退避+抖动、主机密钥 TOFU 校验（`TunnelState`） |
| [src/pages.ts](src/pages.ts) | 登录/注册页面的 HTML/CSP，并读取构建产物 `lib/app.js` 作为页面脚本 |
| [src/app.ts](src/app.ts) | 登录页脚本本体（真 TS，零 import）：WebAuthn 选项/响应转换与两条仪式流程 |
| [src/status.ts](src/status.ts) | 设置页的数据形状：`buildStatus()` 纯函数，装配有效值、来源、固定值、设备与运行状态（**不含任何令牌**） |
| [src/routes.ts](src/routes.ts) | 四个 `/api/sync-remote.*` 路由（state / enroll.mint / passkey.remove / trust.forget）：JSON、`no-store`、错误映射 |
| [src/qr.ts](src/qr.ts) | 二维码渲染（`qrcode-generator`，Byte 模式）→ SVG data URL |
| [src/client.ts](src/client.ts) | 设置页本体（真 TS，构建为 `lib/client.js`）：字段表单、固定值列表、生成二维码、设备管理、状态面板 |
| [tsconfig.json](tsconfig.json) | `strict` + `noEmit` + `allowImportingTsExtensions` + `erasableSyntaxOnly` + `checkJs` |
| [test/selfcheck.mts](test/selfcheck.mts) | 自测（数量以输出为准），含真实 socket、WebSocket 往返、`apply()` 入口、控制台输出（正常启动只有一行、令牌跟随运行时值）、栅栏探测等到 Loader 装载完成、一次性链接生成/替换/退役、自动登录重定向 |
| [test/client.spec.mts](test/client.spec.mts) | 客户端半边冒烟测试：桩掉 `__ModuleLoader__`/React，真实渲染设置页并断言 i18n 键集相等、字段路径存在于 Host、选「自动」产生 unset、状态轮询存在且卸载时清理 |
| [test/acceptance.mts](test/acceptance.mts) | 部署验收：从状态文件 + `/status` 自行发现部署，检查围栏、公网 HTTPS/WebSocket 与设置接口的匿名拒绝 |

## 十、已知取舍

- 依赖 `@simplewebauthn/server` 会在导入时打印两条 Node 实验性特性警告（Web Crypto PQC 探测），与功能无关。
- `userVerification` 固定为 `required`（要求指纹/面容/PIN），没有降级开关：这是该网关唯一的身份判据。
- 隧道只支持一台 VPS、一条端口映射；多目标请再挂一个插件行（id 不同即可）。
- 不处理 Nginx 挂载前缀（`Location /ui/`）：DSH 的 Cookie 作用域与前缀改写需要额外配置，本插件按 origin 根路径设计。
- `@deepseek-ai/schemastery` 与 `@deepseek-ai/cosmokit` 按**宿主 vendored 的同版本**（`3.18.5-alpha.1` / `1.8.6-alpha.1`）钉住：设置页靠 `schema.toJSON()` 的信封与宿主通信，版本漂移没有意义。它们从 npm 公开包安装，是这份 bundle 唯一两个 `@deepseek-ai/*` 依赖。
- 设置页**不能**替你改 DSH 自己的两个命令行开关（`--trusted-host` / `--public-url`）：那是 `dsh web` 进程的启动参数，不属于本插件的行。页面只做预检并告诉你该加什么。
- 注册链接是**一次性**的：丢掉或过期就要重新生成。没有"固定注册令牌"这个选项了 —— 一个长期有效的注册凭据不值得留在磁盘上。
- 自动登录重定向会把 DSH 的启动令牌放进一次 303 的 `Location`（随后 DSH 立即换成自己的 Cookie）。它是控制台本来就打印的那个凭据；若你不想让它出现在浏览器历史里，可以关掉这一行为（[src/index.ts](src/index.ts) 里不传 `dshEntry`），代价是新设备注册后要手动打开一次 `dsh web` 打印的 `?token=` 链接。
- 控制台是**启动界面**，不是日志文件：正常启动插件只补一行本机链接（`dsh-sync-remote: http://127.0.0.1:<Web 端口>/?token=…`），其余只打需要人处理的事——配置被拒绝、隧道/上游失败、一次性注册链接。例行细节（配置、端口、隧道与登录事件）在设置页；想要全量日志，把 [src/index.ts](src/index.ts) 里 `loggerFor()` 的 `info: () => {}` 改回 `console.log`。


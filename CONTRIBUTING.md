# 开发与内部说明

面向要改这个插件、或要深挖技术细节的人。**安装与使用请看 [README](README.md)**。

---

## 一、开发环境

```powershell
pnpm install          # 或 npm install
npm run build         # 构建浏览器半边 → lib/app.js、lib/client.js
npm run check         # 两次类型检查，必须都是 0 报错
npm test              # 先 build，再跑两套测试
```

开发期也可以不装 bundle，直接覆盖挂载（`cordis.yml` 里的插件名**相对该文件**解析，用本目录的绝对路径即可）：

```powershell
dsh --profile web --patch <本仓库目录>\cordis.yml
```

### 为什么是 TypeScript，以及哪一半需要构建

**宿主半边**（`gateway.ts`、`tunnel.ts`、`index.ts`…）是 `.ts`，由 Node 26 的**类型擦除**直接执行——`package.json` 的 `exports` 就指向 `./src/index.ts`，这一半没有产物，改完即生效。代价与约束：

| 约束 | 原因 / 对策 |
| :--- | :--- |
| 相对导入必须写 `.ts` 扩展名（`from './config.ts'`） | 擦除模式**不会**把 `./x.js` 回退成 `x.ts`（实测报 `ERR_MODULE_NOT_FOUND`）。`tsconfig` 用 `allowImportingTsExtensions` + `noEmit` 让 `tsc` 接受这种写法。 |
| 不能写 `enum` / `namespace` / 构造函数参数属性 | Node 的 strip-only 模式直接抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。`tsconfig` 开了 `erasableSyntaxOnly`，让 `tsc` 在编辑期就拦住这三种写法。 |
| 类型检查要自己跑 | 擦除不检查类型：不跑 `npm run check`，TS 就只是装饰。 |

**浏览器半边**（`src/client.ts` 设置页、`src/app.ts` 登录页脚本）必须**构建**：浏览器不做类型擦除，DSH 只把 `exports["./client"]` 指到的文件原样交给页面。

```powershell
npm run build          # 先清空 lib/ 再 tsc -p tsconfig.build.json（有类型错误就不写产物）
                       # 清空是必要的：outDir 有陈旧文件时，增量发射可能留下与源码不符的产物
npm run build:watch    # 开发时挂在旁边
```

三份 `tsconfig` 各司其职：

| 配置 | 职责 |
| :--- | :--- |
| `tsconfig.json` | 宿主类型检查。**故意没有 DOM lib**——免得有人在 `gateway.ts` 里顺手写 `document` |
| `tsconfig.client.json` | 浏览器半边 **+ 客户端测试**的类型检查（`noEmit`，含 `dom` 与 `node`），所以 `strict` 覆盖测试代码本身 |
| `tsconfig.build.json` | **只负责 emit**：`rootDir: src` → `lib/`，`types: []`，`noEmitOnError`——类型不过就不写产物，避免半坏的 bundle |

| 事实 | 说明 |
| :--- | :--- |
| 产物不入库 | `lib/` 在 `.gitignore` 里：克隆后先 `npm ci && npm run build` 再启动 dsh。缺产物时 [src/pages.ts](src/pages.ts) **加载即报错并告诉你跑哪条命令**（不是浏览器白页）。 |
| 改了客户端源码要重新 build | 然后刷新页面；若页面仍是旧 bundle，重启 `dsh`（该 bundle 由 DSH 在插件激活时读取）。 |
| `client.ts` 里只允许类型导入 | 值导入会让产物带上 `./xxx.ts` 这种浏览器解析不了的说明符；`test/selfcheck.mts` 有一条断言盯着产物里不许出现相对导入。 |
| **客户端半边是「经典脚本」，不是 ES 模块** | DSH 用 `document.createElement('script')`（无 `type="module"`）加载客户端 bundle，它自己的 bundle 也是 CJS——所以 `src/client.ts` **绝不能**出现顶层 `export`/`import`（加 `export {}` 是最顺手的"变成模块"写法，但那会让产物带着 `export` 进浏览器，设置页直接白屏 `Unexpected token 'export'`）。登录页脚本 `src/app.ts` 相反：它以 `<script type="module">` 提供，因此可以有 `export {}`（顶层 `await` 需要它）。两条各有断言。 |
| DSH 专有全局就地声明 | 模块表 `__ModuleLoader__` 与 `styles` 声明在 [src/client.ts](src/client.ts) 顶部：它是脚本，脚本的顶层声明本来就是全局的——不需要单独的 `.d.ts`，也不需要重定义 `window`/`document`。 |

`tsconfig.json` 的关键项：`strict: true`、`noEmit: true`、`allowImportingTsExtensions: true`、`erasableSyntaxOnly: true`、`module/moduleResolution: nodenext`、`noUnusedLocals/Parameters: true`。共享类型在 [src/types.ts](src/types.ts)（`Logger`、`PasskeyRecord`、`StateDocument`），配置/隧道类型在 [src/config.ts](src/config.ts)。

---

## 二、模块与文件

| 文件 | 职责 |
| :--- | :--- |
| [src/index.ts](src/index.ts) | 插件入口：装配、启动探测、日志、生命周期；`PluginContext` 声明 `effect` 与可选的 `inject`；一次性链接的文件生命周期 |
| [src/types.ts](src/types.ts) | 跨模块共享类型：`Logger`、`PasskeyRecord`、`PasskeySummary`、`StateDocument` |
| [src/config.ts](src/config.ts) | 设置表单的 `Config` schema（11 个字段）、`resolveConfig()`（不读环境变量、派生固定值）、`provenance()` |
| [src/state.ts](src/state.ts) | 状态文件：签名密钥、只读状态令牌、WebAuthn userID、Passkey、主机指纹；原子写（含 Windows 上被并发读取时的重命名重试） |
| [src/session-cookie.ts](src/session-cookie.ts) | HMAC 签名 Cookie 的签发/校验；四种 Cookie 名与受众词汇（`session` / `next` / `enrollment`）都声明在这里 |
| [src/webauthn.ts](src/webauthn.ts) | 注册/登录 ceremony，challenge 一次性、5 分钟过期 |
| [src/gateway.ts](src/gateway.ts) | HTTP+WebSocket 反向代理、鉴权、一次性注册令牌（mint/消费/TTL）、DSH 自动登录重定向、限流、预检 |
| [src/tunnel.ts](src/tunnel.ts) | `ssh2` 反向隧道、保活、指数退避+抖动、失败分类（`TunnelFailureKind`）与升级/节流、主机密钥 TOFU 校验（`TunnelState`）、`stop/start` 的 generation 计数、可选的在 VPS 上释放被占端口 |
| [src/remote-release.ts](src/remote-release.ts) | 唯一会在 VPS 上动手的能力：固定命令、严格解析 `ss -ltnpH` 输出、只在证明占用者是 sshd 时给出 `kill`（无 SSH 客户端，纯决策，因此可离线测试） |
| [src/pages.ts](src/pages.ts) | 登录/注册页面的 HTML/CSP，并读取构建产物 `lib/app.js` 作为页面脚本 |
| [src/app.ts](src/app.ts) | 登录页脚本本体（真 TS，零 import）：WebAuthn 选项/响应转换与两条仪式流程 |
| [src/status.ts](src/status.ts) | 设置页的数据形状：`buildStatus()` 纯函数，装配有效值、来源、固定值、设备与运行状态（**不含任何令牌**） |
| [src/routes.ts](src/routes.ts) | 六个 `/api/sync-remote.*` 路由（state / enroll.mint / passkey.remove / trust.forget / tunnel.retry / tunnel.release）：JSON、`no-store`、错误映射 |
| [src/qr.ts](src/qr.ts) | 二维码渲染（`qrcode-generator`，Byte 模式）→ SVG data URL |
| [src/client.ts](src/client.ts) | 设置页本体（真 TS，构建为 `lib/client.js`）：字段表单、固定值列表、生成二维码、设备管理、状态面板 |
| [test/selfcheck.mts](test/selfcheck.mts) | 自测（数量以输出为准）：配置派生、Cookie 签名、状态文件、代理头、真实 WebSocket 往返、隧道退避与主机密钥、`apply()` 入口、控制台输出、探测时机、一次性链接生命周期、自动登录重定向、产物与路径护栏 |
| [test/client.spec.mts](test/client.spec.mts) | 客户端半边冒烟测试：桩掉 `__ModuleLoader__`/React，真实渲染设置页并断言 i18n 键集相等、字段路径存在于 Host、选「自动」产生 unset、状态轮询存在且卸载时清理 |
| [test/acceptance.mts](test/acceptance.mts) | 部署验收：从状态文件 + `/status` 自行发现部署，检查围栏、公网 HTTPS/WebSocket 与设置接口的匿名拒绝 |

---

## 三、网关路由（精确匹配）

网关自己应答这些**根路径**，其余全部转发给 DSH GUI：

```
/auth                一次性注册链接（?token=…）与注册页
/auth/options  /auth/verify                登录仪式
/enroll  /enroll/options  /enroll/verify   注册仪式
/signin              登录页                /app.js   登录页脚本
/bootstrap           登录页能力探测         /logout   退出（POST）
/status              只读状态（需 statusToken）
/passkeys/remove     删除设备（POST）
```

路径是**精确匹配**：`/auth/extra`、`/statuses` 这类邻近路径会照常转发给 GUI。`test/selfcheck.mts` 有一条检查盯着"登录页脚本请求的每个 URL 都必须在这个集合里"，以及"网关路径集合与 Host 路由表必须逐一对齐"。

---

## 四、配置参考（手改 YAML 时用）

> 日常改配置请用设置页；下面这份 YAML 是等价的另一种写法。**插件不读任何环境变量**：配置只有两个来源——插件行自己的 `config`（设置页写进 profile 补丁的那一层）与内置默认值。

### 可编辑字段（10 个）

| 字段 | 含义 | 默认 |
| :--- | :--- | :--- |
| `publicOrigin` | 浏览器访问的公网 origin | **无（必填）** |
| `serverPort` | **服务端端口（映射端口）**：VPS 上 `sshd` 以 `127.0.0.1:<这个端口>` 监听转发，Nginx 反代到这里（本机网关也用同一端口，所以 `ssh -R` 两端一致） | **无（必填）**：必须与 Nginx 的 `proxy_pass` 一致，猜错时隧道看着正常而公网 502 |
| `clientPort` | **客户端端口**：本机 `dsh web` 的端口（始终按 `127.0.0.1` 连接） | **无（必填）**：占位符建议 `3080`，但你写什么就是什么 |
| `sessionTtlHours` | 网关会话有效期（小时） | **无（必填）**：占位符建议 `720`（30 天） |
| `tunnel.enabled` | 是否开隧道。**唯一例外**：它不是"要你填的值"，而是对下面三项的开关，所以不写也按"三项齐备=开"推导（界面里明写"自动"） | 由 host/user/key 推导 |
| `tunnel.host` | VPS 地址（SSH 目标）。**设置页默认遮蔽显示**（像密码框），右侧眼睛图标可切换显隐；仓库里不含任何真实地址，占位符是文档用 IP | **无（必填）** |
| `tunnel.port` | **VPS 的 SSH 端口**（你的 `ssh` 命令里省略的 `-p`，不是穿透监听端口） | **无（必填）**：占位符建议 `22` |
| `tunnel.user` | SSH 用户 | **无（必填）** |
| `tunnel.privateKeyFile` | 私钥**绝对路径** | **无（必填）** |
| `tunnel.passphrase` | 私钥口令（`role('secret')`，永不下发到浏览器） | 无（口令可能真的不存在，"未设置"是一个真实取值，不是默认值） |

**规则：凡是设置页里有输入框的，配置里就必须有，且代码里不许有默认值。** 只有 `tunnel.enabled` 是刻意的例外（开关，状态由必填的三项推导）；除它以外，缺任何一项都会被明确拒绝并点名该字段，例如 `dsh-sync-remote: serverPort is required — …`。`test/selfcheck.mts` 里有一条 `every value with a box in the settings form is required` 逐字段验证这条规则，防止以后有人再加回隐藏默认值。

### 字段 ↔ `ssh` 命令对照

插件做的等价事情就是一条 `ssh -R`：

```
ssh [-i <tunnel.privateKeyFile>] -p <tunnel.port> -N -R <serverPort>:127.0.0.1:<serverPort> <tunnel.user>@<tunnel.host>
```

（注意 `-R` 的右边是**本机网关**的端口 = `serverPort`，不是 `clientPort`；网关再把请求转给 `clientPort` 上的 `dsh web`。）

| 命令里的部分 | 含义 | 插件字段 |
| :--- | :--- | :--- |
| `-p <n>` | **VPS 的 SSH 端口**（省略即 22） | `tunnel.port` |
| `-R <p>` | VPS 上监听哪个端口（映射端口，VPS 侧 `127.0.0.1:<p>`） | `serverPort` |
| `-R …:127.0.0.1:` | VPS 侧绑回环 | 固定 `127.0.0.1` |
| `-R …:<p>` | 转发到本机哪个端口（本网关） | 由 `serverPort` 派生（两端一致） |
| `-i <file>` | 私钥 | `tunnel.privateKeyFile` |
| `user@host` | SSH 目标 | `tunnel.user` / `tunnel.host` |
| （不出现在命令里） | 本机 `dsh web` 的端口，由网关转给它 | `clientPort` |

**设置页面直接显示这一行**（「固定值（不可修改）」里的「等价命令」），控制台启动时也会打印一次。最常见的填错就是把 `-p` 的位置也填成隧道端口，页面会显示成 `ssh … -p 3090 -N -R 3090:127.0.0.1:3090 …`——一眼就能看出 `-p` 该是 22。

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
          port: 22
          user: root
          privateKeyFile: C:\Users\me\.ssh\id_ed25519
```

> **私钥格式**：ssh2 只认 OpenSSH 默认格式、PKCS#1（`BEGIN RSA PRIVATE KEY`）、SEC1（`BEGIN EC PRIVATE KEY`）和 PuTTY PPK。**PKCS#8（`BEGIN PRIVATE KEY`，openssl 默认产物）会被拒绝**，插件会给出一条明确报错。用 `ssh-keygen -t ed25519 -f <file>` 重新生成即可。

> **未配置 = 功能关闭，配置错误 = 大声失败但行保持激活。**
> 没填 `publicOrigin` 时插件只打一行 "no public origin configured yet" 然后什么都不做；填了但值不合法（origin 不是 URL、端口越界、隧道三项缺一等）时，插件打一条 `error` 说明原因、**网关保持关闭**，而**插件行仍然激活**——这是刻意的：设置页面是修配置的地方，行一旦失败就会从设置服务里消失，连修复界面都没了。

---

## 五、启动、控制台与探测

### 控制台约定（正常启动只多一行）

插件不用 `ctx.logger`（那个 logger 在 `dsh web` profile 里不落控制台），而是直接写 `console`。

| 会打印 | 不打印（走设置页） |
| :--- | :--- |
| 一行本机链接 `dsh-sync-remote: http://127.0.0.1:3080/?token=…` | 解析后的配置、状态文件、端口 |
| 配置被拒绝的 `error` | 网关已监听、预检通过 |
| 隧道/上游的失败与异常（认证失败、主机密钥首次固定、断开重连、上游无响应、围栏 403/非 401 应答） | 登录成功、注册成功、隧道事件流 |
| 一次性注册链接（含首台设备的自动生成） | 隧道关闭、隧道端口转发正常 |

那行本机链接端口取 `clientPort`，令牌在**打印那一刻**向 Host 取（`authenticatedUrl()`），所以新起的进程、重载后的行都跟着最新的令牌走，不是写死的字符串。它和 `dsh web:` 那行是同一个进程凭据，**敏感度相同**。

想恢复全量日志：把 [src/index.ts](src/index.ts) 里 `loggerFor()` 的 `info: () => {}` 改回 `console.log`。

### 启动时的围栏探测

| 探测结果 | 含义 |
| :--- | :--- |
| `401` | Host 已被受信列表接受 ✅（属例行 `info`，不上控制台） |
| `403` | 少了 `--trusted-host`：插件打印修复命令，并**拒绝打开隧道**（见下） |
| 无响应 | DSH 本体没起来（同样不开隧道） |

> 这次探测**等 Loader 装载完成之后**才发（插件向 Host 要 `loader.await()`，和 `web-app` 打印 `dsh web:` 用的是同一个时机）。否则 `/api` 的路由还没挂上，探测会拿到 404 并误报一条 "expected 401"——那描述的是启动瞬间，不是你的部署。

**探测结果是网关与隧道共同的前置条件，不只是诊断。** 围栏回 `401` 之后才按顺序做两件事：`gateway.listen()` → `TunnelManager.start()`。围栏拒绝时**两件都不做**：不发出任何 `forwardIn`（VPS 上没有监听、没有登录页），**本机也不绑定网关端口**——这个 listener 存在的唯一目的就是把隧道的连接交给 GUI，没有隧道就没有要服务的东西；它唯一的另一个"顾客"是本机浏览器，而报告这次拒绝的设置页由 **DSH 自己**在 3080 上提供，从不经过这个 listener。少一个 listener 就少一样要解释、少一样能被找到的东西。

由此还带来两个连带约定：

- **首次运行的注册链接只在有公网入口时才生成**：`announceEnrollment()` 位于 gate 的"接受"分支里，围栏拒绝时不会 mint（那会是一把通向墙的门钥匙，而且 10 分钟后就自己过期）。`mintEnrollment` 路由在 listener 未绑定时也会拒绝并说明原因。
- 设置页的「网关」一行读的是**监听事实**（`gatewayListening`），不是"网关对象存在"，所以 blocked 时它如实显示「未启动」。

- **只重试"不确定"的答复**（无响应 / 404 / 5xx）：最多 3 次、间隔 500 ms（`FENCE_CONFIRM_ATTEMPTS` / `FENCE_CONFIRM_DELAY_MS`）。`403` 和 `401` 都是围栏自己的答案，第一次探测就定案。
- **不确定的答复也按"不暴露"处理**（fail closed），并给出与 403 不同的原因文案。
- **不做常驻轮询**：`--trusted-host` 是 `dsh web` 的启动参数（`ctx.webStartup.trustedHosts`），进程存活期间不可能改变。因此不存在需要轮询的对象——进程重启、插件行重载（设置页保存即触发）、以及「重新信任」这三条路径都会重跑这次判定。
- 状态用隧道的 `blocked` 表示（不是 `configError`：fence 不过不是本插件的配置错误），设置页对它显示专用横幅，**不会**显示那句讲 ssh2 原始错误的提示。
- 只有两个地方能启动隧道：`startTunnel` 里 `tunnel.enabled: false` 的分支（没东西可 gate），和 gate 自己。selfcheck 有一条源码守卫盯着这个数字。
- **围栏问的是"公网地址那个 authority"**，所以 `--trusted-host` 写成别的域名、或多写了端口，同样是 `blocked`——这正是要的行为。启动参数可读时（`ctx.get('webStartup')`，可选服务）403 文案会列出 DSH 实际信任的列表；`--public-url` 与插件「公网地址」不一致只警告（它是广告，不是信任）。

### SSH 失败分类与重试策略

每一次连接失败都会先被**分类**（`TunnelFailureKind`，[src/tunnel.ts](src/tunnel.ts)），因为"未连接"本身不是可行动的信息。分类决定三件事：要不要重试、页面说什么、退避多快。

| kind | 来源 | 自动重试 | 页面/控制台 |
| :--- | :--- | :--- | :--- |
| `key` | 私钥读不到，或 ssh2 解析不了（PKCS#8） | **否**（终态：改配置或行重载才恢复） | 指出文件路径与支持的格式 |
| `auth` | ssh2 `client-authentication` / `agent` | **否** | 指向 SSH 用户 / 私钥 / 口令 |
| `host-key` | 已固定指纹与服务器不符 | **否**，直到「重新信任」 | 指向设置页的「重新信任」 |
| `dns` | `client-dns` / `ENOTFOUND` | 是 | 指向 `tunnel.host` |
| `unreachable` | `client-socket`（ECONNREFUSED 等） | 是 | 指向地址 / SSH 端口 / VPS 状态 |
| `handshake-timeout` | `client-timeout`（`readyTimeoutMs`=20 s） | 是 | 同上 + 端口是否被墙 |
| `forward-refused` | `forwardIn` 回调失败（VPS 端口被占） | 是（**不**升级） | 给出 `ss -ltnp` 与 `ClientAliveInterval` |
| `dropped` | ready 之后连接消失、无 ssh2 错误 | 是（**不**升级） | 说明会自动重连、期间 502 |
| `unknown` | 其他 level | 是 | 保留 ssh2 原文 |

三条机制：

- **升级**：`attempts ≥ 5` 且**从未成功过**（`everListening === false`）⇒ 快照 `suspected='configuration'`，退避上限从 `reconnectMaxDelayMs`（60 s）换成 `suspectedReconnectMaxDelayMs`（5 min）。只影响"从没成功过"的部署：刚工作过的隧道断线仍按 1 分钟档重连（那是 VPS 重启，不是配置错）。`suspected` 是**派生**字段，`start()` 清零 attempts 后自然消失。
- **节流**：失败日志首次完整打印，之后仅在**类别变化**或**每 10 次**（`LOG_EVERY_ATTEMPTS`）打一行——控制台是"需要人处理"的信道，不是日志文件；实时状态在设置页（10 s 轮询）。
- **手动**：`POST /api/sync-remote.tunnel.retry`（页面「立即重试」）走 `tunnel.stop()` + `startTunnel()`，**和启动完全同一条路**，因此仍过围栏 gate，不可能是绕过 `blocked` 的后门。

### 主动释放 VPS 上被占的隧道端口

`forward-refused` 的病因在 VPS：上一次会话的 sshd 还持有 `127.0.0.1:<serverPort>`。**协议层解决不了**——ssh2 的 `unforwardIn`（= `cancel-tcpip-forward`）只能取消本连接自己请求的转发，对外来会话服务器会拒绝；新连接只能"请求→被拒→重试"。能释放它的只有结束那个进程。

因此提供一个**默认关闭**的选项 `tunnel.releaseStaleForward`（页面「释放 VPS 端口」）：

- 开启后，连续 3 次 `forward-refused`（`AUTO_RELEASE_AFTER_REFUSALS`）自动执行一次；`forward-refused` 横幅里也有按钮可立即执行。
- 全部逻辑在 [src/remote-release.ts](src/remote-release.ts)：命令是**固定文本**，只插入一个已校验的整数端口；探测用 `ss -ltnpH 'sport = :<port>'`，**必须**同时满足"本地地址恰为 `127.0.0.1:<port>`"且"进程名是 sshd"才 `kill <pid>`（SIGTERM），随后重新探测确认释放。占用者是别的进程、pid 不可见（非 root 隧道用户）、或 VPS 没有 `ss` ⇒ **只报告，不动手**。`fuser` 只是无 `ss` 时的**报告**回退（它给不出进程名，永远不能授权 kill）。
- 页面只在 `kind === 'forward-refused'` 且该开关为真时才显示按钮；Host 侧还会再校验一次开关（不信任 UI）。
- 非目标：不自动重启 VPS（杀掉所有 SSH 会话、站点停机，而且不治本）；不自动换远程端口（Nginx 的 `proxy_pass` 钉死了端口）。
- 根治仍是 VPS 侧 `sshd_config` 加 `ClientAliveInterval 30` / `ClientAliveCountMax 3` 后 `systemctl reload ssh`：半开会话 ~90 s 内被回收，端口自然释放。

---

## 六、安全边界（完整版）

- **Passkey 网关是唯一对外的门**。任何未通过校验的请求都不会到达 3080；异常一律 500/拒绝，不泄露上游。
- **代理层原样透传 `Host`、`Origin`、`Referer`、`Sec-Fetch-*`**，只丢弃逐跳头（`connection`、`transfer-encoding` 等）。改写 `Host` 反而会**破坏 DSH 自己的登录态**：它的会话 Cookie 名字由 Host 派生（`browser-auth.ts` 的 `requestAudience`/`cookieName`），改 Host 后 Cookie 名对不上，页面永远 401；而 `Origin` 一旦被剥掉，DSH 的跨站检查也就失效了。DSH 的浏览器信任围栏（`packages/client/connection/src/api-request-trust.ts`）接受三类 `Host`：回环、监听地址本身、以及配置里的 `trustedHosts`——请求返回 **403 不是"必须改写 Host"的信号，而是"这个 Host 不在受信列表里"的信号**。
- 实时通道是 `/api/remote.mux`（`packages/api/gateway/src/stream-protocol.ts`）的 WebSocket；`packages/client/hmr` 的 `/plugins/events` 是 SSE。两者都支持（升级请求按字节透传，SSE 不禁缓冲）。
- 登录态是 `HttpOnly + Secure + SameSite=Strict` 的 HMAC 签名 Cookie，服务端还会校验签发/过期时间；`Secure` 由**公网 origin**决定（不是本机 http 监听），所以隧道/反代下也正确。
- **受众绑定**：同一个密钥签三种能力（`session` / `next` / `enrollment`），每次读取都必须核对用途——否则任何人用一次匿名请求就能拿到的 `next` cookie 会满足会话查询，改个 cookie 名就绕过了 Passkey 门。`PAYLOAD_VERSION` 变更会让旧 Cookie 全部失效。
- 登录页与注册页带严格 CSP（`default-src 'none'`），注册令牌用常量时间比较，注册/登录接口按来源地址限流（5 分钟 30 次）。
- **`/status` 的闸门是状态文件里的独立只读令牌 `statusToken`，不是 Host，也不是签名密钥**。推荐用请求头 `x-dsh-gw-status` 传递——它不会进 Nginx 的 `$request` 访问日志；`?token=` 仍作为兼容别名可用。令牌只能读取状态，**无法伪造任何 cookie**；此前把签名密钥放进查询串的做法会把"签发会话的能力"泄漏到访问日志里。
  ```powershell
  curl.exe -sS -H "x-dsh-gw-status: $(Get-Content "$env:USERPROFILE\.dsh\dsh-sync-remote\state.json" | ConvertFrom-Json | Select-Object -ExpandProperty statusToken)" "http://127.0.0.1:3090/status"
  ```
- 未注册时插件启动会自动生成一条一次性注册链接，除日志外还会写一份到 `<stateFile 同目录>\enroll-url.txt`（0600）；**链接被使用、被替换或进程退出时，该文件立即删除**。
- 注册链接是**一次性**的：令牌只存在网关进程内存里，状态文件没有任何注册凭据，重启即失效。授权登记表让已发出的 grant 在令牌退役时同步作废（10 分钟链接不会变成 25 分钟窗口）。
- 隧道主机密钥首次连接 TOFU 并写入状态文件；想重新信任就让页面清掉它（或删掉状态文件里的 `sshHostKey`）。**不匹配必须拒绝**，绝不静默重钉。
- 状态文件损坏/版本不符会让插件**加载失败**而不是清空凭据——否则下一次注册就会变成对陌生人开放。

---

## 七、验收步骤

分四段。A、B 两段是命令；C、D 段必须人来做（需要认证器和手机）。

### A 段 · 代码自检（不依赖任何环境，随时可跑）

```powershell
node test/selfcheck.mts
node test/client.spec.mts
```

期望：最后一行为 `N/N checks passed`（N 随版本增长），退出码 0。这一段证明的是**代码本身**：签名 Cookie、配置解析与来源标注（含"环境变量完全不影响结果"）、状态文件、代理头改写、经代理的真实 WebSocket 101 往返、隧道退避与主机密钥、设置页的 Config schema / 状态载荷 / 路由拒绝路径、一次性注册链接的生成-替换-退役、DSH 自动登录重定向（含防循环）、`apply()` 入口、拒绝配置时不卸载、销毁，以及产物与路径护栏。

### B 段 · 部署验收（一条命令，对着真在跑的服务）

脚本**不需要任何环境变量**：它从状态文件取只读令牌，再问运行中的网关要事实（公网 origin、本机 Web 地址、隧道状态）。

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
| 状态文件的内容 | 文件存在、有 `secret`、`statusToken` 与 `passkeys` |
| **DSH 信任围栏是否接受公网 Host** | `Host: <公网 authority>` 请求 `/api` 回 **401**；回 403 就直接告诉你该加 `--trusted-host` |
| 围栏是否仍拒绝陌生 Host | `Host: fence-probe.invalid` 回 403 |
| 网关自身端点是否挡住未认证请求 | `POST /enroll/options`（无授权）回 403；登录页带 CSP |
| **一次性链接规则** | 不带令牌的 `/auth`（无 grant、无会话）回 403 |
| ceremony 端点是否匹配当前注册状态 | 未注册时 `POST /auth/options` 回 400 `no passkey is registered`；已注册时回 200 |
| 状态端点是否只认只读令牌 | 不带 token 访问 `/status` 回 403（**Host 怎么写都一样**）；签名密钥也必须 403；带该请求头回 200 |
| 公网登录页 | `GET https://…/signin` 回 200、带 CSP、引用 `/app.js` |
| 公网未认证导航 | `GET https://…/` 回 303 → `/signin` |
| 公网 `/api` 未认证 | 回 401 且 body 含 `passkey authentication required`（说明没被转发到 DSH） |
| **经公网的真实 WebSocket 升级** | 未带会话时回 `HTTP/1.1 401`；若超时→Nginx 没转发 Upgrade |
| 公网状态端点 | 不带 token 回 403；顺便用伪造的 `Host: 127.0.0.1` 再打一次，仍然必须是 403 |
| **设置接口的匿名拒绝** | `GET https://…/api/sync-remote.state` 必须回网关的 401，且 body 里**绝不能出现** `/auth?token=` |

期望：`PASS: N passed, 0 failed`。任何一条 FAIL 都会打印具体原因和修复方向。

### C 段 · 人工验收（必须人来做）

0. **设置页面**：GUI 里打开 **设置 → 远程访问**。
   期望：新的菜单项；11 个字段带"来自哪一层"的标注；「固定值（不可修改）」列出监听地址/状态文件/RP ID/VPS 监听/已固定主机密钥；注册区显示二维码与已注册设备；顶部显示网关/隧道/围栏状态。
   改一个值（例如会话有效期）→ 保存 → 页面提示已保存，状态自动刷新，`~/.dsh/profiles/web/cordis.patch.yml` 里多出该字段，而网关与隧道**重新绑定**（终端不会再刷一遍监听日志，只会再打印一次本机链接；绑定结果看设置页顶部状态）。
1. **注册 Passkey**：点「生成注册二维码」，用要注册的设备扫它。
   期望：弹出指纹/面容/PIN/安全密钥 → 完成后**自动进入 DSH**。
   > 插件日志就在运行 `dsh` 的那个终端窗口里。`C:\Users\<you>\.dsh\logs\startup-*.log` 是**启动失败**时的诊断快照，正常启动不写，别去那里找。
   > 没注册任何 Passkey 时，登录页会把这句话写在按钮下方并禁用按钮——**登录页不是注册页**，注册必须带一次性链接。
2. **登录**：正常情况下第 1 步结束就已经进来了。若被 DSH 拒绝而看到它自己的登录页，打开 `dsh web` 打印的 `https://dsh.example.com/?token=…` 即可（每台浏览器只需要一次）。
3. **实时同步**：电脑和手机同时打开 GUI，一边发一条消息。期望另一边**实时**出现（走 `/api/remote.mux`）。这是"WebSocket 代理是否真的通"的唯一硬证据。
4. **Cookie 属性**：DevTools → Application → Cookies，确认 `dsh-gw-session` 是 `HttpOnly`、`Secure`、`SameSite=Strict`。
5. **断开恢复**：把 VPS 网络断 1 分钟再恢复。期望日志出现 `tunnel lost (…) reconnecting in … ms`，随后自动恢复。
6. **错误凭据**：把私钥路径改成错文件、或把 SSH 用户名写错，保存。期望明确的认证失败信息（不是无限刷屏）。
7. **锁死保护**：删到只剩 1 把 Passkey。期望最后一个的删除按钮被禁用（Host 侧也会拒绝：`refusing to remove the last passkey`）。
8. **一次性链接**：生成二维码后再打开同一个链接一次。期望链接已失效（403）、`enroll-url.txt` 已删除；点「重新生成」得到的新链接可用、旧的立即失效。
9. **不带 `--trusted-host` 重启（本插件最重要的安全性质，必须人来做）**：把启动命令里的 `--trusted-host` 去掉，重启 DSH。
   期望：控制台出现一行 `the reverse tunnel stays closed: … --trusted-host …`；设置页顶部**网关显示「未启动」、隧道显示 `blocked`**（红点）+ 专用红色横幅（**不是**那句讲 ssh2 的提示）；公网域名打不开。
   **关键两步**：① 在 VPS 上 `sudo ss -ltnp | grep 3090` 应当**无任何输出**（插件连 `forwardIn` 都没发）；② 本机 `Test-NetConnection 127.0.0.1 -Port 3090` 应当**失败**（网关 listener 也没绑）。两处都没有，就不存在"能登录但界面空白"的机会。
   把 `--trusted-host` 加回去重启，隧道应恢复 `listening`、公网恢复可用（自愈路径：进程重启 / 插件行重载 / 「重新信任」三者都会重跑判定）。
10. **设置页可编辑性**：在运行 DSH 的机器上用 `http://127.0.0.1:<clientPort>` 打开设置页 → 输入框可输入、「保存并应用」可用；再从公网域名打开同一页 → 只读 + 黄色说明横幅（**不报错、不是故障**）。这一步是 v1.1.0 修的那个"到处都不能编辑"（页面曾按一个 DSH 不存在的字段判断可写性）。
11. **失败分类不重试**：把「SSH 用户」改成一个不存在的名字并保存。期望：设置页顶部隧道显示 `failed (auth)`，横幅给出"SSH 认证被拒 / 检查用户、私钥、口令"，控制台**只多一行**，而且**不会**继续刷重连日志（终态）。改回正确值保存即恢复。
12. **配置错误的升级与节流**：把「VPS 的 SSH 端口」改成 `1`（或一个被防火墙丢弃的端口）并保存。期望：前 5 次快速重试（日志只在第 1 次、第 10 次…才打一行），随后页面出现「**疑似配置错误**」提示、状态行出现 `下次重试 <n>s`，VPS 不再每分钟被敲；点「立即重试」立即再拨一次。
13. **释放 VPS 上被占的端口（可选能力）**：在 VPS 上人为制造占用——从另一台机器 `ssh -N -R 127.0.0.1:3090:127.0.0.1:1 root@<VPS>` 后**强杀**其客户端进程（模拟僵死会话）。期望：本机日志出现 `VPS 拒绝监听 127.0.0.1:3090` 与 `ss -ltnp` 提示。开关关闭时：只报告、不动作；打开「释放 VPS 端口」并保存后：连续 3 次拒绝即自动执行（或点横幅里的按钮），日志打印**证据行与被杀掉的 PID**，随后隧道恢复 `listening`。同时确认：占用者不是 sshd 时（例如 `python -m http.server 3090` 那种场景）插件**只报告**。

### D 段 · VPS 侧确认

```sh
sudo ss -ltnp | grep 3090        # 期望：127.0.0.1:3090（sshd 监听，不是 0.0.0.0）
sudo nginx -t && sudo systemctl reload nginx
```

> 若本机 DSH 启动时**没带** `--trusted-host`，第一条命令应当**无输出**，而且本机网关端口也不该在监听（Windows 上 `Test-NetConnection 127.0.0.1 -Port 3090` 应失败）：插件刻意什么都不开，这是 C 段第 9 步的判据。

### 已实测（对着真实 DSH 3080 跑通，不是模拟）

| 请求 | 结果 | 证明了什么 |
| :--- | :--- | :--- |
| `GET /status`（只读令牌请求头） | `200` + JSON | 网关起来了；不带令牌、或带签名密钥一律 403 |
| `GET /signin` | `200` + `default-src 'none'` CSP | 登录页与脚本正常，策略生效 |
| `GET /auth?token=…` | `200` + 签名 `dsh-gw-enroll` | 一次性注册链接可用 |
| `GET /auth?token=…`（已用过/已过期） | `403` | 链接只能用一次、10 分钟有效 |
| `GET /`（未认证导航） | `303 → /signin` | 未认证请求在网关就被挡住，没到 3080 |
| `GET /api`（未认证） | `401 passkey authentication required` | 同上，且返回裸 401 而非 HTML |
| `GET /api`（带网关会话） | `401 "unauthorized"` | **这是 DSH 自己回的 401** → 请求确实穿过代理到了 3080 的围栏 |
| `GET /api`（Host `evil.example`） | `403 "forbidden"` | **403 来自"Host 不受信"，不是"必须改写 Host"** |

### 端口冲突

本地端口与 VPS 端口可以不同，但**不推荐**：设置页里的「服务端端口」就是两端同一个端口（VPS 上监听、Nginx 反代、本机网关监听），改它要同时改 Nginx。端口被占时插件会明确报 `EADDRINUSE` 并给出建议，不会静默失败。

---

## 八、从环境变量迁移（历史）

插件现在**不读任何环境变量**。如果你之前用 `DSH_GW_*` / `VPS_*` 部署过：

1. 启动 DSH（本机 `http://127.0.0.1:3080` 照常可用，公网入口此时是关的）。
2. 打开「设置 → 远程访问」，把**公网地址、服务端端口、客户端端口、VPS 地址、SSH 用户、私钥路径**填上并保存。
3. 保存即生效（插件行会重启并重新绑端口）。此前设过的环境变量可以删掉了，留着也不影响任何东西——它们在页面里既不会显示，也不会被读取。

---

## 九、已知取舍

- 依赖 `@simplewebauthn/server` 会在导入时打印两条 Node 实验性特性警告（Web Crypto PQC 探测），与功能无关。
- `userVerification` 固定为 `required`（要求指纹/面容/PIN），没有降级开关：这是该网关唯一的身份判据。
- 隧道只支持一台 VPS、一条端口映射；多目标请再挂一个插件行（id 不同即可）。
- 不处理 Nginx 挂载前缀（`Location /ui/`）：DSH 的 Cookie 作用域与前缀改写需要额外配置，本插件按 origin 根路径设计。
- `@deepseek-ai/schemastery` 与 `@deepseek-ai/cosmokit` 按**宿主 vendored 的同版本**（`3.18.5-alpha.1` / `1.8.6-alpha.1`）钉住：设置页靠 `schema.toJSON()` 的信封与宿主通信，版本漂移没有意义。它们从 npm 公开包安装，是这份 bundle 唯一两个 `@deepseek-ai/*` 依赖。
- 设置页**不能**替你改 DSH 自己的两个命令行开关（`--trusted-host` / `--public-url`）：那是 `dsh web` 进程的启动参数，不属于本插件的行。页面只做预检，并据此**决定要不要开隧道**（预检不过就不开，见 §五「启动时的围栏探测」）。
- 注册链接是**一次性**的：丢掉或过期就要重新生成。没有"固定注册令牌"这个选项——一个长期有效的注册凭据不值得留在磁盘上。
- 自动登录重定向会把 DSH 的启动令牌放进一次 303 的 `Location`（随后 DSH 立即换成自己的 Cookie）。它是控制台本来就打印的那个凭据；若你不想让它出现在浏览器历史里，可以关掉这一行为（[src/index.ts](src/index.ts) 里不传 `dshEntry`），代价是新设备注册后要手动打开一次 `dsh web` 打印的 `?token=` 链接。
- 控制台是**启动界面**，不是日志文件：正常启动插件只补一行本机链接，其余只打需要人处理的事。

# dsh-sync-remote

**把你的 DSH Web GUI 安全地发布到公网**——用一条 SSH 反向隧道，加一道 Passkey（指纹 / 面容 / Windows Hello / 安全密钥）的门。

想在外面用手机继续一个会话，但又不想把 DSH 暴露在公网上？这个插件解决的问题是：

- 本机的 DSH **只监听回环**，公网上没有任何端口对外开放；
- VPS 上**不装任何常驻服务**，只用自带的 `sshd` 和 Nginx；
- 公网入口前面有一道 **Passkey 门**：没有注册过的设备，连 DSH 的登录页都看不到；
- 会话用 **HttpOnly + Secure + SameSite=Strict** 的签名 Cookie，30 天免登录。

数据怎么走：

```
手机/外部浏览器
      │  https://dsh.example.com
      ▼
   VPS: Nginx（TLS）──► 127.0.0.1:3090 ──► sshd 反向转发
                                                │
   你的电脑                                     ▼
   DSH Web GUI ◄── 127.0.0.1:3080 ◄── Passkey 网关 ◄── 127.0.0.1:3090
       （只监听回环）                  （本插件）
```

网关挡在 DSH 前面：**未通过 Passkey 的请求永远不会到达 DSH**。DSH 自己的启动令牌与 Cookie 依然生效，Passkey 是额外一道门，不是替代它。

---

## 需要准备什么

| 你需要 | 说明 |
| :--- | :--- |
| 一台有公网 IP 的 VPS | 装好 Nginx 与证书（任意方式，Let's Encrypt 即可）；SSH 能登录 |
| 一个域名 | 解析到这台 VPS，例如 `dsh.example.com` |
| DSH 本体 | 本机能跑 `dsh web`（默认 `http://127.0.0.1:3080`） |
| Node.js 26+ | 插件跑在 DSH 进程里，用它执行 TypeScript |
| 一把 SSH 私钥 | 用来连 VPS。**推荐专门生成一把**，见下文「安全建议」 |

---

## 安装

```powershell
# 1) 取源码
git clone https://github.com/allynv/dsh-sync-remote.git
cd dsh-sync-remote

# 2) 装依赖
pnpm install          # 或 npm install

# 3) 构建浏览器半边（设置页与登录页）
npm run build
```

**4) 装进 DSH 的 web profile**：在 DSH 里让 agent 调用 `plugin_manager install_bundle`，`target` 传本目录的绝对路径。

装好后插件是**空闲**的（还没填公网地址），本机 `http://127.0.0.1:3080` 照常可用。接着按下面两步把它打开。

---

## 第一步：填配置（在设置页里填，不用改文件）

打开 **设置 → 远程访问**，填入：

| 字段 | 填什么 |
| :--- | :--- |
| **公网地址** | 浏览器访问的地址，如 `https://dsh.example.com`（只填 origin，不带路径） |
| **服务端端口** | VPS 上监听/反代的端口，如 `3090`。**必须与 Nginx 的 `proxy_pass` 一致** |
| **客户端端口** | 本机 `dsh web` 的端口，如 `3080` |
| **会话有效期** | 登录保持多少小时，如 `720`（30 天） |
| **VPS 地址 / 端口 / SSH 用户** | 例如 `203.0.113.10` / `22` / `root`。**端口是 VPS 的 SSH 端口，不是 3090** |
| **私钥路径** | 私钥的绝对路径，如 `C:\Users\me\.ssh\dsh_tunnel_ed25519` |
| **私钥口令** | 仅当私钥有口令时填 |

保存即生效（不需要重启 `dsh`）。每个字段旁边会标出**当前值来自哪一层**（来自插件配置 / 默认值 / 未设置），"固定值"（监听地址、状态文件、RP ID 等）是只读的，不用管。

> **有输入框的字段都是必填的**，代码里没有隐藏默认值——猜错的端口会让"隧道看着正常但公网 502"。填错时页面顶部会用红色横幅点名是哪个字段。

---

## 第二步：用正确的参数启动 DSH

```powershell
dsh --profile web --public-url https://dsh.example.com/ --trusted-host dsh.example.com
```

这两个参数**必须加**，它们属于 `dsh web` 进程，插件无法代你设置：

- `--trusted-host` 让 DSH 接受公网域名。**少了它，登录后的界面会一片 403**（插件会在启动日志里直接告诉你加这条）。
- `--public-url` 让 DSH 用公网地址生成一次性登录链接。

---

## VPS 侧配置（一次性）

**sshd**：保持默认的 `GatewayPorts no`，不需要开放 3090 端口，也不需要额外开关。

**Nginx**：把域名反代到 `127.0.0.1:3090`。

```nginx
# http{} 里加一行（WebSocket 需要）
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    server_name dsh.example.com;

    location / {
        proxy_pass http://127.0.0.1:3090;
        proxy_set_header Host $host;          # 必须保留：DSH 按它判定信任
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;                  # SSE 需要
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_cookie_flags ~ secure httponly;
    }
}
```

证书按你平时的做法签发即可。确认监听只绑回环：

```sh
sudo ss -ltnp | grep 3090     # 期望 127.0.0.1:3090；若是 0.0.0.0 说明 GatewayPorts 被打开了
```

---

## 开始使用

1. **注册第一台设备**：打开设置页 → 「生成注册二维码」→ 用手机扫码（或复制链接打开）。
   首次安装时，若一把 Passkey 都还没有，插件启动时**已经自动生成了一条链接**，打印在运行 `dsh` 的终端里，同时也写到 `~/.dsh/dsh-sync-remote/enroll-url.txt`。

2. **完成注册**：手机弹出指纹/面容/PIN → 确认 → **自动进入 DSH**，无需再输任何东西。

3. **之后随时访问** `https://dsh.example.com`：会先看到 Passkey 登录页，验证后进入 GUI（30 天内免验证）。

4. **加设备**：设置页里再点一次「生成注册二维码」，用新设备扫。**每个二维码只能用一次**，10 分钟内有效，用完或超时即失效。

5. **删设备**：设置页的「已注册设备」列表里删除。最后一把 Passkey 不可删除（防止把自己锁在门外）。

---

## 安全建议

- **别把私钥的权限放大。** 默认情况下隧道私钥能在 VPS 上开 shell。建议在 VPS 的 `~/.ssh/authorized_keys` 里把它限制成只能做这一个转发：
  ```
  restrict,port-forwarding,permitlisten="127.0.0.1:3090" ssh-ed25519 AAAA…你的公钥… dsh-sync-remote
  ```
  之后这把钥匙**不能登录 shell、不能执行命令、不能开别的端口**。

- **DSH 打印的 `?token=…` 链接本身就是钥匙**，别贴到公开渠道。Passkey 是额外一道门，不是让这条链接失效。

- **状态文件是凭据**，按私钥对待：`~/.dsh/dsh-sync-remote/state.json` 里是签名密钥和已注册的 Passkey。备份它等于备份身份；丢了就要重新注册所有设备。

- 注册链接是**一次性**的，只存在内存里：重启即失效，磁盘上没有任何长期注册凭据。

- 登录/注册接口按来源地址限流（5 分钟 30 次），超限是**延迟响应**而不是锁定——你自己不会被锁在门外。

---

## 遇到问题

| 现象 | 原因与处理 |
| :--- | :--- |
| 登录后界面**一片 403** / 设置页显示「该 Host 被拒绝」 | 启动 DSH 时少了 `--trusted-host`。用上面的命令重启。 |
| 公网 **502**，但插件日志显示隧道正常 | `服务端端口` 与 Nginx 的 `proxy_pass` 不一致。改成同一个值。 |
| 隧道连不上、日志报认证失败 | 私钥路径/SSH 用户/VPS 地址不对。私钥格式只支持 OpenSSH、PKCS#1、SEC1、PuTTY PPK——**openssl 默认生成的 PKCS#8 会被拒绝**，用 `ssh-keygen -t ed25519 -f <file>` 重新生成。 |
| 手机扫码后提示链接无效 | 每个二维码只能用一次、10 分钟有效。回设置页重新生成一个。 |
| 换了 VPS 或重装了系统 | 设置页里「已固定主机密钥」旁边点「重新信任」。 |
| 隧道断了会自动恢复吗 | 会。日志出现 `tunnel lost … reconnecting in … ms` 后会自动重连（指数退避），期间公网返回 502。 |
| 想看更详细的运行状态 | 设置页顶部有网关/隧道/围栏状态；插件只把**需要你处理的事**打到控制台。 |

---

## 已知限制

- 一个插件行只支持**一台 VPS、一条端口映射**；多目标就再挂一个插件行（id 不同）。
- 不支持把 DSH 挂在子路径下（如 `https://example.com/dsh/`），本插件按 origin 根路径设计。
- 依赖 `@simplewebauthn/server` 会在启动时打印两条 Node 实验性特性警告，**与功能无关**，可以忽略。

---

## 深入：开发、测试与内部结构

想改代码、跑测试、或了解技术细节（构建、类型检查、路由、验收步骤、模块职责），见 **[CONTRIBUTING.md](CONTRIBUTING.md)**。

## 许可证

[MIT](LICENSE)

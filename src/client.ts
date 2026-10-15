/**
 * Remote access settings page — the browser half of `dsh-sync-remote`.
 *
 * TypeScript, built by `tsconfig.build.json` into `lib/client.js`, which DSH hands
 * to the page as the package's `./client` bundle. That bundle is loaded as a
 * **classic script** (`<script async src>`, no `type="module"`; DSH's own bundles
 * are emitted as CJS for the same reason), so this file has to stay a script: a
 * top-level `export` would reach the browser as a syntax error and blank this
 * page. It is a global script for TypeScript too, which is why
 * `test/client.spec.mts` imports it through a documented `@ts-expect-error`, and
 * why `test/selfcheck.mts` asserts the built bundle carries no ESM syntax.
 *
 * The page edits the plugin row's own configuration through the Client's
 * `configForms` service (`Settings → Remote access`) and reads everything a form
 * cannot express — the effective values, which layer supplied them, the values
 * the operator cannot set, the registered devices, and the runtime state — from
 * the Host half's `/api/sync-remote.*` routes, which DSH serves behind its own
 * browser-trust fence and operator session.
 *
 * It registers unconditionally, even while the plugin is not serving: when a
 * configuration is refused, this page is the surface that says why.
 *
 * @module @allynv/dsh-sync-remote/client
 */

/**
 * The DSH globals this bundle runs against.
 *
 * They are declared here, in the file that uses them, because this file is a
 * **classic script for TypeScript too**: a script's top-level declarations are
 * already global, so `interface Window` merges into lib.dom's and `declare const`
 * needs no `declare global` wrapper — that wrapper is legal only inside a module,
 * which this file must never become (see the module doc above). If it ever did,
 * these two declarations would silently become file-local instead of global.
 */
interface Window {
  /** The module table that loads Client plugins before the application mounts. */
  __ModuleLoader__: {
    /**
     * @param entry - the module id and its lazy factory.
     */
    load(entry: {
      id: string
      /** @param moduleId - the module table's synchronous loader. */
      factory(require: (moduleId: string) => unknown): unknown
    }): void
  }
}

/** Package-owned stylesheet insertion, when the runtime provides it. */
declare const styles: { insert(css: string): () => void } | undefined

/**
 * Whether a WHATWG URL hostname names the local loopback authority.
 *
 * Deliberately a copy of DSH's own predicate
 * (`packages/client/connection/src/loopback-hostname.ts`): this file is a classic
 * script with no module graph, so it cannot import it — and the page's write rule
 * must agree with the Host's idea of "the operator's own machine" instead of
 * inventing a second one.
 * @param hostname - a page authority's hostname (IPv6 literals keep their brackets).
 * @returns true for localhost, IPv6 loopback, or any IPv4 address in 127/8.
 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether this page is running on the operator's own machine — the only place
 * the configuration may be edited from.
 *
 * A page with no location at all (a non-browser host, a test bench) is NOT
 * loopback: this predicate grants a write capability, so its default has to be
 * the closed one.
 * @returns true only for a loopback page authority.
 */
function isLoopbackPage(): boolean {
  const location = (window as { location?: { hostname?: string } }).location
  const hostname = location?.hostname
  return hostname !== undefined && hostname !== '' && isLoopbackHostname(hostname)
}

/**
 * The authority of an absolute URL, spelled the way a browser sends it in `Host`.
 * @param url - a configured public origin.
 * @returns `host[:port]`, or null when the text is not an absolute URL.
 */
function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.host === '' ? null : parsed.host
  } catch {
    return null
  }
}

/**
 * One path-addressed settings edit.
 */
interface PathOp {
  op: 'set' | 'unset'
  path: string[]
  value?: unknown
}

/**
 * One settings namespace snapshot.
 */
interface FormSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: unknown
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
}

/**
 * One settings namespace editor.
 */
interface ConfigForm {
  getSnapshot(): FormSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly PathOp[], expectedRevision?: number): Promise<boolean>
}

/**
 * One registered device, as the Host reports it.
 */
interface PasskeyView {
  id: string
  label: string
  createdAt: number
  lastUsedAt: number | null
  deviceType: string | null
  backedUp: boolean | null
}

/**
 * The Host half's status payload. It never contains an enrollment link.
 */
interface Status {
  configured: boolean
  configError: string | null
  effective: Record<string, string | number | boolean | null>
  sources: Record<string, 'patch' | 'default' | 'unset'>
  info: {
    bind: string | null
    web: string | null
    rpID: string | null
    rpName: string
    stateFile: string
    remoteBind: string | null
    hostKey: string | null
    secureCookies: boolean
    passphraseSet: boolean
    sshEquivalent: string | null
  }
  enrollment: { enrolled: boolean, pending: boolean, expiresAt: number | null }
  passkeys: PasskeyView[]
  runtime: {
    gateway: 'listening' | 'off'
    tunnel: {
      state: string
      /** Why it is not up; see `TunnelFailureKind` on the Host half. */
      kind: string | null
      attempts: number
      channels: number
      remote: string | null
      hostKey: string | null
      /** Whether this deployment has ever been up: it decides what "failing" means. */
      everListening: boolean
      nextRetryAt: number | null
      /** Non-null once repeated failures have never once succeeded. */
      suspected: 'configuration' | null
      lastError: string | null
    } | null
    fence: { authority: string, status: number, ok: boolean } | null
    /** What `dsh web` was launched with, when the Host can report it. */
    launch: { trustedHosts: string[], publicUrl: string | null } | null
  }
}

/**
 * One freshly minted one-time enrollment link.
 */
interface Minted {
  url: string
  qr: string
  expiresAt: number
}

/**
 * The deployment values a connection test carries.
 *
 * Every field is optional: what the form cannot see is left out and the Host
 * merges the stored value in. `passphrase` may be `null`, which is how "this row
 * has none" is said out loud for the one case that needs it (clearing a
 * passphrase that used to be set).
 *
 * The last three are outside the tunnel half but inside what the test proves: the
 * remote port Nginx reaches the tunnel on, the local port the gateway proxies to,
 * and the public origin the round trip targets. Testing them is what catches "the
 * tunnel works and the domain still 502s".
 */
interface CandidatePatch {
  enabled?: boolean
  host?: string
  port?: number
  user?: string
  privateKeyFile?: string
  passphrase?: string | null
  serverPort?: number
  clientPort?: number
  publicOrigin?: string
}

/**
 * One editable field.
 */
interface FieldDef {
  path: string
  kind: 'text' | 'number' | 'secret' | 'masked' | 'tristate'
  zh: string
  en: string
  hint?: string
  placeholder?: string
  min?: number
  max?: number
  required?: boolean
}

/**
 * One group of editable fields.
 */
interface GroupDef {
  zh: string
  en: string
  fields: FieldDef[]
}

/**
 * A translator bound to one namespace: the key is the text used in `zh`/`en`.
 */
type Translator = (key: string) => string

/**
 * One element this page asks React to build. The props stay opaque here: this
 * page writes them and React reads them.
 */
interface ReactElement {
  type: unknown
  props: Record<string, unknown>
}

/** Everything this page passes as a child, a list of children included. */
type ReactNode = ReactElement | string | number | boolean | null | undefined | readonly ReactNode[]

/**
 * The slice of React this page uses. The browser's module table hands over the
 * real React; this is only the shape `tsc` checks against, which is why the
 * package needs no React type dependency.
 */
interface ReactApi {
  createElement(type: string, props?: Record<string, unknown> | null, ...children: ReactNode[]): ReactElement
  useState<S>(initial: S | (() => S)): [S, (next: S | ((previous: S) => S)) => void]
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
}

/** One settings section as the Client's `slots` service takes it. */
interface SettingsSectionSpec {
  name: string
  id: string
  order: number
  label: () => string
  locale: string
}

/** The Client services this page asks for. */
interface PluginContext {
  effect(factory: () => unknown, label?: string): void
  locale: {
    bind(namespace: string): Translator
    register(namespace: string, dictionaries: { zh: Record<string, string>, en: Record<string, string> }): unknown
  }
  slots: {
    inject(name: string, factory: () => unknown): unknown
    register(spec: SettingsSectionSpec, component: () => ReactElement): unknown
  }
  configForms: {
    get(namespace: string): ConfigForm
  }
}

window.__ModuleLoader__.load({
  id: '@allynv/dsh-sync-remote',
  factory(require) {
    const React = require('react') as ReactApi
    const h = React.createElement

    /** The settings namespace: this plugin row's id. */
    const NS = 'dsh-sync-remote'
    /** The Host half's routes. */
    const STATUS_PATH = '/api/sync-remote.state'
    const MINT_PATH = '/api/sync-remote.enroll.mint'
    const REMOVE_PATH = '/api/sync-remote.passkey.remove'
    const FORGET_PATH = '/api/sync-remote.trust.forget'
    const RETRY_PATH = '/api/sync-remote.tunnel.retry'
    const TEST_PATH = '/api/sync-remote.tunnel.test'
    const RELEASE_PATH = '/api/sync-remote.tunnel.release'

    const zh = {
      nav: '远程访问',
      title: '远程访问（dsh-sync-remote）',
      intro: '通过 VPS 的反向 SSH 隧道，把本机 DSH Web 发布到公网域名，入口由 Passkey 保护。保存后插件行立即重启：网关与隧道按新值重新绑定。配置只保存在这里（profile 补丁），不读也不写任何环境变量。',
      refresh: '刷新状态',
      save: '保存并应用',
      saving: '保存中…',
      reset: '恢复默认',
      saved: '已保存；插件行正在重启，状态会自动刷新。',
      saveFailed: '保存被拒绝；请检查下面的提示。',
      readOnly: '本页只读：请在运行 DSH 的这台机器上用 http://127.0.0.1:<本机 DSH 端口> 打开本页编辑（公网地址只读）。用 ssh -L 把该端口转发到本机也算回环。',
      unavailable: '插件行当前未激活，因此该命名空间不可写。请用配置文件修正后重启 DSH。',
      notWritable: 'Host 的配置文档当前不接受写入，无法保存。请检查 DSH 是否有写权限（或用配置文件手改）。',
      loadingRow: '正在读取配置…稍等一下；若一直停在这里，请刷新页面。',
      badValue: '配置没有通过 Host 的校验，所以这里不能编辑。看一眼 DSH 日志里的报错，或直接改配置文件。',
      hostMismatch: '你正用 {here} 访问本页，但插件发布的公网地址是 {published}。两者不一致：浏览器实际用的那个 authority 也必须写进 dsh web 的 --trusted-host，否则用发布地址访问会一片 403。',
      needOrigin: '还没填公网地址。在下面填好「公网地址」并保存，公网入口就会开启（本机 127.0.0.1 的 GUI 不受影响）。',
      gateway: '网关',
      tunnel: '隧道',
      fence: '安全围栏',
      off: '未启动',
      listening: '监听中',
      fenceOk: '该 Host 被接受',
      fenceBad: '现 Host 被拒绝，DSH 启动时未加 --trusted-host',
      fenceBadOtherHost: '现 Host 被拒绝：DSH 信任的是别的域名',
      tunnelFailed: '隧道没建立起来：',
      tunnelFailedHint: '上面是 ssh2 报的原始原因（例如 ECONNREFUSED 表示主机/端口不对）。改完保存即可重试。',
      tunnelBlocked: '隧道没有开启：DSH 的信任围栏不接受这个域名。',
      tunnelBlockedHint: '用 dsh --profile web --public-url <公网地址>/ --trusted-host <域名> 重启 DSH 即可。在它接受之前，公网入口不会打开（不是故障，是刻意不开）。',
      blockedNoFlag: '具体原因：dsh web 启动时**没有**加 --trusted-host，所以它拒绝了 Host "{host}"。',
      blockedWrongHost: '具体原因：dsh web 信任的是 {trusted}，而这里发布的是 "{host}"——两者不一致，围栏因此拒绝。',
      blockedDespiteTrust: '具体原因：dsh web 声明信任 "{host}"，但围栏仍然拒绝它——检查拼写、是否多写了端口，或 3080 上跑的是另一个 dsh 进程。',
      blockedNoAnswer: '具体原因：本机 GUI 没有确认它接受该域名（最近一次答复是 HTTP {status}）。',
      blockedUnknown: '具体原因：还没拿到围栏的答复（插件刚启动或探测未完成）；稍等几秒看状态是否刷新。',
      blockedNoFacts: '具体原因：这次回复里没有 DSH 的启动参数（插件行可能还没重启）。重启 DSH 后再看这一栏，就能知道是没加 --trusted-host，还是加成了别的域名。',
      rawReason: '原始原因（英文，插件原文）：',
      retry: '立即重试',
      retrying: '重试中…',
      retryStarted: '已重新发起连接；状态稍后自动刷新。',
      retryFailed: '重试没有成功：',
      nextRetry: '下次重试',
      test: '测试连接',
      testing: '测试中…',
      testDone: '连接成功：已认证 {host}；服务器出示的主机密钥 {key}（与已固定一致）。现在可以保存。',
      testFailed: '测试失败：',
      testFailIncomplete: '隧道还没配全：需要 VPS 地址、SSH 用户和私钥路径三样齐全。',
      testFailHost: 'VPS 地址不是一个可用的主机名或 IP：检查「VPS 地址」的拼写（四段都必须在 0–255 之间，不能带端口或用户名）。',
      testFailLocalGui: '本机「客户端端口」上没有 DSH 在监听——网关会把它反代进一个空洞，访客只会看到 502。确认它就是 dsh web 实际监听的端口。',
      testFailKey: '私钥读不到或解析失败：检查「私钥绝对路径」，以及「私钥口令」（口令错也会报成解析失败）。',
      testFailAuth: 'SSH 认证被拒：检查「SSH 用户」，以及这把公钥有没有写进那个用户的 authorized_keys。',
      testFailHostKey: 'VPS 出示的主机密钥与已固定的不一致：可能换了机器，也可能这个地址不是原来的 VPS。确认后用「重新信任」更新。',
      testFailDns: '这个地址解析不出来：检查「VPS 地址」的拼写和本机 DNS。',
      testFailUnreachable: '连不上 VPS：地址写错、VPS 关机、sshd 没起、或「VPS 的 SSH 端口」写错——这几种在协议上无法区分，请逐个排查。',
      testFailTimeout: '这个端口上没有 SSH 在应答（握手超时）：确认「VPS 的 SSH 端口」，以及防火墙/安全组没有丢弃。',
      testFailDropped: 'SSH 会话在就绪前断开：稍后重试；持续出现就检查 VPS 负载与网络。',
      testFailForward: 'VPS 拒绝监听「服务端端口」：端口已被占用（常见是上一次会话残留的 sshd），或 sshd 禁止了转发。',
      testFailPublicPort: '公网域名没有回到本机：Nginx 到了 VPS，但「服务端端口」上没有隧道在监听。**把 Nginx 的 proxy_pass 端口改成与「服务端端口」一致**——改端口时必须先改 Nginx，再测试。',
      testFailPublicUnreachable: '从这台机器访问不到公网地址：检查域名解析、证书，以及本机到公网的网络。',
      testFailPublicWrong: '公网地址回了别的东西：这个域名没有指向本部署（Nginx 指到了别的服务，或 CDN 缓存了旧内容）。',
      testFailPublicNoAnswer: '公网地址在超时时间内没有应答：检查 Nginx、防火墙与网络。',
      testFailUnknown: '测试失败：',
      testNeedsSave: '隧道设置改了：先测试连接，成功了才会保存。',
      retriesStopped: '不会自动重试：修好之后保存，或点「立即重试」；若提示主机密钥不符，请点「重新信任」。',
      untested: 'untested（配置未验证）',
      untestedTitle: '本次配置还没有验证过，公网入口不会打开。',
      untestedHint: '点「测试连接」；成功后保存即可。手工改过配置文件也会回到这个状态。',
      hintLocal: '本机网关端口没能绑定（多半被别的进程占用）：改「服务端端口」，或先释放占用它的进程，然后点「立即重试」。',
      suspectedConfig: '连续多次没连上。这组配置是验证过的，所以更可能是 VPS 或网络暂时不可用；会继续按最长 5 分钟间隔重连。若你改过地址、端口或密钥，请先「测试连接」。',
      hintKey: '私钥读不到或格式不支持：改「私钥绝对路径」，或重新生成一把（只支持 OpenSSH、PKCS#1、SEC1、PuTTY PPK）。',
      hintAuth: 'SSH 认证被拒：检查「SSH 用户」、私钥是否与该用户配对、以及私钥口令。',
      hintHostKey: 'VPS 的主机密钥和已固定的不一致：确认这是你重装/换机后的 VPS，再点下面「重新信任」。',
      hintForward: 'VPS 拒绝监听隧道端口：多半是上一次会话没有释放。按提示在 VPS 上查明并结束占用进程，然后点「立即重试」。',
      hintConfig: '连不上 VPS：检查「VPS 地址」「VPS 的 SSH 端口」，以及 VPS 是否在运行、防火墙/安全组是否放行。',
      hintDropped: '隧道断开（VPS 重启或网络中断）：会自动重连，期间公网返回 502。',
      release: '释放 VPS 端口',
      releasing: '释放中…',
      releaseDone: '已释放：',
      releaseFailed: '没能释放：',
      groupBasic: '基本',
      groupTunnel: 'SSH 反向隧道',
      infoTitle: '固定值（不可修改）',
      infoBind: '网关监听地址',
      infoWeb: '本机 DSH',
      infoRpID: 'WebAuthn RP ID',
      infoRpName: '认证器显示名',
      infoStateFile: '状态文件',
      infoRemoteBind: 'VPS 穿透监听',
      infoHostKey: '已固定主机密钥',
      infoHostKeyNone: '尚未固定（首次连接时自动记录）',
      infoSecure: '会话 Cookie',
      infoSecureOn: 'Secure（https）',
      infoSecureOff: '非 Secure（http）',
      infoSsh: '等价命令',
      infoSshHint: '手动等价于这条命令：-p 是 VPS 的 SSH 端口，-R 是隧道端口 → 本机网关。对照一下就知道哪个端口填错了。',
      infoSshNone: '隧道未启用（填好 VPS 地址、SSH 用户与私钥后自动启用）',
      forget: '重新信任',
      forgetDone: '已清除固定的主机密钥，隧道正在重新连接并重新固定。',
      enrollTitle: '注册新设备',
      enrollHintEmpty: '还没有任何设备。用手机扫下面的二维码即可注册（指纹/面容/PIN）。',
      enrollHintMore: '要再给一台设备注册，生成一个一次性链接，用那台设备扫码。',
      mint: '生成注册二维码',
      mintAgain: '重新生成',
      minting: '生成中…',
      minted: '已生成一次性链接：只能用一次，扫码完成注册后立即失效。',
      mintedExpires: '失效时间',
      remaining: '剩余 {n} 分钟',
      expiredNow: '这个链接已经过期或被用掉了，点「重新生成」拿一个新的。',
      mintReplace: '生成新链接会作废上一个（包括控制台和 enroll-url.txt 里的那个）。链接只能用一次，10 分钟内有效。',
      pendingElsewhere: '已经有一个待用的一次性链接（在 DSH 控制台或状态文件同目录的 enroll-url.txt 里）。要在这里显示二维码，点上面的按钮重新生成一个——旧的会立即作废。',
      expired: '上一个链接已失效（用过或过期），需要时重新生成。',
      copy: '复制链接',
      copied: '已复制到剪贴板。',
      copyFailed: '复制失败，请手动选择链接。',
      noLinkYet: '还没有可用的链接。',
      devices: '已注册设备',
      noDevices: '还没有注册任何设备。',
      createdAt: '注册于',
      lastUsed: '最近使用',
      remove: '删除',
      removeConfirm: '再点一次确认删除',
      removeLast: '最后一个设备不能删除（否则没人能登录）。',
      removed: '已删除该设备。',
      sourcePatch: '来自插件配置',
      sourceDefault: '默认值',
      sourceUnset: '未设置',
      inherit: '自动',
      on: '启用',
      offValue: '关闭',
      secretSet: '已设置（留空=不修改）',
      secretUnset: '未设置',
      reveal: '显示',
      conceal: '隐藏',
      errNumber: '需要一个整数',
      errRange: '超出允许范围',
      errOrigin: '需要是完整 origin，例如 https://dsh.example.com（不带路径）',
      errPath: '需要绝对路径',
      errHost: '只能包含字母、数字、点、下划线和连字符',
      errHostBracket: 'IPv6 地址不要加方括号：直接写 ::1',
      errHostIp: 'IP 地址无效：四段都必须在 0–255 之间',
      errHostPort: '这看起来是「地址:端口」；端口请填到「VPS 的 SSH 端口」',
      errRequired: '必填（这个值无法猜，必须与 VPS / Nginx 一致）',
    }

    const en = {
      nav: 'Remote access',
      title: 'Remote access (dsh-sync-remote)',
      intro: 'Publishes this machine’s DSH Web GUI on a public domain through a reverse SSH tunnel to a VPS, gated by a passkey. Saving restarts the plugin row: the gateway and tunnel rebind to the new values. Everything is stored here (the profile patch); no environment variable is read or written.',
      refresh: 'Refresh',
      save: 'Save and apply',
      saving: 'Saving…',
      reset: 'Reset',
      saved: 'Saved; the plugin row is restarting and the status refreshes by itself.',
      saveFailed: 'The write was refused; see the field messages below.',
      readOnly: 'This page is read-only: open it as http://127.0.0.1:<local DSH port> on the machine running DSH to edit (the public address stays read-only). An ssh -L forward of that port to your machine counts as loopback too.',
      unavailable: 'The plugin row is not active, so its namespace is not writable. Fix the configuration file and restart DSH.',
      notWritable: 'The Host configuration document does not accept writes right now, so nothing can be saved. Check that DSH may write it, or edit the configuration file by hand.',
      loadingRow: 'Reading the configuration… If this never finishes, reload the page.',
      badValue: 'The configuration did not pass the Host\u2019s validation, so it cannot be edited here. Check the DSH log for the error, or edit the configuration file directly.',
      hostMismatch: 'You reached this page at {here}, but the plugin publishes {published}. Those two differ: the authority a browser actually uses must be in dsh web --trusted-host as well, or the published address answers 403 to everything.',
      needOrigin: 'No public origin yet. Fill in “Public origin” below and save; the public entry point opens then (the local GUI on 127.0.0.1 is unaffected).',
      gateway: 'Gateway',
      tunnel: 'Tunnel',
      fence: 'Security fence',
      off: 'off',
      listening: 'listening',
      fenceOk: 'that Host is accepted',
      fenceBad: 'this Host is refused: dsh web was started without --trusted-host',
      fenceBadOtherHost: 'this Host is refused: dsh web trusts a different host',
      tunnelFailed: 'The tunnel is not up:',
      tunnelFailedHint: 'That is ssh2\u2019s own reason (ECONNREFUSED usually means the host or port is wrong). Fix it and save to retry.',
      tunnelBlocked: 'The tunnel is closed: the DSH trust fence refuses this Host.',
      tunnelBlockedHint: 'Restart DSH as dsh --profile web --public-url <public origin>/ --trusted-host <host>. Until it accepts this Host, the public entry point stays closed \u2014 deliberately, not by accident.',
      blockedNoFlag: 'Specifically: dsh web was started **without** --trusted-host, so it refused Host "{host}".',
      blockedWrongHost: 'Specifically: dsh web trusts {trusted}, while this deployment publishes "{host}" \u2014 they disagree, so the fence refuses.',
      blockedDespiteTrust: 'Specifically: dsh web declares it trusts "{host}", yet the fence still refuses it \u2014 check the spelling, any extra port, or whether another dsh process answers on 3080.',
      blockedNoAnswer: 'Specifically: the local GUI has not confirmed it accepts this Host (its last answer was HTTP {status}).',
      blockedUnknown: 'Specifically: no fence answer has arrived yet (the plugin just started or the probe is still running); watch the state line for a few seconds.',
      blockedNoFacts: 'Specifically: this answer carried no dsh web launch facts (the plugin row may not have restarted yet). Restart DSH and this line will say whether --trusted-host was missing or named a different host.',
      rawReason: 'Raw reason (English, from the plugin):',
      retry: 'Retry now',
      retrying: 'Retrying\u2026',
      retryStarted: 'A new connection attempt was started; the state refreshes on its own.',
      retryFailed: 'The retry did not succeed:',
      nextRetry: 'next retry',
      test: 'Test connection',
      testing: 'Testing…',
      testDone: 'Connected: authenticated as {host}; the server presented host key {key} (matches the pinned one). You can save now.',
      testFailed: 'The test failed: ',
      testFailIncomplete: 'The tunnel is incomplete: it needs a VPS address, an SSH user, and a private key path.',
      testFailHost: 'The VPS address cannot be a host: check its spelling (four octets 0–255, no port, no user@).',
      testFailLocalGui: 'Nothing answers like DSH on 客户端端口 (clientPort) — the gateway would proxy into a void and every visitor would see 502. Make sure it is the port dsh web listens on.',
      testFailKey: 'The private key could not be read or parsed: check 私钥绝对路径 and 私钥口令 (a wrong passphrase reads as a parse failure too).',
      testFailAuth: 'SSH authentication was refused: check 服务端 SSH 用户 and whether this public key is in that user\'s authorized_keys.',
      testFailHostKey: 'The VPS presented a host key that does not match the pinned one: it may have been re-installed, or this address may not be your VPS. Use 重新信任 once you are sure.',
      testFailDns: 'That address does not resolve: check the spelling of VPS 地址 and this machine\'s DNS.',
      testFailUnreachable: 'Cannot reach the VPS: wrong address, VPS down, sshd not running, or a wrong VPS 的 SSH 端口 — the protocol cannot tell these apart, so check them one by one.',
      testFailTimeout: 'No SSH answer on that port (handshake timeout): confirm VPS 的 SSH 端口, and that no firewall or security group drops it.',
      testFailDropped: 'The SSH session closed before it was ready: retry; if it keeps happening, look at VPS load and the network.',
      testFailForward: 'The VPS refused to listen on 服务端端口: the port is already held (usually a previous session\'s sshd), or sshd forbids forwarding.',
      testFailPublicPort: 'The public address did not come back here: Nginx reached the VPS, but no tunnel was listening on 服务端端口. Set Nginx\'s proxy_pass to that same port — when the port changes, change Nginx first, then test.',
      testFailPublicUnreachable: 'This machine cannot reach its own public address: check DNS, the certificate, and outbound network access.',
      testFailPublicWrong: 'The public address answered with something else: the domain does not lead to this deployment (Nginx points elsewhere, or a CDN cached the old site).',
      testFailPublicNoAnswer: 'The public address did not answer within the timeout: check Nginx, the firewall, and the network.',
      testFailUnknown: 'The test failed: ',
      testNeedsSave: 'The tunnel settings changed: they are tested first, and only saved when the test passes.',
      retriesStopped: 'It will not retry on its own: fix it and save, or press Retry now; if the host key does not match, press Trust again.',
      untested: 'untested (configuration not verified)',
      untestedTitle: 'This configuration has not been verified, so the public entry stays closed.',
      untestedHint: 'Press “Test connection”; save once it passes. Editing the configuration file by hand leads back here.',
      hintLocal: 'The local gateway port could not be bound (something else usually holds it): change “Server port”, or free it, then press Retry now.',
      suspectedConfig: 'Repeated failures. This configuration was verified by a connection test, so the VPS or the network is the likelier cause; it keeps reconnecting at up to five-minute intervals. If you changed the address, port, or key, run the connection test first.',
      hintKey: 'The private key cannot be read or is in a format ssh2 rejects: fix "absolute path to the private key", or generate a new one (OpenSSH, PKCS#1, SEC1, or PuTTY PPK only).',
      hintAuth: 'SSH authentication was rejected: check the SSH user, that the key belongs to that user, and the key\u2019s passphrase.',
      hintHostKey: 'The server\u2019s host key does not match the pinned one: once you are sure this is your VPS after a reinstall, press Trust again below.',
      hintForward: 'The VPS refused to listen on the tunnel port: usually a previous session that never released it. Follow the command, end the process holding it, then press Retry now.',
      hintConfig: 'Cannot reach the VPS: check the VPS address and SSH port, that the VPS is running, and that its firewall allows the port.',
      hintDropped: 'The tunnel dropped (a VPS reboot or a network interruption): it reconnects by itself, and the public address answers 502 meanwhile.',
      release: 'Release the VPS port',
      releasing: 'Releasing\u2026',
      releaseDone: 'Released: ',
      releaseFailed: 'Could not release it: ',
      groupBasic: 'Basics',
      groupTunnel: 'SSH reverse tunnel',
      infoTitle: 'Fixed values (not editable)',
      infoBind: 'Gateway listener',
      infoWeb: 'Local DSH',
      infoRpID: 'WebAuthn RP ID',
      infoRpName: 'Authenticator name',
      infoStateFile: 'State file',
      infoRemoteBind: 'VPS tunnel listener',
      infoHostKey: 'Pinned host key',
      infoHostKeyNone: 'not pinned yet (recorded on the first connection)',
      infoSecure: 'Session cookie',
      infoSecureOn: 'Secure (https)',
      infoSecureOff: 'not Secure (http)',
      infoSsh: 'Equivalent command',
      infoSshHint: 'Doing it by hand is this command: -p is the VPS SSH port, -R is the tunnel port to the local gateway. Comparing the two shows which port is wrong.',
      infoSshNone: 'the tunnel is off (it turns itself on once host, SSH user, and key are filled in)',
      forget: 'Trust again',
      forgetDone: 'The pinned host key was cleared; the tunnel is reconnecting and will pin again.',
      enrollTitle: 'Enroll a device',
      enrollHintEmpty: 'No device yet. Scan the code below with a phone to register (fingerprint / face / PIN).',
      enrollHintMore: 'To register another device, mint a one-time link and scan it with that device.',
      mint: 'Mint enrollment QR',
      mintAgain: 'Mint a new one',
      minting: 'Minting…',
      minted: 'One-time link minted: it works for a single registration, then it is dead.',
      mintedExpires: 'expires',
      remaining: 'expires in {n} min',
      expiredNow: 'That link expired or was used. Mint a new one.',
      mintReplace: 'Minting a new link retires the previous one, including the copy in the console and in enroll-url.txt. A link works once, for ten minutes.',
      pendingElsewhere: 'A one-time link is already pending (in the DSH console, or in enroll-url.txt beside the state file). To show a QR here, mint a new one — the old link is retired immediately.',
      expired: 'The previous link is gone (used or expired). Mint another one when you need it.',
      copy: 'Copy link',
      copied: 'Copied to the clipboard.',
      copyFailed: 'Copy failed; select the link manually.',
      noLinkYet: 'No usable link yet.',
      devices: 'Registered devices',
      noDevices: 'No device is registered yet.',
      createdAt: 'registered',
      lastUsed: 'last used',
      remove: 'Remove',
      removeConfirm: 'Click again to confirm',
      removeLast: 'The last device cannot be removed (nobody could sign in).',
      removed: 'Device removed.',
      sourcePatch: 'from the plugin row',
      sourceDefault: 'default',
      sourceUnset: 'unset',
      inherit: 'auto',
      on: 'on',
      offValue: 'off',
      secretSet: 'set (leave empty to keep)',
      secretUnset: 'not set',
      reveal: 'show',
      conceal: 'hide',
      errNumber: 'needs a whole number',
      errRange: 'out of range',
      errOrigin: 'needs a full origin, for example https://dsh.example.com (no path)',
      errPath: 'needs an absolute path',
      errHost: 'letters, digits, dots, underscores, and hyphens only',
      errHostBracket: 'write an IPv6 address without brackets: ::1, not [::1]',
      errHostIp: 'not a valid IPv4 address: all four parts must be 0–255',
      errHostPort: 'that looks like host:port — put the port in “VPS SSH port”',
      errRequired: 'required — this value cannot be guessed, it must match the VPS and Nginx',
    }

    const GROUPS: GroupDef[] = [
      {
        zh: '基本',
        en: 'Basics',
        fields: [
          { path: 'publicOrigin', kind: 'text', required: true, zh: '公网地址', en: 'Public origin', hint: '必填：浏览器访问的 origin，例如 https://dsh.example.com', placeholder: 'https://dsh.example.com' },
          { path: 'serverPort', kind: 'number', min: 1, max: 65535, required: true, zh: '服务端端口（VPS 穿透监听）', en: 'Server port (VPS tunnel listener)', hint: '必填：VPS 上以 127.0.0.1:<这个端口> 监听转发，Nginx 反代到这里；本机网关也用同一个端口（所以 ssh -R 两端一致）', placeholder: '3090' },
          { path: 'clientPort', kind: 'number', min: 1, max: 65535, required: true, zh: '客户端端口（本机 dsh web）', en: 'Client port (local dsh web)', hint: '必填：本机 dsh web 的端口（始终按 127.0.0.1 连接），例如 3080', placeholder: '3080' },
          { path: 'sessionTtlHours', kind: 'number', min: 1, max: 8760, required: true, zh: '会话有效期（小时）', en: 'Session lifetime (hours)', hint: '必填：网关会话 Cookie 的有效期，例如 720（30 天）', placeholder: '720' },
        ],
      },
      {
        zh: 'SSH 反向隧道',
        en: 'SSH reverse tunnel',
        fields: [
          { path: 'tunnel.enabled', kind: 'tristate', zh: '启用隧道', en: 'Tunnel', hint: '自动 = 下面三项齐备就启用' },
          { path: 'tunnel.host', kind: 'masked', required: true, zh: 'VPS 地址', en: 'VPS host', placeholder: '203.0.113.10', hint: '必填：SSH 目标（IP 或域名）。默认遮蔽显示，点右边的眼睛可切换' },
          { path: 'tunnel.port', kind: 'number', min: 1, max: 65535, required: true, zh: 'VPS 的 SSH 端口', en: 'VPS SSH port', hint: '必填：一般就是 22（你的 ssh 命令里省略的 -p）；不是上面那个穿透监听端口', placeholder: '22' },
          { path: 'tunnel.user', kind: 'text', required: true, zh: 'SSH 用户', en: 'SSH user', placeholder: 'root' },
          { path: 'tunnel.privateKeyFile', kind: 'text', required: true, zh: '私钥绝对路径', en: 'Private key (absolute path)', placeholder: 'C:\\Users\\me\\.ssh\\id_ed25519' },
          { path: 'tunnel.passphrase', kind: 'secret', zh: '私钥口令', en: 'Key passphrase' },
          { path: 'tunnel.releaseStaleForward', kind: 'tristate', zh: '释放 VPS 端口', en: 'Release the VPS port', hint: '开启后：连续三次「VPS 拒绝监听」时，插件会用同一个 SSH 用户在 VPS 上执行 `ss -ltnp` 并在确认占用者是 sshd 后 `kill <pid>`。这是本插件唯一会在 VPS 上动手的能力，默认关闭。' },
        ],
      },
    ]

    /** Every field, keyed by its dotted path. */
    const FIELDS = new Map<string, FieldDef>()
    for (const group of GROUPS) for (const field of group.fields) FIELDS.set(field.path, field)

    /**
     * The form paths whose value a connection test has to prove before a write.
     *
     * Exactly what `tunnelFingerprint` covers: those are the values a dial
     * exercises, so those are the ones that may not be persisted untested.
     *
     * The server port, the client port, and the public origin are in the list now
     * because the test exercises them too: it binds the remote port, asks the local
     * port for a DSH answer, and proves the public origin comes back here. Changing
     * any of them can turn a working deployment into a 502, which is exactly what the
     * gate exists to catch. The enable switch stays outside: flipping it cannot
     * invalidate a proof, and turning it on with unproven values is what the Host's
     * own `untested` gate is for.
     */
    const GATED_PATHS = new Set([
      'tunnel.host', 'tunnel.port', 'tunnel.user', 'tunnel.privateKeyFile', 'tunnel.passphrase',
      'serverPort', 'clientPort', 'publicOrigin',
    ])

    const CSS = `
.dsh-sync-remote { display: flex; flex-direction: column; gap: 18px; max-width: 760px; color: var(--dsw-alias-label-primary); }
.dsh-sync-remote h2 { font-size: 16px; font-weight: 600; margin: 0; }
.dsh-sync-remote h3 { font-size: 13px; font-weight: 600; margin: 0 0 8px; color: var(--dsw-alias-label-primary); }
.dsh-sync-remote p { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dsh-sync-remote .sr-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dsh-sync-remote .sr-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 14px 16px; }
.dsh-sync-remote .sr-facts { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 12px; }
.dsh-sync-remote .sr-fact { display: flex; align-items: center; gap: 6px; }
.dsh-sync-remote .sr-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.dsh-sync-remote .sr-dot.ok { background: var(--dsw-alias-state-success-primary); }
.dsh-sync-remote .sr-dot.bad { background: var(--dsw-alias-state-error-primary); }
.dsh-sync-remote .sr-row { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 10px 12px; align-items: start; padding: 7px 0; }
.dsh-sync-remote .sr-row + .sr-row { border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-sync-remote .sr-label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; padding-top: 7px; }
.dsh-sync-remote .sr-badge { font-size: 10px; color: var(--dsw-alias-label-secondary); }
.dsh-sync-remote .sr-input, .dsh-sync-remote .sr-select { width: 100%; box-sizing: border-box; font: inherit; font-size: 12px; padding: 6px 8px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.dsh-sync-remote .sr-input:focus, .dsh-sync-remote .sr-select:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.dsh-sync-remote .sr-input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.dsh-sync-remote .sr-input:disabled { color: var(--dsw-alias-label-secondary); }
.dsh-sync-remote .sr-input[readonly] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.dsh-sync-remote .sr-masked { display: flex; align-items: center; gap: 6px; }
.dsh-sync-remote .sr-btn.eye { flex: none; padding: 4px 8px; font-size: 13px; line-height: 1.2; }
.dsh-sync-remote .sr-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 4px; }
.dsh-sync-remote .sr-error { font-size: 11px; color: var(--dsw-alias-state-error-primary); margin-top: 4px; }
.dsh-sync-remote .sr-btn { font: inherit; font-size: 12px; padding: 6px 12px; border-radius: 7px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.dsh-sync-remote .sr-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dsh-sync-remote .sr-btn:disabled { opacity: .5; cursor: default; }
.dsh-sync-remote .sr-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.dsh-sync-remote .sr-btn.link { border: none; background: none; color: var(--dsw-alias-brand-primary); padding: 2px 4px; }
.dsh-sync-remote .sr-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dsh-sync-remote .sr-banner { border-radius: 8px; padding: 10px 12px; font-size: 12px; line-height: 1.6; border: 1px solid var(--dsw-alias-border-l1); }
.dsh-sync-remote .sr-banner.error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dsh-sync-remote .sr-banner.warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.dsh-sync-remote .sr-qr { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; margin-top: 10px; }
.dsh-sync-remote .sr-qr img { width: 200px; height: 200px; background: #fff; padding: 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); }
.dsh-sync-remote .sr-link { display: flex; gap: 8px; align-items: center; flex: 1 1 260px; min-width: 0; }
.dsh-sync-remote .sr-devices { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.dsh-sync-remote .sr-device { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; padding: 6px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-sync-remote .sr-device span.meta { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsh-sync-remote .sr-info { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.dsh-sync-remote .sr-info-row { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 12px; }
.dsh-sync-remote .sr-info-row span:first-child { color: var(--dsw-alias-label-secondary); }
.dsh-sync-remote .sr-info-row code { font-family: ui-monospace, Consolas, monospace; font-size: 11px; word-break: break-all; }
`

    /** Insert the stylesheet however this runtime offers; return its disposer. */
    function insertStyles(): () => void {
      if (typeof styles !== 'undefined' && styles !== undefined && typeof styles.insert === 'function') {
        return styles.insert(CSS)
      }
      const element = document.createElement('style')
      element.textContent = CSS
      document.head.appendChild(element)
      return () => { element.remove() }
    }

    /**
     * Read a dotted path off a plain object.
     * @param node - the object to walk.
     * @param path - dotted path.
     * @returns the value, or undefined.
     */
    function readPath(node: unknown, path: string): unknown {
      let current: unknown = node
      for (const key of path.split('.')) {
        if (current === null || typeof current !== 'object') return undefined
        current = (current as Record<string, unknown>)[key]
      }
      return current
    }

    /**
     * Validate one draft value, mirroring the Host's rules, so a rejected write
     * is the exception rather than the way an operator finds out.
     * @param field - the field being edited.
     * @param text - its draft text (empty means "inherit the default").
     * @param t - the bound translator.
     * @returns the problem, or null.
     */
    function validate(field: FieldDef, text: string, t: Translator): string | null {
      if (text === '') {
        // Emptying a field normally means "drop my override", but a field the
        // host cannot guess must be filled: catching it here saves a round trip
        // through a red banner.
        return field.required === true ? t('errRequired') : null
      }
      if (field.kind === 'number') {
        const value = Number(text)
        if (!Number.isSafeInteger(value)) return t('errNumber')
        if (field.min !== undefined && value < field.min) return t('errRange')
        if (field.max !== undefined && value > field.max) return t('errRange')
        return null
      }
      if (field.path === 'publicOrigin') {
        let url: URL
        try {
          url = new URL(text)
        } catch {
          return t('errOrigin')
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return t('errOrigin')
        if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return t('errOrigin')
        return null
      }
      if (field.path === 'tunnel.host') {
        if (!/^[a-z0-9._:-]+$/iu.test(text)) return t('errHost')
        // The two typos that are decided without any network at all are caught
        // here too, mirroring `tunnelHostProblem` on the Host half; everything
        // else about the address is the connection test's verdict, not this
        // page's guess.
        if (text.startsWith('[') || text.endsWith(']')) return t('errHostBracket')
        if (/^(\d{1,3}\.){3}\d{1,3}$/u.test(text) && text.split('.').some(part => Number(part) > 255)) {
          return t('errHostIp')
        }
        if (/^[^:]+:\d{1,5}$/u.test(text)) return t('errHostPort')
        return null
      }
      if (field.path === 'tunnel.privateKeyFile') {
        return /^([a-zA-Z]:[\\/]|\/)/u.test(text) ? null : t('errPath')
      }
      return null
    }

    /**
     * Build the page's component.
     * @param t - the bound translator.
     * @param form - this row's settings editor.
     * @returns the React component.
     */
    function makeSection(t: Translator, form: ConfigForm): () => ReactElement {
      return function RemoteAccessSection(): ReactElement {
        const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
        const [status, setStatus] = React.useState<Status | null>(null)
        const [loadError, setLoadError] = React.useState<string | null>(null)
        const [draft, setDraft] = React.useState<Record<string, string>>({})
        const [message, setMessage] = React.useState<string | null>(null)
        const [busy, setBusy] = React.useState(false)
        const [pendingRemove, setPendingRemove] = React.useState<string | null>(null)
        const [minted, setMinted] = React.useState<Minted | null>(null)
        const [autoMinted, setAutoMinted] = React.useState(false)
        const [showTunnel, setShowTunnel] = React.useState(true)
        /**
         * The candidate values the last successful connection test proved.
         *
         * Serialized, so it is a plain equality check against the current draft:
         * any edit after a test invalidates it, and the save gate then insists on
         * a fresh one. This is the page half of "test, then persist"; the state
         * file's fingerprint is the Host half.
         */
        const [testedDraft, setTestedDraft] = React.useState<string | null>(null)
        /** Which masked fields the operator chose to reveal, by form path. */
        const [revealed, setRevealed] = React.useState<Record<string, boolean>>({})
        /** Re-rendered on a timer so the minted link's remaining life counts down. */
        const [clock, setClock] = React.useState(() => Date.now())

        /**
         * @param expiresAt - when the link dies, epoch milliseconds.
         * @returns whole minutes of life left, never negative.
         */
        const minutesLeft = (expiresAt: number): number => Math.max(0, Math.ceil((expiresAt - clock) / 60_000))

        React.useEffect(() => {
          if (minted === null) return undefined
          const timer = setInterval(() => { setClock(Date.now()) }, 15_000)
          return () => { clearInterval(timer) }
        }, [minted])

        const refresh = function (): Promise<void> {
          return fetch(STATUS_PATH, { headers: { accept: 'application/json' }, cache: 'no-store' })
            .then((response) => {
              if (!response.ok) throw new Error('HTTP ' + String(response.status))
              return response.json() as Promise<Status>
            })
            .then((body) => { setStatus(body); setLoadError(null) })
            .catch((error: unknown) => { setLoadError(error instanceof Error ? error.message : String(error)) })
        }

        /**
         * @param why - message to show while the request is in flight.
         */
        const mint = function (why: string | null): void {
          setBusy(true)
          setMessage(why)
          fetch(MINT_PATH, { method: 'POST' })
            .then(async (response) => {
              const payload = (await response.json().catch(() => null)) as { url?: string, qr?: string, expiresAt?: number, error?: unknown } | null
              if (!response.ok || payload === null || payload.url === undefined || payload.qr === undefined) {
                throw new Error(payload && payload.error ? String(payload.error) : 'HTTP ' + String(response.status))
              }
              setMinted({ url: payload.url, qr: payload.qr, expiresAt: payload.expiresAt ?? 0 })
              setMessage(t('minted'))
              return refresh()
            })
            .catch((error: unknown) => { setMessage(error instanceof Error ? error.message : String(error)) })
            .then(() => { setBusy(false) })
        }

        React.useEffect(() => {
          const off = form.subscribe(() => { setSnapshot(form.getSnapshot()) })
          return off
        }, [])

        React.useEffect(() => {
          void refresh()
        }, [snapshot.revision])

        // The page's whole job is to say whether the deployment is working, so it
        // has to keep asking: without this, a tunnel that dropped to
        // `reconnecting` left a green 「监听中」 on screen — the exact failure the
        // page exists to surface — while the copy promised it refreshes itself.
        React.useEffect(() => {
          const timer = setInterval(() => { void refresh() }, 10_000)
          return () => { clearInterval(timer) }
        }, [])

        React.useEffect(() => {
          if (autoMinted || status === null) return
          setAutoMinted(true)
          // A deployment nobody can sign into yet gets its QR without a click.
          // A second device gets one on demand, because minting retires the link
          // the operator may be holding; and a gateway that is not running has
          // nothing to mint from, so the banner stays quiet until it is fixed.
          // A deployment nobody can sign into yet gets its QR without a click —
          // but only when no link is already pending: the first run mints one at
          // startup and prints it, and merely opening this section must not retire
          // the link the operator is halfway through using.
          if (!status.enrollment.enrolled && !status.enrollment.pending && status.runtime.gateway === 'listening') mint(null)
        }, [status, autoMinted])

        /**
         * @param path - dotted form path.
         * @returns the value a field shows: the draft, the row's own value, or the effective one.
         */
        const valueOf = function (path: string): string {
          if (Object.prototype.hasOwnProperty.call(draft, path)) return draft[path]
          const own = readPath(snapshot.user, path)
          if (own !== undefined && own !== null) return String(own)
          const effective = status === null ? undefined : status.effective[path]
          return effective === undefined || effective === null ? '' : String(effective)
        }

        /**
         * @param path - dotted form path.
         * @returns whether the row overrides this field.
         */
        const isOwn = function (path: string): boolean {
          const own = readPath(snapshot.user, path)
          return own !== undefined && own !== null
        }

        /**
         * The values a connection test should carry, as the form sees them.
         *
         * `valueOf` resolves the draft, then the row, then the effective value —
         * exactly what the pending save would write — so the tested candidate and
         * the saved configuration are the same values. The passphrase is the one
         * secret the page is never shown: it is sent only when the operator typed
         * one, and explicitly `null` when a field is being reset.
         * @param overrides - values a reset is about to remove.
         * @returns the patch for the Host's test route.
         */
        const collectCandidate = function (overrides?: { passphrase?: string | null }): CandidatePatch {
          const patch: CandidatePatch = {
            host: valueOf('tunnel.host'),
            port: Number(valueOf('tunnel.port')),
            user: valueOf('tunnel.user'),
            privateKeyFile: valueOf('tunnel.privateKeyFile'),
            // The deployment values outside the tunnel half: the test proves these too
            // (remote port bound and reached, local port asked, origin round-tripped).
            serverPort: Number(valueOf('serverPort')),
            clientPort: Number(valueOf('clientPort')),
            publicOrigin: valueOf('publicOrigin'),
          }
          const enabled = valueOf('tunnel.enabled')
          // "inherit" is not a value: it means the three coordinates decide.
          if (enabled === 'true') patch.enabled = true
          else if (enabled === 'false') patch.enabled = false
          const passphrase = overrides !== undefined && 'passphrase' in overrides
            ? overrides.passphrase
            : draft['tunnel.passphrase']
          if (typeof passphrase === 'string' && passphrase !== '') patch.passphrase = passphrase
          else if (passphrase === null) patch.passphrase = null
          return patch
        }

        /** @returns whether the values on screen would enable the tunnel. */
        const tunnelWillBeEnabled = function (): boolean {
          return valueOf('tunnel.enabled') !== 'false'
            && valueOf('tunnel.host') !== ''
            && valueOf('tunnel.user') !== ''
            && valueOf('tunnel.privateKeyFile') !== ''
        }

        /**
         * Which dictionary entry names the failure the Host classified.
         *
         * The Host reports a stable `code` (and the stage it belongs to) precisely so
         * this page can say it in the operator's language; the raw text it also sends
         * is ssh2's or an HTTP status, and translating those would be inventing.
         */
        const TEST_FAILURE_KEYS: Record<string, string> = {
          'incomplete': 'testFailIncomplete',
          'host-syntax': 'testFailHost',
          'local-gui-missing': 'testFailLocalGui',
          'key-read': 'testFailKey',
          'key-rejected': 'testFailKey',
          'auth': 'testFailAuth',
          'host-key': 'testFailHostKey',
          'dns': 'testFailDns',
          'unreachable': 'testFailUnreachable',
          'handshake-timeout': 'testFailTimeout',
          'dropped': 'testFailDropped',
          'forward-refused': 'testFailForward',
          'public-port-mismatch': 'testFailPublicPort',
          'public-unreachable': 'testFailPublicUnreachable',
          'public-wrong-service': 'testFailPublicWrong',
          'public-no-answer': 'testFailPublicNoAnswer',
        }

        /**
         * The page's own sentence for a failed test, with the Host's text below it.
         * @param payload - the failure body, when there was one.
         * @param status - the HTTP status, for the case where there was not.
         * @returns the two lines to show.
         */
        const describeTestFailure = function (payload: { code?: unknown, error?: unknown, evidence?: unknown } | null, status: number): string {
          const code = typeof payload?.code === 'string' ? payload.code : ''
          const key = TEST_FAILURE_KEYS[code]
          const lead = key === undefined ? t('testFailed') : t(key)
          const raw = typeof payload?.evidence === 'string' && payload.evidence !== ''
            ? payload.evidence
            : typeof payload?.error === 'string' && payload.error !== ''
              ? payload.error
              : 'HTTP ' + String(status)
          return lead + '\n' + t('rawReason') + ' ' + raw
        }

        /**
         * Walk the whole publish path, on the Host, and report what came back.
         *
         * Nothing is written here: recording the fingerprint is the Host's job, and it
         * does that only when the test proved the deployment end to end.
         * @param candidate - the values to prove.
         * @returns whether the test passed.
         */
        const runTest = function (candidate: CandidatePatch): Promise<boolean> {
          setMessage(t('testing'))
          return fetch(TEST_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(candidate),
          })
            .then(async (response) => {
              const payload = (await response.json().catch(() => null)) as
                { ok?: boolean, hostKey?: unknown, error?: unknown, code?: unknown, evidence?: unknown } | null
              if (!response.ok || payload === null || payload.ok !== true) {
                // A failed test is a normal outcome the page explains, not an exception:
                // the sentence is composed here so it arrives in the page's language.
                setMessage(describeTestFailure(payload, response.status))
                return false
              }
              setMessage(t('testDone')
                .replace('{host}', String(candidate.user ?? '') + '@' + String(candidate.host ?? ''))
                .replace('{key}', typeof payload.hostKey === 'string' ? payload.hostKey : '—'))
              return true
            })
            .catch((error: unknown) => {
              // The request itself failed (the Host route is gone, or the page lost the
              // connection): that is not one of the stages, so it keeps its wording.
              setMessage(t('testFailed') + ' ' + (error instanceof Error ? error.message : String(error)))
              return false
            })
        }

        /** Prove the values currently on screen, because the operator asked. */
        const testNow = function (): void {
          const candidate = collectCandidate()
          setBusy(true)
          void runTest(candidate)
            .then(async (ok) => {
              if (ok) {
                setTestedDraft(JSON.stringify(candidate))
                await refresh()
              }
              setBusy(false)
            })
        }

        /**
         * Run the gate before a write that touches the tunnel.
         *
         * A configuration is allowed to persist only once a dial with exactly
         * those values has authenticated: the Host cannot check that later (it
         * only sees values), and a value that cannot connect is worth catching
         * here rather than as a tunnel that sits in `untested` afterwards.
         * @param candidate - the values the pending write would leave behind.
         * @returns whether the write may proceed.
         */
        const ensureTested = function (candidate: CandidatePatch): Promise<boolean> {
          if (testedDraft === JSON.stringify(candidate)) return Promise.resolve(true)
          setMessage(t('testNeedsSave'))
          return runTest(candidate).then((ok) => {
            if (ok) setTestedDraft(JSON.stringify(candidate))
            return ok
          })
        }

        /**
         * Whether this page may write the row's configuration.
         *
         * Three facts that actually exist: the Host document accepts writes, the
         * namespace's value was accepted by this client, and this page runs on the
         * operator's own machine. An earlier version tested
         * `snapshot.mode === 'host'` — DSH's form snapshot carries no such field,
         * so that condition was false everywhere and disabled every input on every
         * page, the loopback one included.
         */
        const writable = snapshot.writable && snapshot.status === 'ready' && isLoopbackPage()

        /** @returns the one reason this form is not editable, or null when it is. */
        const lockedReason = function (): string | null {
          if (writable) return null
          if (snapshot.status === 'unavailable') return t('unavailable')
          if (!snapshot.writable) return t('notWritable')
          if (!isLoopbackPage()) return t('readOnly')
          return snapshot.revision === undefined ? t('loadingRow') : t('badValue')
        }

        /**
         * The one piece of advice that fits the failure the Host classified.
         *
         * The kinds exist so this page can name the field to fix; ssh2's own wording
         * stays above it as the evidence, never as the instruction.
         * @param tunnel - the tunnel's live snapshot.
         * @returns the localized hint.
         */
        const hintFor = function (tunnel: NonNullable<Status['runtime']['tunnel']>): string {
          switch (tunnel.kind) {
            case 'key': return t('hintKey')
            case 'auth': return t('hintAuth')
            case 'host-key': return t('hintHostKey')
            case 'forward-refused': return t('hintForward')
            case 'local': return t('hintLocal')
            case 'dns':
            case 'unreachable':
            case 'handshake-timeout': return t('hintConfig')
            case 'dropped': return t('hintDropped')
            default: return t('tunnelFailedHint')
          }
        }

        /**
         * Why the fence refused this Host, in the operator's language.
         *
         * The Host's own `lastError` for a blocked tunnel is the English sentence it
         * prints on the console, and showing that as the page's explanation made a
         * localized page read half-translated. Every fact needed to say it properly
         * is in the payload (`fence`, `launch`, the published origin), so the page
         * says it itself and keeps the raw text only where it is the evidence.
         * @param live - the live status payload.
         * @returns the localized explanation.
         */
        const blockedExplanation = function (live: Status): string {
          const fence = live.runtime.fence
          if (fence === null) return t('blockedUnknown')
          const published = typeof live.effective.publicOrigin === 'string' ? hostOf(live.effective.publicOrigin) : null
          const authority = published ?? fence.authority
          if (fence.status !== 403) return t('blockedNoAnswer').replace('{status}', String(fence.status))
          // The launch facts arrive with a Host half that knows about them; a page
          // reloaded ahead of the row must not turn "not reported" into "you passed
          // no flag", which would send the operator to fix the wrong thing.
          const launch = live.runtime.launch
          if (launch === null || launch === undefined) return t('blockedNoFacts')
          const trusted = launch.trustedHosts
          if (trusted.length === 0) return t('blockedNoFlag').replace('{host}', authority)
          if (trusted.some(entry => entry.toLowerCase() === authority.toLowerCase())) {
            return t('blockedDespiteTrust').replace('{host}', authority)
          }
          return t('blockedWrongHost').replace('{host}', authority).replace('{trusted}', trusted.join(', '))
        }

        /** @returns validation problems keyed by field path. */
        const problems = function (): Record<string, string> {
          const found: Record<string, string> = {}
          for (const group of GROUPS) {
            for (const field of group.fields) {
              const touched = Object.prototype.hasOwnProperty.call(draft, field.path)
              // A required field that was never touched still has to be checked:
              // an empty box with no value anywhere is exactly the state that
              // leaves the deployment unconfigured, and it used to show no error
              // at all until the operator typed in it.
              if (!touched && !(field.required === true && valueOf(field.path) === '')) continue
              const problem = validate(field, touched ? draft[field.path] : '', t)
              if (problem !== null) found[field.path] = problem
            }
          }
          return found
        }

        /**
         * Write the pending operations through the Host's form.
         *
         * Called directly for a write the gate does not cover, so the common case
         * keeps the behaviour it always had: one `mutate`, no extra round trip.
         * @param ops - the operations to write.
         * @returns the write and its refresh.
         */
        const applyOps = function (ops: PathOp[]): Promise<void> {
          return form.mutate(ops)
            .then((accepted) => {
              setDraft({})
              setMessage(accepted ? t('saved') : t('saveFailed'))
              return refresh()
            })
        }

        const save = function (): void {
          const invalid = problems()
          const failed = Object.keys(invalid)
          if (failed.length > 0) {
            setMessage(t('saveFailed') + ' ' + failed.join(', '))
            return
          }
          const ops: PathOp[] = []
          for (const path of Object.keys(draft)) {
            const field = FIELDS.get(path)
            if (field === undefined) continue
            const text = draft[path]
            const own = isOwn(path)
            if (text === '') {
              if (own) ops.push({ op: 'unset', path: path.split('.') })
              continue
            }
            // "auto" is not a value: it means "drop my override and let the
            // three tunnel coordinates decide". Mapping it through the boolean
            // branch below turned it into an explicit `false`, so choosing
            // 「自动」 silently disabled the tunnel.
            if (field.kind === 'tristate' && text === 'inherit') {
              if (own) ops.push({ op: 'unset', path: path.split('.') })
              continue
            }
            const value = field.kind === 'number'
              ? Number(text)
              : field.kind === 'tristate' ? text === 'true' : text
            if (own && String(readPath(snapshot.user, path)) === String(value)) continue
            ops.push({ op: 'set', path: path.split('.'), value })
          }
          if (ops.length === 0) {
            setMessage(t('saved'))
            return
          }
          const touched = ops.map(op => op.path.join('.'))
          // Only a write that leaves the tunnel enabled with values it cannot
          // have proven needs the gate: a save that turns the tunnel off, or one
          // that edits the public origin, has nothing to dial.
          const needed = touched.some(path => GATED_PATHS.has(path)) && tunnelWillBeEnabled()
          setBusy(true)
          setMessage(null)
          if (!needed) {
            void applyOps(ops)
              .catch((error: unknown) => { setMessage(error instanceof Error ? error.message : String(error)) })
              .then(() => { setBusy(false) })
            return
          }
          void ensureTested(collectCandidate())
            .then((ok) => ok ? applyOps(ops) : undefined)
            .catch((error: unknown) => { setMessage(error instanceof Error ? error.message : String(error)) })
            .then(() => { setBusy(false) })
        }

        /** @param path - dotted form path to clear. */
        const resetField = function (path: string): void {
          setDraft((current) => {
            const next = { ...current }
            delete next[path]
            return next
          })
          if (!isOwn(path)) return
          const ops: PathOp[] = [{ op: 'unset', path: path.split('.') }]
          /** @returns the clearing write and its refresh. */
          const applyReset = (): Promise<void> =>
            form.mutate(ops).then(() => { setMessage(t('saved')); return refresh() })
          setBusy(true)
          // Clearing a passphrase changes the configuration just as much as
          // typing one, and the page cannot test it implicitly — the Host has to
          // be told "this row has none" out loud, so the candidate carries `null`.
          if (path !== 'tunnel.passphrase' || !tunnelWillBeEnabled()) {
            void applyReset()
              .catch((error: unknown) => { setMessage(error instanceof Error ? error.message : String(error)) })
              .then(() => { setBusy(false) })
            return
          }
          void ensureTested(collectCandidate({ passphrase: null }))
            .then((ok) => ok ? applyReset() : undefined)
            .catch((error: unknown) => { setMessage(error instanceof Error ? error.message : String(error)) })
            .then(() => { setBusy(false) })
        }

        /** @param id - credential id to remove. */
        const removePasskey = function (id: string): void {
          if (pendingRemove !== id) { setPendingRemove(id); return }
          setPendingRemove(null)
          setBusy(true)
          fetch(REMOVE_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          })
            .then(async (response) => {
              const payload = (await response.json().catch(() => null)) as { error?: unknown } | null
              if (!response.ok) throw new Error(payload && payload.error ? String(payload.error) : 'HTTP ' + String(response.status))
              setMessage(t('removed'))
              return refresh()
            })
            .catch((error: unknown) => { setMessage(error instanceof Error ? error.message : String(error)) })
            .then(() => { setBusy(false) })
        }

        const forgetHostKey = function (): void {
          setBusy(true)
          fetch(FORGET_PATH, { method: 'POST' })
            .then(async (response) => {
              const payload = (await response.json().catch(() => null)) as { error?: unknown } | null
              if (!response.ok) throw new Error(payload && payload.error ? String(payload.error) : 'HTTP ' + String(response.status))
              setMessage(t('forgetDone'))
              return refresh()
            })
            .catch((error: unknown) => { setMessage(error instanceof Error ? error.message : String(error)) })
            .then(() => { setBusy(false) })
        }

        /**
         * Re-dial the tunnel now instead of waiting out the backoff.
         *
         * The Host runs the same fence-checked starter the boot path uses, so this
         * can only re-dial what the deployment is allowed to serve — and its refusal
         * (the fence still says no) is shown as the reason rather than as a failure.
         */
        const retryTunnel = function (): void {
          setBusy(true)
          setMessage(t('retrying'))
          fetch(RETRY_PATH, { method: 'POST' })
            .then(async (response) => {
              const payload = (await response.json().catch(() => null)) as { error?: unknown } | null
              if (!response.ok) throw new Error(payload && payload.error ? String(payload.error) : 'HTTP ' + String(response.status))
              setMessage(t('retryStarted'))
              return refresh()
            })
            .catch((error: unknown) => { setMessage(t('retryFailed') + ' ' + (error instanceof Error ? error.message : String(error))) })
            .then(() => { setBusy(false) })
        }

        /**
         * End the sshd that still holds the tunnel port on the VPS.
         *
         * Only offered when the row switched it on, and only from the banner that
         * explains the refusal: the Host re-checks the switch and refuses to act on
         * any holder it cannot prove is an sshd, so this control cannot widen what
         * the plugin is allowed to do.
         */
        const releasePort = function (): void {
          setBusy(true)
          setMessage(t('releasing'))
          fetch(RELEASE_PATH, { method: 'POST' })
            .then(async (response) => {
              const payload = (await response.json().catch(() => null)) as { error?: unknown, detail?: unknown } | null
              if (!response.ok) throw new Error(payload && payload.error ? String(payload.error) : 'HTTP ' + String(response.status))
              setMessage(t('releaseDone') + (payload && payload.detail ? String(payload.detail) : ''))
              return refresh()
            })
            .catch((error: unknown) => { setMessage(t('releaseFailed') + ' ' + (error instanceof Error ? error.message : String(error))) })
            .then(() => { setBusy(false) })
        }

        /** @param url - the enrollment link to copy. */
        const copyLink = function (url: string): void {
          const clipboard = navigator.clipboard
          if (clipboard === undefined) { setMessage(t('copyFailed')); return }
          clipboard.writeText(url)
            .then(() => { setMessage(t('copied')) })
            .catch(() => { setMessage(t('copyFailed')) })
        }

        /** @param field - the field to render. */
        const renderField = function (field: FieldDef): ReactElement {
          const text = valueOf(field.path)
          const own = isOwn(field.path)
          const invalid = Object.prototype.hasOwnProperty.call(draft, field.path)
            ? validate(field, draft[field.path], t)
            : field.required === true && text === '' ? t('errRequired') : null
          const source = status === null ? undefined : status.sources[field.path]
          // A secret never rides back to the browser, so the row's own copy of it
          // cannot make `own` true; the provenance layer is what knows it is set.
          const overridden = own || source === 'patch'
          const badge = overridden
            ? t('sourcePatch')
            : source === 'default' ? t('sourceDefault') : t('sourceUnset')
          const hint = field.path === 'tunnel.passphrase' && status !== null && status.info.passphraseSet
            ? t('secretSet')
            : field.hint
          const change = (event: { target: { value: string } }): void => {
            const next = event.target.value
            setDraft((current) => ({ ...current, [field.path]: next }))
          }
          let control: ReactElement
          if (field.kind === 'tristate') {
            control = h('select', {
              className: 'sr-select', value: own && text !== '' ? text : 'inherit', onChange: change, disabled: !writable,
              'aria-label': field.zh,
            }, [
              h('option', { key: 'inherit', value: 'inherit' }, t('inherit')),
              h('option', { key: 'on', value: 'true' }, t('on')),
              h('option', { key: 'off', value: 'false' }, t('offValue')),
            ])
          } else if (field.kind === 'masked') {
            // A host address is not a secret the way a passphrase is, but it is
            // the one value here that names the operator's own infrastructure —
            // and this page is exactly what a screenshot of a bug report shows.
            const shown = revealed[field.path] === true
            control = h('div', { className: 'sr-masked' }, [
              h('input', {
                key: 'input',
                className: 'sr-input',
                type: shown ? 'text' : 'password',
                value: text,
                placeholder: hint === undefined || hint === t('secretSet') ? '' : hint,
                onChange: change,
                disabled: !writable,
                spellCheck: false,
                autoComplete: 'off',
                'aria-invalid': invalid !== null,
                'aria-label': field.zh,
              }),
              h('button', {
                key: 'eye',
                className: 'sr-btn eye',
                type: 'button',
                title: shown ? t('conceal') : t('reveal'),
                'aria-label': shown ? t('conceal') : t('reveal'),
                'aria-pressed': shown,
                onClick: () => { setRevealed({ ...revealed, [field.path]: !shown }) },
              }, shown ? '🙈' : '👁'),
            ])
          } else {
            control = h('input', {
              className: 'sr-input',
              type: field.kind === 'secret' ? 'password' : field.kind === 'number' ? 'number' : 'text',
              value: text,
              min: field.min,
              max: field.max,
              placeholder: hint === undefined || hint === t('secretSet') ? '' : hint,
              onChange: change,
              disabled: !writable,
              spellCheck: false,
              autoComplete: 'off',
              'aria-invalid': invalid !== null,
              'aria-label': field.zh,
            })
          }
          return h('div', { className: 'sr-row', key: field.path }, [
            h('div', { className: 'sr-label' }, [
              h('span', null, field.zh),
              h('span', { className: 'sr-badge' }, badge),
            ]),
            h('div', null, [
              control,
              invalid === null ? null : h('div', { className: 'sr-error' }, invalid),
              hint === undefined ? null : h('div', { className: 'sr-hint' }, hint),
              // No "reset" for a required field: there is no default to restore,
              // so the button could only delete the value and silently take the
              // deployment down. That is exactly what happened once.
              overridden && field.required !== true ? h('button', { className: 'sr-btn link', type: 'button', disabled: busy || !writable, onClick: () => { resetField(field.path) } }, t('reset')) : null,
            ]),
          ])
        }

        const facts: ReactNode[] = []
        facts.push(h('div', { className: 'sr-fact', key: 'gw' }, [
          h('span', { className: 'sr-dot' + (status !== null && status.runtime.gateway === 'listening' ? ' ok' : '') }),
          h('span', null, t('gateway') + ': ' + (status !== null && status.runtime.gateway === 'listening' ? t('listening') : t('off'))),
        ]))
        if (status !== null && status.runtime.tunnel !== null) {
          const tunnel = status.runtime.tunnel
          // The client bundle and the Host half reload independently (this plugin's
          // row restarts on save, and a page can outlive it), so every field added
          // later is read defensively: an older payload must render as "not there",
          // never as `(undefined)` or `下次重试 NaNs`.
          const kind = typeof tunnel.kind === 'string' && tunnel.kind !== '' ? ' (' + tunnel.kind + ')' : ''
          const stateText = tunnel.state === 'untested' ? t('untested') : tunnel.state + kind
          const retryAt = typeof tunnel.nextRetryAt === 'number' && Number.isFinite(tunnel.nextRetryAt) ? tunnel.nextRetryAt : null
          const countdown = retryAt === null
            ? ''
            : ' · ' + t('nextRetry') + ' ' + String(Math.max(0, Math.round((retryAt - Date.now()) / 1000))) + 's'
          facts.push(h('div', { className: 'sr-fact', key: 'tn' }, [
            h('span', { className: 'sr-dot' + (tunnel.state === 'listening' ? ' ok' : ' bad') }),
            h('span', null, t('tunnel') + ': ' + stateText
              + (tunnel.remote === null ? '' : ' → ' + tunnel.remote)
              + ' · ' + String(tunnel.attempts) + '×'
              + countdown),
          ]))
        }
        if (status !== null && status.runtime.fence !== null) {
          // The row says which refusal this is, in one line, from the facts the Host
          // reports: "you passed a different --trusted-host" is a different mistake
          // from "you passed none", and both are different from a fence that refuses
          // an authority its own launch arguments declare as trusted.
          const fence = status.runtime.fence
          const published = typeof status.effective.publicOrigin === 'string' ? hostOf(status.effective.publicOrigin) : null
          const trusted = status.runtime.launch?.trustedHosts ?? null
          const wrongHost = !fence.ok && trusted !== null && trusted.length > 0 && published !== null
            && !trusted.some(entry => entry.toLowerCase() === published.toLowerCase())
          facts.push(h('div', { className: 'sr-fact', key: 'fc' }, [
            h('span', { className: 'sr-dot' + (fence.ok ? ' ok' : ' bad') }),
            h('span', null, t('fence') + ': ' + (fence.ok ? t('fenceOk') : wrongHost ? t('fenceBadOtherHost') : t('fenceBad'))),
          ]))
        }

        const banners: ReactNode[] = []
        if (status !== null && status.configError !== null) {
          // Red means "your value was refused"; the reason is the value's fault.
          banners.push(h('div', { className: 'sr-banner error', key: 'cfg' }, status.configError))
        } else if (status !== null && !status.configured) {
          // Nothing is wrong yet — the operator simply has not named an origin.
          banners.push(h('div', { className: 'sr-banner warn', key: 'origin' }, t('needOrigin')))
        }
        // The one mismatch no server-side check can see. The tunnel's gate asks the
        // fence about the authority this plugin *publishes*; a page can only be read
        // at the authority the browser *typed*. Reaching this page at all means the
        // fence accepted that one, so a difference between the two means they are
        // published and trusted out of step — and a visitor using the published
        // address would be refused.
        //
        // Only for a page that is NOT the operator's own machine: reaching this page
        // on 127.0.0.1 while publishing a public domain is the normal way to edit it,
        // not a misconfiguration.
        const publishedHost = status !== null && typeof status.effective.publicOrigin === 'string'
          ? hostOf(status.effective.publicOrigin)
          : null
        const pageHost = (window as { location?: { host?: string } }).location?.host ?? null
        if (!isLoopbackPage() && publishedHost !== null && pageHost !== null && pageHost !== publishedHost) {
          banners.push(h('div', { className: 'sr-banner warn', key: 'host' },
            t('hostMismatch').replace('{here}', pageHost).replace('{published}', publishedHost)))
        }
        // A tunnel that keeps retrying is the one failure the page used to hide:
        // the state line said "reconnecting", and the reason only reached the
        // console the operator is not looking at.
        //
        // `blocked` is the one state with a reason of its own kind: nothing was
        // attempted and nothing is wrong with the tunnel, so it gets its own
        // sentence and never the ssh2 hint that would send the operator looking
        // at ports and keys instead of at the `dsh web` invocation.
        if (status !== null && status.runtime.tunnel !== null && status.runtime.tunnel.state === 'blocked') {
          banners.push(h('div', { className: 'sr-banner error', key: 'blocked' }, [
            h('div', null, t('tunnelBlocked')),
            // The explanation comes from the payload, in Chinese: the Host's own
            // sentence for this state is a console line, and pasting it here was the
            // only English on an otherwise localized page.
            h('div', { className: 'sr-hint' }, blockedExplanation(status)),
            h('div', { className: 'sr-hint' }, t('tunnelBlockedHint')),
          ]))
        } else if (status !== null && status.runtime.tunnel !== null && status.runtime.tunnel.state === 'untested') {
          // Not a failure: the values may be perfect, nobody has shown it yet.
          // The banner therefore carries the way out rather than ssh2's wording.
          banners.push(h('div', { className: 'sr-banner error', key: 'untested' }, [
            h('div', null, t('untestedTitle')),
            h('div', { className: 'sr-hint' }, t('untestedHint')),
            h('div', { className: 'sr-actions' }, [
              h('button', { className: 'sr-btn', type: 'button', disabled: busy, onClick: testNow }, busy ? t('testing') : t('test')),
            ]),
          ]))
        } else if (status !== null && status.runtime.tunnel !== null && status.runtime.tunnel.state !== 'listening'
          && status.runtime.tunnel.lastError !== null) {
          const tunnel = status.runtime.tunnel
          banners.push(h('div', { className: 'sr-banner error', key: 'tunnel' }, [
            h('div', null, t('tunnelFailed')),
            // Here the raw text IS the evidence (an ssh2 error nobody can translate
            // usefully), so it stays — labelled, so its language is explained.
            h('div', { className: 'sr-hint' }, t('rawReason')),
            h('code', null, tunnel.lastError),
            // The advice follows the classified kind, so the page names the field to
            // fix instead of handing over ssh2's wording and letting the operator
            // guess which of six values is wrong.
            h('div', { className: 'sr-hint' }, hintFor(tunnel)),
            tunnel.state === 'failed' ? h('div', { className: 'sr-hint' }, t('retriesStopped')) : null,
            tunnel.suspected === 'configuration' ? h('div', { className: 'sr-hint' }, t('suspectedConfig')) : null,
            h('div', { className: 'sr-actions' }, [
              h('button', { className: 'sr-btn', type: 'button', disabled: busy, onClick: retryTunnel }, busy ? t('retrying') : t('retry')),
              // The release control exists only where it is the right answer (a
              // refused remote forward) and only when the row switched it on: the
              // Host refuses either way, and offering a capability the deployment
              // does not have would be a lie the click would expose.
              tunnel.kind === 'forward-refused' && status.effective['tunnel.releaseStaleForward'] === true
                ? h('button', { className: 'sr-btn', type: 'button', disabled: busy, onClick: releasePort }, busy ? t('releasing') : t('release'))
                : null,
            ]),
          ]))
        }
        // One banner for one reason. Every branch names something the operator can
        // act on, so "the boxes are greyed out" never has to be guessed at.
        const locked = lockedReason()
        if (locked !== null) {
          banners.push(h('div', { className: 'sr-banner warn', key: 'ro' }, locked))
        }
        if (loadError !== null) {
          banners.push(h('div', { className: 'sr-banner warn', key: 'le' }, '/api/sync-remote.state → ' + loadError))
        }
        if (message !== null) {
          banners.push(h('div', { className: 'sr-banner', key: 'msg' }, message))
        }

        const groups = GROUPS.map((group, index) => {
          const fields = group.fields.map(renderField)
          const collapsible = index > 0
          const open = !collapsible || showTunnel
          return h('div', { className: 'sr-card', key: group.zh }, [
            collapsible
              ? h('div', { className: 'sr-head' }, [
                h('h3', null, group.zh),
                h('button', { className: 'sr-btn link', type: 'button', onClick: () => { setShowTunnel(!showTunnel) } }, open ? '−' : '+'),
              ])
              : h('h3', null, group.zh),
            open ? fields : null,
          ])
        })

        const infoRows: ReactNode[] = []
        if (status !== null) {
          const info = status.info
          const row = (key: string, label: string, value: string | null): ReactElement =>
            h('div', { className: 'sr-info-row', key }, [h('span', null, label), h('code', null, value ?? '—')])
          infoRows.push(row('bind', t('infoBind'), info.bind))
          infoRows.push(row('web', t('infoWeb'), info.web))
          infoRows.push(row('rpid', t('infoRpID'), info.rpID))
          infoRows.push(row('rpname', t('infoRpName'), info.rpName))
          infoRows.push(row('state', t('infoStateFile'), info.stateFile))
          infoRows.push(row('remote', t('infoRemoteBind'), info.remoteBind))
          infoRows.push(row('secure', t('infoSecure'), info.secureCookies ? t('infoSecureOn') : t('infoSecureOff')))
          infoRows.push(h('div', { className: 'sr-info-row', key: 'ssh' }, [
            h('span', null, t('infoSsh')),
            h('span', null, [
              h('code', null, info.sshEquivalent ?? t('infoSshNone')),
              info.sshEquivalent === null ? null : h('div', { className: 'sr-hint' }, t('infoSshHint')),
            ]),
          ]))
          infoRows.push(h('div', { className: 'sr-info-row', key: 'hostkey' }, [
            h('span', null, t('infoHostKey')),
            h('span', null, [
              h('code', null, info.hostKey ?? t('infoHostKeyNone')),
              info.hostKey === null ? null : h('button', {
                className: 'sr-btn link', type: 'button', disabled: busy || status.runtime.gateway !== 'listening',
                onClick: forgetHostKey,
              }, t('forget')),
            ]),
          ]))
        }

        const enrollment = status === null ? null : status.enrollment
        const enrollmentCard: ReactNode[] = []
        // `enrollment` is only non-null when `status` is — the compiler cannot see
        // through the temporary, so the null check is repeated.
        if (enrollment !== null && status !== null) {
          enrollmentCard.push(h('h3', { key: 'title' }, t('enrollTitle')))
          enrollmentCard.push(h('p', { key: 'hint' }, enrollment.enrolled ? t('enrollHintMore') : t('enrollHintEmpty')))
          enrollmentCard.push(h('div', { className: 'sr-actions', key: 'actions' }, [
            h('button', {
              className: 'sr-btn primary', type: 'button', disabled: busy,
              onClick: () => { mint(null) },
            }, busy ? t('minting') : (minted === null ? t('mint') : t('mintAgain'))),
            minted === null ? null : h('button', { className: 'sr-btn', type: 'button', onClick: () => { copyLink(minted.url) } }, t('copy')),
          ]))
          enrollmentCard.push(h('p', { className: 'sr-hint', key: 'replace' }, t('mintReplace')))
          if (minted !== null && minutesLeft(minted.expiresAt) > 0) {
            enrollmentCard.push(h('div', { className: 'sr-qr', key: 'qr' }, [
              h('img', { src: minted.qr, alt: t('enrollTitle'), width: 200, height: 200 }),
              h('div', { className: 'sr-link' }, [
                h('input', { className: 'sr-input', type: 'text', value: minted.url, readOnly: true, onFocus: (event: { target: { select(): void } }) => { event.target.select() } }),
                h('span', { className: 'sr-hint' }, t('remaining').replace('{n}', String(minutesLeft(minted.expiresAt)))),
              ]),
            ]))
          } else if (minted !== null) {
            // The countdown reached zero while the page was open: the link is
            // dead on the gateway too, so the QR goes away with it.
            enrollmentCard.push(h('p', { className: 'sr-hint', key: 'expired-now' }, t('expiredNow')))
          } else if (enrollment.pending) {
            enrollmentCard.push(h('p', { className: 'sr-hint', key: 'elsewhere' }, t('pendingElsewhere')))
          } else if (enrollment.enrolled) {
            enrollmentCard.push(h('p', { className: 'sr-hint', key: 'expired' }, t('expired')))
          } else {
            enrollmentCard.push(h('p', { className: 'sr-hint', key: 'none' }, t('noLinkYet')))
          }
          enrollmentCard.push(h('h3', { key: 'dev-title' }, t('devices')))
          if (status.passkeys.length === 0) {
            enrollmentCard.push(h('p', { className: 'sr-hint', key: 'dev-empty' }, t('noDevices')))
          } else {
            enrollmentCard.push(h('div', { className: 'sr-devices', key: 'dev-list' }, status.passkeys.map((passkey: PasskeyView) => {
              const meta = t('createdAt') + ' ' + new Date(passkey.createdAt).toLocaleString()
                + (passkey.lastUsedAt === null ? '' : ' · ' + t('lastUsed') + ' ' + new Date(passkey.lastUsedAt).toLocaleString())
                + (passkey.deviceType === null ? '' : ' · ' + passkey.deviceType)
              const last = status.passkeys.length <= 1
              return h('div', { className: 'sr-device', key: passkey.id }, [
                h('div', null, [
                  h('div', null, passkey.label === '' ? passkey.id.slice(0, 12) : passkey.label),
                  h('span', { className: 'meta' }, meta),
                ]),
                h('button', {
                  className: 'sr-btn',
                  type: 'button',
                  disabled: busy || last,
                  title: last ? t('removeLast') : '',
                  onClick: () => { removePasskey(passkey.id) },
                }, pendingRemove === passkey.id ? t('removeConfirm') : t('remove')),
              ])
            })))
          }
        }

        return h('div', { className: 'dsh-sync-remote' }, [
          h('div', { className: 'sr-head', key: 'head' }, [
            h('h2', null, t('title')),
            h('div', { className: 'sr-actions' }, [
              h('button', { className: 'sr-btn', type: 'button', onClick: () => { void refresh() } }, t('refresh')),
              // Dialing costs nothing and writes no configuration, so this one
              // control is not gated on the page being the editable, loopback one.
              h('button', { className: 'sr-btn', type: 'button', disabled: busy, onClick: testNow }, busy ? t('testing') : t('test')),
              h('button', { className: 'sr-btn primary', type: 'button', disabled: busy || !writable, onClick: save }, busy ? t('saving') : t('save')),
            ]),
          ]),
          h('p', { key: 'intro' }, t('intro')),
          h('div', { className: 'sr-card', key: 'facts' }, h('div', { className: 'sr-facts' }, facts)),
          banners.length === 0 ? null : h('div', { key: 'banners' }, banners),
          h('div', { key: 'groups' }, groups),
          h('div', { className: 'sr-card', key: 'info' }, [
            h('h3', null, t('infoTitle')),
            h('div', { className: 'sr-info' }, infoRows),
          ]),
          h('div', { className: 'sr-card', key: 'enroll' }, enrollmentCard),
        ])
      }
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx: PluginContext): void {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-sync-remote: dictionaries')
        ctx.effect(() => insertStyles(), 'dsh-sync-remote: styles')
        const form = ctx.configForms.get(NS)
        const Section = makeSection(t, form)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'sync-remote',
          order: 25,
          label: () => t('nav'),
          locale: NS,
        }, Section))
      },
    }
  },
})

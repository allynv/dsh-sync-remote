/**
 * Deployment acceptance for dsh-sync-remote.
 *
 * `node test/acceptance.mts [--local] [--port <gateway port>] [--state <state file>]`
 * (add `--local` to skip the public-origin checks).
 *
 * Nothing here is read from the environment any more, because the plugin reads
 * none: its settings live in the plugin row's `config` inside the profile patch,
 * the bind address is always 127.0.0.1, the local DSH Web port comes from the
 * row's `clientPort`, and the state file is fixed at
 * `<home>/.dsh/dsh-sync-remote/state.json`. So this script *discovers* the
 * deployment instead of being told about it: it reads the read-only status token
 * from the state file, asks `http://127.0.0.1:<port>/status` (header
 * `x-dsh-gw-status`) what the live gateway serves — `origin`, `rpID`,
 * `enrolled`, `passkeyCount`, `tunnel`,
 * `web` — and then checks that answer from the outside, including a real
 * WebSocket upgrade attempt, unless `--local` was passed or the origin is
 * loopback. That discovery call also proves what used to need its own check:
 * the state file this script read is the one the running gateway reads, because
 * only the token minted there opens the endpoint.
 *
 * `--config <json file>` is gone along with the environment it used to feed: the
 * status answer already states every value such a file could have supplied, so
 * keeping it would leave two competing sources of truth for the same facts.
 *
 * What it deliberately does not do is anything that needs an authenticator or a
 * second device: enrolling a passkey, signing in, and two-device sync stay
 * manual, and the report names them at the end.
 */

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as connectTcp } from 'node:net'
import { dirname, join } from 'node:path'
import { connect as connectTls } from 'node:tls'
import { defaultStateFile } from '../src/config.ts'
import { STATUS_PATH } from '../src/routes.ts'

const args = process.argv.slice(2)
const publicChecks = !args.includes('--local')

/** The only address the gateway binds, and the only one dialed from here. */
const LOOPBACK = '127.0.0.1'

/**
 * The gateway's own status path: a flat root path, not one of the GUI's `/api`
 * routes (those are the `STATUS_PATH` import above).
 */
const GATEWAY_STATUS_PATH = '/status'

/** Gateway port assumed when `--port` names none: the plugin's own default. */
const DEFAULT_GATEWAY_PORT = 3090

/** One recorded outcome, kept for the final tally. */
type Outcome = 'ok' | 'FAIL' | 'SKIP'

/** A plain response this script collected. */
interface PlainResponse {
  status: number | undefined
  headers: IncomingHttpHeaders
  body: string
}

/** The gateway status endpoint's report, as far as these checks read it. */
interface GatewayStatus {
  origin: string
  rpID: string
  enrolled: boolean
  passkeyCount: number
  tunnel: {
    state: string
    kind: string | null
    attempts: number
    channels: number
    everListening: boolean
    nextRetryAt: number | null
    suspected: string | null
    lastError: string | null
  } | null
  bind: string
  web: string
  secureCookies: boolean
  enrollmentPending: boolean
}

/** The state file as a JSON object; the fields below are checked before use. */
type StateDocument = Record<string, unknown>

const results: [Outcome, string, string][] = []
let failures = 0
let skipped = 0

/**
 * Print one actionable line and stop.
 *
 * A deployment this script cannot see is not a failed check: it is the absence
 * of anything to check, so it gets one sentence an operator can act on and no
 * stack trace, and the process exits non-zero.
 * @param message - the one line to print.
 * @returns never; the process exits.
 */
function fatal(message: string): never {
  console.log(`\n${message}`)
  process.exitCode = 1
  process.exit(1)
}

/** @param error - one thrown value. @returns its message, whatever it was. */
function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read one `--name value` argument.
 * @param name - the flag, such as `--port`.
 * @returns its value, or undefined when the flag is absent.
 */
function option(name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value: string | undefined = args[index + 1]
  if (value === undefined || value.startsWith('--')) fatal(`${name} needs a value: ${name} <value>`)
  return value
}

/** Whether an authority names loopback, so the public-leg checks would be meaningless. */
function isLoopbackAuthority(authority: string): boolean {
  const hostname = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0] ?? ''
  const bare = hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  return bare === 'localhost' || bare === '::1' || /^127\.\d+\.\d+\.\d+$/u.test(bare)
}

/**
 * Record one check.
 * @param label - what is being verified.
 * @param body - returns a short detail string; a throw fails the check.
 */
async function check(label: string, body: () => unknown): Promise<void> {
  try {
    const detail = await body()
    const text = typeof detail === 'string' ? detail : ''
    results.push(['ok', label, text])
    console.log(`ok    ${label}${text === '' ? '' : `\n        ${text}`}`)
  } catch (error) {
    failures += 1
    results.push(['FAIL', label, reasonFor(error)])
    console.log(`FAIL  ${label}\n        ${reasonFor(error)}`)
  }
}

/** Record one check that cannot run in this environment. */
function skip(label: string, why: string): void {
  skipped += 1
  results.push(['SKIP', label, why])
  console.log(`SKIP  ${label}\n        ${why}`)
}

/** Collect a plain HTTP response from one loopback listener. */
function plain(host: string, port: number, path: string, headers: Record<string, string>, method = 'GET', body?: string): Promise<PlainResponse> {
  return new Promise<PlainResponse>((resolve, reject) => {
    const req = httpRequest({ host, port, path, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.setTimeout(8000, () => { req.destroy(new Error('timed out')) })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** POST an empty JSON body, the shape every ceremony endpoint expects. */
function post(host: string, port: number, path: string, headers: Record<string, string>): Promise<PlainResponse> {
  return plain(host, port, path, { 'content-type': 'application/json', accept: 'application/json', ...headers }, 'POST', '{}')
}

/**
 * Collect one response from the public origin over the wire.
 *
 * Deliberately not `fetch`: the Fetch standard forbids setting `host`, so a
 * forged authority would be dropped before it ever left this process and the
 * forgery checks would silently become duplicates of an ordinary request.
 * @param origin - the public origin, as the gateway itself reported it.
 * @param path - path and query to request.
 * @param headers - request headers; a `host` key overrides the origin's authority.
 * @param method - HTTP method.
 * @returns the response.
 */
function publicRequest(origin: string, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<PlainResponse> {
  const url = new URL(path, origin)
  const secure = url.protocol === 'https:'
  const port = url.port === '' ? (secure ? 443 : 80) : Number(url.port)
  // No explicit `servername`: Node derives SNI from `host` and refuses to set it
  // to an IP, which is exactly what a loopback deployment uses.
  const options: RequestOptions = {
    host: url.hostname,
    port,
    path: `${url.pathname}${url.search}`,
    method,
    headers: { host: url.host, ...headers },
  }
  return new Promise<PlainResponse>((resolve, reject) => {
    const onResponse = (res: IncomingMessage): void => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    }
    const req = secure ? httpsRequest(options, onResponse) : httpRequest(options, onResponse)
    req.setTimeout(12_000, () => { req.destroy(new Error('timed out')) })
    req.on('error', reject)
    req.end()
  })
}

/** Read the status line of a WebSocket upgrade attempt, over TLS or plain TCP. */
function upgradeStatus(origin: string): Promise<string> {
  const url = new URL('/api/remote.mux', origin)
  const secure = url.protocol === 'https:'
  const port = url.port === '' ? (secure ? 443 : 80) : Number(url.port)
  return new Promise<string>((resolve) => {
    const socket = secure
      ? connectTls({ host: url.hostname, port, servername: url.hostname })
      : connectTcp({ host: url.hostname, port })
    let settled = false
    const finish = (value: string): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish('TIMEOUT'), 12_000)
    socket.on('error', (error) => { clearTimeout(timer); finish(`${(error as NodeJS.ErrnoException).code ?? error.name}: ${error.message}`) })
    if (secure) socket.once('secureConnect', send)
    else socket.once('connect', send)
    function send(): void {
      socket.write([
        'GET /api/remote.mux HTTP/1.1',
        `host: ${url.host}`,
        `origin: ${url.origin}`,
        'upgrade: websocket',
        'connection: Upgrade',
        `sec-websocket-key: ${randomBytes(16).toString('base64')}`,
        'sec-websocket-version: 13',
        '',
        '',
      ].join('\r\n'))
      let buffer = ''
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('latin1')
        if (buffer.includes('\r\n\r\n')) {
          clearTimeout(timer)
          finish(buffer.split('\r\n')[0] ?? 'no status line')
        }
      })
    }
  })
}

// ── discovery ───────────────────────────────────────────────────────────────

const portOption = option('--port')
const gatewayPort = portOption === undefined ? DEFAULT_GATEWAY_PORT : Number(portOption)
if (!Number.isSafeInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) {
  fatal(`--port must be a port number from 1 through 65535, got ${JSON.stringify(portOption ?? '')}`)
}
const stateFile = option('--state') ?? defaultStateFile()
const gatewayAuthority = `${LOOPBACK}:${String(gatewayPort)}`

const stateText = await readFile(stateFile, 'utf8').catch((error: unknown) => {
  fatal(`Cannot continue: cannot read the state file ${stateFile} (${reasonFor(error)}). `
    + `Check --state; the running plugin writes this file on its first start, and ${defaultStateFile()} is the fixed location.`)
})
let state: StateDocument
try {
  const parsed: unknown = JSON.parse(stateText)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('it is not a JSON object')
  state = parsed as StateDocument
} catch (error) {
  fatal(`Cannot continue: the state file ${stateFile} is not a state document this deployment can read (${reasonFor(error)}); check --state and do not hand-edit the file.`)
}
const statusToken = typeof state.statusToken === 'string' && state.statusToken !== '' ? state.statusToken : ''

/** The live gateway's own report, read once and reused by every check below. */
let report: GatewayStatus
try {
  // The token is the state file's read-only status token, not the Host header: a
  // reverse proxy that preserves the browser's Host makes `Host: 127.0.0.1`
  // forgeable, so the Host can never be the gate this script passes.
  const response = await plain(LOOPBACK, gatewayPort, GATEWAY_STATUS_PATH, { host: gatewayAuthority, 'x-dsh-gw-status': statusToken })
  if (response.status !== 200) throw new Error(`${GATEWAY_STATUS_PATH} answered HTTP ${String(response.status)}`)
  report = JSON.parse(response.body) as GatewayStatus
} catch (error) {
  const missing = statusToken === '' ? `${stateFile} holds no read-only status token (restart dsh once so it mints one), and ` : ''
  fatal(`Cannot continue: ${missing}the passkey gateway on ${gatewayAuthority} did not report its state (${reasonFor(error)}). `
    + 'Check --port, and read the port and public origin the running gateway resolved — and whether it is serving at all — in Settings → 远程访问 / Remote access.')
}

const publicOrigin = report.origin
const publicAuthority = new URL(publicOrigin).host
const web = new URL(report.web)
const targetHost = web.hostname
const targetAuthority = web.host
const targetPort = web.port === '' ? (web.protocol === 'https:' ? 443 : 80) : Number(web.port)

// ── the local halves ────────────────────────────────────────────────────────

await check('the local DSH Web server answers', async () => {
  const response = await plain(targetHost, targetPort, '/', { host: targetAuthority, accept: 'text/html' })
  if (response.status !== 401 && response.status !== 200) {
    throw new Error(`GET ${report.web}/ → HTTP ${String(response.status)}; is dsh web running on ${targetAuthority}?`)
  }
  return `HTTP ${String(response.status)}${response.body.includes('dsh web authentication') ? ' (DSH asking for its own sign-in)' : ''}`
})

await check('the passkey gateway reports the deployment it serves', () => {
  const origin = new URL(publicOrigin)
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    throw new Error(`the gateway reports origin ${JSON.stringify(publicOrigin)}, which is not an http(s) origin`)
  }
  if (origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') {
    throw new Error(`the gateway reports origin ${JSON.stringify(publicOrigin)}, which carries a path, query, or fragment`)
  }
  if (report.bind !== gatewayAuthority) {
    throw new Error(`the gateway reports bind ${report.bind}, but it answered on ${gatewayAuthority}; the bind address is always ${LOOPBACK}`)
  }
  if (report.rpID !== origin.hostname) {
    throw new Error(`the gateway reports rpID ${report.rpID}, but the origin it serves (${publicOrigin}) has hostname ${origin.hostname}; WebAuthn would refuse every ceremony`)
  }
  if (report.secureCookies !== publicOrigin.startsWith('https:')) {
    throw new Error(`the gateway reports secureCookies=${String(report.secureCookies)} for origin ${publicOrigin}; that flag is derived from the origin's scheme`)
  }
  const tunnel = report.tunnel
  if (tunnel !== null && tunnel.state !== 'disabled' && tunnel.state !== 'listening') {
    // `blocked` is the deliberate refusal: the plugin never requested a remote
    // forward because the GUI's fence refuses the public authority. It is the one
    // state whose cause is not in the tunnel at all, so it says so instead of
    // printing an empty `lastError`.
    const why = tunnel.state === 'blocked'
      ? 'the GUI refused the public Host, so the plugin opened no tunnel; restart dsh web with --trusted-host'
      : (tunnel.lastError ?? 'no error reported')
    throw new Error(`the tunnel is ${tunnel.state} (${why}); a configured tunnel must be listening`)
  }
  const tunnelNote = tunnel === null ? 'off' : `${tunnel.state} attempts=${String(tunnel.attempts)} channels=${String(tunnel.channels)}`
  // The classification is what the settings page turns into an instruction, so a
  // report that could not carry it (`kind`, plus the two facts behind the
  // escalation) would leave the page guessing — the failure this version fixed.
  if (tunnel !== null) {
    if (tunnel.kind !== null && typeof tunnel.kind !== 'string') {
      throw new Error(`the tunnel reports kind ${JSON.stringify(tunnel.kind)}, which is neither a classification name nor null`)
    }
    if (typeof tunnel.everListening !== 'boolean') {
      throw new Error(`the tunnel reports everListening=${JSON.stringify(tunnel.everListening)}; the page needs that fact to tell a typo from a reboot`)
    }
    if (tunnel.nextRetryAt !== null && !Number.isSafeInteger(tunnel.nextRetryAt)) {
      throw new Error(`the tunnel reports nextRetryAt=${JSON.stringify(tunnel.nextRetryAt)}, which is neither a timestamp nor null`)
    }
    if (tunnel.state === 'listening' && tunnel.kind !== null) {
      throw new Error(`the tunnel is listening while it still reports failure kind ${tunnel.kind}`)
    }
  }
  return `origin ${publicOrigin} · rpID ${report.rpID} · bind ${report.bind} · web ${report.web} · enrolled=${String(report.enrolled)} `
    + `passkeys=${String(report.passkeyCount)} · tunnel=${tunnelNote} · secureCookies=${String(report.secureCookies)} · enrollmentPending=${String(report.enrollmentPending)}`
})

await check('the state file holds a read-only status token and a passkeys array', () => {
  if (statusToken === '') throw new Error(`${stateFile} has no read-only status token`)
  if (!Array.isArray(state.passkeys)) throw new Error(`${stateFile} has no passkeys array`)
  const pinned = typeof state.sshHostKey === 'string' && state.sshHostKey !== '' ? ', and a pinned SSH host key' : ''
  return `${stateFile} holds ${String(state.passkeys.length)} passkey(s)${pinned}`
})

await check('the GUI trust fence accepts the authority browsers use', async () => {
  const response = await plain(targetHost, targetPort, '/api', { host: publicAuthority, accept: 'application/json' })
  if (response.status === 403) {
    throw new Error(`the fence refused Host ${publicAuthority}; start the GUI with --trusted-host ${publicAuthority} (and --public-url ${publicOrigin}/)`)
  }
  if (response.status !== 401) throw new Error(`expected 401 for an unauthenticated /api request, got ${String(response.status)}`)
  return `Host ${publicAuthority} is trusted; the unauthenticated answer is 401`
})

await check('an untrusted Host is still refused (the fence is doing its job)', async () => {
  const response = await plain(targetHost, targetPort, '/api', { host: 'fence-probe.invalid', accept: 'application/json' })
  if (response.status !== 403) throw new Error(`expected 403 for an untrusted Host, got ${String(response.status)}`)
  return 'a Host outside the trusted set gets 403'
})

await check('a refused fence means no listener, not a broken login page', async () => {
  // The invariant worth more than any single fact above: if the GUI refuses the
  // authority browsers use, this plugin must never have asked the VPS to listen.
  // The deployment this check was written for was live, authenticated, and
  // unusable — a remote visitor reached a login page in front of an `/api` that
  // answered 403 to everything. Both facts are read now, in one moment, so a
  // stale report cannot make them look consistent.
  const fence = await plain(targetHost, targetPort, '/api', { host: publicAuthority, accept: 'application/json' })
  const fresh = await plain(LOOPBACK, gatewayPort, GATEWAY_STATUS_PATH, { host: gatewayAuthority, 'x-dsh-gw-status': statusToken })
  if (fresh.status !== 200) throw new Error(`${GATEWAY_STATUS_PATH} answered HTTP ${String(fresh.status)} on the second read`)
  const tunnel = (JSON.parse(fresh.body) as GatewayStatus).tunnel
  const state = tunnel === null ? 'off' : tunnel.state
  if (fence.status === 403 && state === 'listening') {
    throw new Error(`the fence refuses ${publicAuthority} (403) while the tunnel is listening: a remote visitor reaches a login page in front of an /api that 403s everything`)
  }
  if (fence.status === 401 && state !== 'listening' && state !== 'disabled') {
    throw new Error(`the fence accepts ${publicAuthority} (401) but the tunnel is ${state}: the public entry point should be up (${tunnel?.lastError ?? 'no error reported'})`)
  }
  return `fence ${String(fence.status)} → tunnel ${state}${fence.status === 403 ? ' (nothing exposed, deliberately)' : ''}`
})

await check('the gateway refuses unauthenticated access to its own endpoints', async () => {
  const denied = await post(LOOPBACK, gatewayPort, '/passkeys/remove', { host: gatewayAuthority })
  const login = await plain(LOOPBACK, gatewayPort, '/signin', { host: gatewayAuthority, accept: 'text/html' })
  if (login.status !== 200 || !String(login.headers['content-security-policy']).includes("default-src 'none'")) {
    throw new Error('the login page is not served with its content-security-policy')
  }
  if (denied.status !== 401) throw new Error(`/passkeys/remove without a session → ${String(denied.status)}, expected 401`)
  return 'passkey management without a session → 401; the login page carries a CSP'
})

await check('enrollment cannot begin without a one-time link', async () => {
  // The one-time rule of this design: there is no permanent enrollment secret,
  // so a caller with neither a grant cookie nor a session has nothing to present
  // and must be refused here rather than handed registration options.
  const denied = await post(LOOPBACK, gatewayPort, '/enroll/options', { host: gatewayAuthority })
  if (denied.status !== 403) {
    throw new Error(`/enroll/options without a grant or session → ${String(denied.status)}, expected 403; the gate must not accept a permanent token`)
  }
  return `enroll/options without a grant → 403${report.enrollmentPending ? ' (a link is pending, and it is still not enough without presenting it)' : ''}`
})

await check('the ceremony endpoints match the current enrollment state', async () => {
  const options = await post(LOOPBACK, gatewayPort, '/auth/options', { host: gatewayAuthority })
  if (report.enrolled) {
    if (options.status !== 200) throw new Error(`authentication options → ${String(options.status)}, expected 200 for an enrolled gateway`)
    return `${String(report.passkeyCount)} passkey(s): authentication options are issued`
  }
  if (options.status !== 400 || !options.body.includes('no passkey is registered')) {
    throw new Error(`authentication options → ${String(options.status)} ${JSON.stringify(options.body.slice(0, 80))}; expected 400 until a passkey is enrolled`)
  }
  return 'not enrolled yet: mint a one-time link in Settings → Remote access and register a device'
})

await check('the status endpoint answers only for the read-only token', async () => {
  const bare = await plain(LOOPBACK, gatewayPort, '/status', { host: publicAuthority })
  if (bare.status !== 403) throw new Error(`status without the token → ${String(bare.status)}, expected 403 whatever the Host says`)
  for (const forged of ['127.0.0.1', gatewayAuthority]) {
    const response = await plain(LOOPBACK, gatewayPort, '/status', { host: forged })
    if (response.status !== 403) throw new Error(`a forged Host ${forged} answered ${String(response.status)}, expected 403`)
  }
  const withToken = await plain(LOOPBACK, gatewayPort, '/status', { host: publicAuthority, 'x-dsh-gw-status': statusToken })
  if (withToken.status !== 200) throw new Error(`status with the token → ${String(withToken.status)}, expected 200`)
  return 'the Host header is not the gate; only the read-only token is'
})

await check('the upstream fence probe decides this deployment is usable', async () => {
  // The probe the plugin itself runs at startup: an unauthenticated /api request
  // carrying the authority browsers use. 401 is "the fence accepts this
  // authority"; 403 is the --trusted-host misconfiguration the plugin logs.
  if (targetPort === gatewayPort && targetHost === LOOPBACK) {
    throw new Error(`the gateway reports web ${report.web}, which is the gateway's own listener; the plugin would only ever probe itself`)
  }
  const response = await plain(targetHost, targetPort, '/api', { host: publicAuthority, accept: 'application/json' })
  if (response.status !== 401) {
    throw new Error(`GET ${report.web}/api with Host ${publicAuthority} → HTTP ${String(response.status)}; the plugin's startup probe expects 401 (accepting), and 403 means --trusted-host is missing`)
  }
  return `GET ${report.web}/api with Host ${publicAuthority} → 401, the answer the plugin classifies as "the fence accepts this authority"`
})

await check('a malformed ceremony body is rejected without a stack trace', async () => {
  const response = await plain(
    LOOPBACK,
    gatewayPort,
    '/auth/verify',
    { host: gatewayAuthority, 'content-type': 'application/json', accept: 'application/json' },
    'POST',
    'not json',
  )
  if (response.status !== 400) throw new Error(`POST /auth/verify with a malformed body → ${String(response.status)}, expected 400`)
  let named: unknown
  try {
    named = (JSON.parse(response.body) as { error?: unknown }).error
  } catch {
    throw new Error(`the refusal was not JSON: ${JSON.stringify(response.body.slice(0, 80))}`)
  }
  if (typeof named !== 'string' || !named.includes('not valid JSON')) {
    throw new Error(`the refusal did not name the malformed body: ${JSON.stringify(String(named))}`)
  }
  if (response.body.includes('\n    at ') || response.body.includes('node:internal')) {
    throw new Error('the refusal carried a stack trace')
  }
  return 'the body is refused as JSON, with a message a browser can show'
})

// ── the public leg ──────────────────────────────────────────────────────────

if (!publicChecks) {
  skip('the public origin answers over HTTPS', '--local was passed')
  skip('an unauthenticated navigation is redirected to the login page', '--local was passed')
  skip('the public /api is refused without a passkey session', '--local was passed')
  skip('a WebSocket upgrade through the proxy is refused without a session', '--local was passed')
  skip('the public status endpoint refuses a remote caller', '--local was passed')
  skip('the settings status route refuses a remote caller to the gate', '--local was passed')
} else if (isLoopbackAuthority(publicAuthority)) {
  skip('the public-leg checks', `the discovered origin ${publicOrigin} is loopback, so there is no public leg to test; re-run once the deployment names its real hostname in Settings → Remote access`)
} else {
  await check('the public origin answers over HTTPS', async () => {
    const response = await publicRequest(publicOrigin, '/signin', { accept: 'text/html' })
    if (response.status !== 200) throw new Error(`GET ${publicOrigin}/signin → HTTP ${String(response.status)}`)
    const csp = response.headers['content-security-policy']
    if (!String(csp).includes("default-src 'none'")) throw new Error('the public login page is missing its CSP')
    if (!response.body.includes('/app.js')) throw new Error('the public login page does not reference its script')
    return 'the login page is reachable and intact through Nginx and the tunnel'
  })

  await check('an unauthenticated navigation is redirected to the login page', async () => {
    const response = await publicRequest(publicOrigin, '/', { accept: 'text/html' })
    if (response.status !== 303) throw new Error(`GET / → HTTP ${String(response.status)} (expected 303)`)
    const location = response.headers.location
    if (location !== '/signin') throw new Error(`GET / redirected to ${String(location)}, expected /signin`)
    return 'the gate answers before the GUI does'
  })

  await check('the public /api is refused without a passkey session', async () => {
    const response = await publicRequest(publicOrigin, '/api', { accept: 'application/json' })
    if (response.status !== 401) throw new Error(`GET /api → HTTP ${String(response.status)} (expected 401)`)
    if (!response.body.includes('passkey authentication required')) {
      throw new Error(`/api answered ${JSON.stringify(response.body.slice(0, 80))}; the request reached the GUI instead of the gate`)
    }
    return 'the gate answers 401 and never forwards the request'
  })

  await check('a WebSocket upgrade through the proxy is refused without a session', async () => {
    const status = await upgradeStatus(publicOrigin)
    if (status === 'TIMEOUT') {
      throw new Error('no answer to the upgrade; Nginx must forward Upgrade/Connection (proxy_http_version 1.1 and the Upgrade map)')
    }
    if (status !== 'HTTP/1.1 401 Unauthorized') {
      throw new Error(`upgrade answered ${status}; expected the gate's 401`)
    }
    return 'the upgrade path is gated too, so the realtime channel cannot be reached unauthenticated'
  })

  await check('the public status endpoint refuses a remote caller', async () => {
    const response = await publicRequest(publicOrigin, '/status')
    if (response.status !== 403) throw new Error(`GET /status → HTTP ${String(response.status)} (expected 403)`)
    const forged = await publicRequest(publicOrigin, '/status', { host: LOOPBACK })
    if (forged.status !== 403) throw new Error(`a forged loopback Host answered HTTP ${String(forged.status)} (expected 403)`)
    return 'passkey labels and tunnel state are not readable from the internet, forged Host or not'
  })

  await check('the settings status route refuses a remote caller to the gate', async () => {
    // That payload carries the enrollment link, which is a credential. Reaching
    // the GUI's own /api would already mean the passkey gate let it through, so
    // anything other than the gate's 401 is a regression worth failing on.
    const response = await publicRequest(publicOrigin, STATUS_PATH, { accept: 'application/json' })
    if (response.status !== 401) throw new Error(`GET ${STATUS_PATH} → HTTP ${String(response.status)} (expected the gate's 401)`)
    // The gate's 401 is a short fixed line; a real token would be long and
    // URL-safe. Asserting the *shape* is what survives a rename, where matching a
    // path that no longer exists would pass without testing anything.
    if (/[?&]token=[A-Za-z0-9_-]{10,}/u.test(response.body)) throw new Error('an enrollment token was served to an unauthenticated caller')
    return 'the enrollment link is never reachable without a passkey session'
  })
}

// ── the manual remainder ────────────────────────────────────────────────────

const enrollFile = join(dirname(stateFile), 'enroll-url.txt')
console.log('\n— still manual, because it needs an authenticator or a second device —')
console.log('  0. Open Settings → 远程访问 / Remote access in the GUI.')
console.log('     expect: the panel names the public origin, the tunnel port, and the local DSH Web port,')
console.log('             shows the read-only derived values (bind 127.0.0.1, the state file, the RP ID),')
console.log('             reports the tunnel\'s state, and lists the devices already registered.')
if (report.enrolled) {
  console.log(`  1. ${String(report.passkeyCount)} passkey(s) are already registered. To add another device,`)
  console.log('     press 生成注册二维码 / Mint enrollment link in that page and scan the QR on the new device.')
  console.log('     expect: the link works for exactly one registration and then expires; a second scan is refused.')
} else {
  console.log('  1. No passkey is registered yet. Press 生成注册二维码 / Mint enrollment link in')
  console.log('     Settings → Remote access, then scan the QR (or open the link it shows) on the device you will use.')
  console.log('     expect: the browser offers fingerprint / face / PIN, then lands in DSH. The link works once')
  console.log('             and expires, so a second device needs a freshly minted link.')
  if (report.enrollmentPending) console.log('     a one-time link is pending right now, until it is used or it expires.')
}
console.log(`     while a link is pending it is also written to ${enrollFile}; that file disappears with the link.`)
console.log(`  2. Sign in a second time (e.g. a private window) with ${publicOrigin}/`)
console.log('     expect: redirected to the login page, passkey prompt, then back to where you were.')
console.log('  3. Open the GUI on two devices at once and send a prompt on one.')
console.log('     expect: the other updates live (that is /api/remote.mux).')
console.log('  4. In DevTools → Application → Cookies, check the session cookie:')
console.log('     expect: HttpOnly, Secure, SameSite=Strict, name dsh-gw-session.')
console.log('  5. Break the network to the VPS for a minute and restore it.')
console.log('     expect: the dsh log shows "tunnel lost … reconnecting in … ms" and then "listening …" again.')
console.log('  6. Point the tunnel\'s privateKeyFile at the wrong file, or its user at a wrong name, in')
console.log('     Settings → Remote access, and read the dsh log.')
console.log('     expect: a clear authentication failure and NO endless reconnect loop.')

const verdict = failures === 0 ? 'PASS' : 'FAIL'
console.log(`\n${verdict}: ${String(results.filter(r => r[0] === 'ok').length)} passed, ${String(failures)} failed, ${String(skipped)} skipped`)
process.exitCode = failures === 0 ? 0 : 1

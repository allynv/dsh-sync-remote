/**
 * Self-check for dsh-sync-remote.
 *
 * Run with `node test/selfcheck.mts` (no test runner, no dependencies beyond
 * the plugin's own). It exercises the real modules over real sockets: the
 * gateway talks to a stand-in upstream that records the headers it received, a
 * raw TCP client performs the WebSocket handshake through the proxy, and the
 * config/state/cookie modules are driven with bad input as well as good.
 *
 * A passkey ceremony cannot run here — that needs an authenticator — so the
 * authenticated paths mint a session cookie exactly as the verify endpoint does,
 * and the ceremony endpoints themselves are checked for their refusal paths.
 */

import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import { connect as connectTcp } from 'node:net'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { ConfigError, defaultStateFile, resolveConfig, type ResolvedConfig } from '../src/config.ts'
import { createSession, parseCookieHeader, verifyEnrollment, verifySession, verifyValue, SESSION_COOKIE } from '../src/session-cookie.ts'
import { StateStore, loadState, loadStateOrCreate } from '../src/state.ts'
import { ENROLL_TOKEN_TTL_MS, Gateway, LOCAL_PATHS, safeNextPath } from '../src/gateway.ts'
import { PasskeyService } from '../src/webauthn.ts'
import { APP_JS } from '../src/pages.ts'
import { TunnelManager, classifySshFailure, describeForwardFailure, fingerprintMatches, hostKeyFingerprints, portAccepts, type TunnelManagerOptions } from '../src/tunnel.ts'
import { fuserProbeCommand, killCommand, parseFuserHolders, parseSshdHolders, planRelease, ssProbeCommand } from '../src/remote-release.ts'
import { toBase64Url } from '../src/encoding.ts'
import { apply, type ConnectionContext, type PluginContext } from '../src/index.ts'
import { Config, provenance } from '../src/config.ts'
import { qrDataUrl } from '../src/qr.ts'
import {
  ENROLL_MINT_PATH, PASSKEY_REMOVE_PATH, STATUS_PATH, TRUST_FORGET_PATH, TUNNEL_RELEASE_PATH, TUNNEL_RETRY_PATH, registerRoutes,
  type FetchRoute, type RouteSource,
} from '../src/routes.ts'
import { buildStatus, sshEquivalent } from '../src/status.ts'
import type { Logger } from '../src/types.ts'
import ssh2 from 'ssh2'

let failures = 0
let checks = 0

/** The shape one request helper hands back. */
interface PlainResponse {
  status: number | undefined
  headers: IncomingHttpHeaders
  body: string
}

/** Everything the request helper accepts. */
interface RequestOptions {
  method?: string
  path?: string
  headers?: Record<string, string>
  body?: string
}

/** One silent logger, for the objects under test. */
const silentLog: Logger = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * Run one named check.
 * @param label - what is being checked.
 * @param body - the check itself; a throw is a failure.
 */
async function check(label: string, body: () => unknown): Promise<void> {
  checks += 1
  try {
    await body()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${label}\n     ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Wait for a condition that an asynchronous path fulfils, instead of sleeping a
 * fixed guess. A fixed sleep is a test that fails on a loaded machine and blames
 * the product for it.
 * @param predicate - the condition to wait for.
 * @param timeoutMs - how long to keep asking.
 * @returns whether the condition became true.
 */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  return predicate()
}

/**
 * The same, for a condition only a filesystem call can answer.
 * @param predicate - the asynchronous condition to wait for.
 * @param timeoutMs - how long to keep asking.
 * @returns whether the condition became true.
 */
async function untilAsync(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  return await predicate()
}

/**
 * Capture what this process writes to the console — the stream an operator
 * running `dsh web` actually sees, and therefore the one the plugin's
 * operator-facing lines must use.
 * @param lines - array the captured lines are appended to.
 * @returns a function restoring the original console methods.
 */
function captureConsole(lines: string[]): () => void {
  const originals = { log: console.log, warn: console.warn, error: console.error }
  const wrap = (level: string) => (...args: unknown[]) => { lines.push(`${level} ${args.map(String).join(' ')}`) }
  console.log = wrap('info')
  console.warn = wrap('warn')
  console.error = wrap('error')
  let restored = false
  const restore = (): void => {
    if (restored) return
    restored = true
    console.log = originals.log
    console.warn = originals.warn
    console.error = originals.error
  }
  // A check that dies before its `finally` must not swallow every later line.
  process.once('exit', restore)
  return restore
}

/** Send one HTTP request and collect its body. */
function request(port: number, options: RequestOptions): Promise<PlainResponse> {
  return new Promise<PlainResponse>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: options.path ?? '/',
      headers: options.headers ?? {},
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

/** Start an HTTP server on an ephemeral loopback port. */
function listen(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve((server.address() as AddressInfo).port)
    })
  })
}

/**
 * A port to hand to `apply()` as `serverPort`.
 *
 * Deliberately NOT "bind an ephemeral port, close it, reuse the number": that
 * pattern releases a port the OS just handed out (Windows keeps it reserved for a
 * while) and then immediately asks for it back, so a check can fail with
 * EADDRINUSE for reasons that have nothing to do with the plugin. Instead pick a
 * fixed-range candidate outside the ephemeral range, verify it is free, and use
 * it; a collision is still possible but no longer self-inflicted.
 */
async function serverPortForTest(): Promise<number> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const candidate = 20_000 + Math.floor(Math.random() * 25_000)
    const probe = createServer(() => {})
    const free = await new Promise<boolean>((resolve) => {
      probe.once('error', () => { resolve(false) })
      probe.listen(candidate, '127.0.0.1', () => { probe.close(() => { resolve(true) }) })
    })
    if (free) return candidate
  }
  throw new Error('no free port in the test range')
}

/**
 * A complete resolved configuration, so a check can override one field without
 * restating the other thirteen.
 * @param overrides - fields this check cares about.
 * @returns the configuration.
 */
function testConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    publicOrigin: 'https://dsh.example.test',
    rpID: 'dsh.example.test',
    rpName: 'DeepSeek Harness',
    bindHost: '127.0.0.1',
    loopbackHost: '127.0.0.1',
    serverPort: 0,
    target: { host: '127.0.0.1', port: 9 },
    sessionTtlHours: 720,
    stateFile: join(process.cwd(), '.selfcheck-state.json'),
    secureCookies: true,
    tunnel: {
      enabled: false,
      host: null,
      port: 22,
      user: null,
      privateKeyFile: null,
      passphrase: undefined,
      remoteHost: '127.0.0.1',
      remotePort: 3090,
      keepaliveIntervalMs: 30_000,
      keepaliveCountMax: 3,
      readyTimeoutMs: 2_000,
      reconnectMaxDelayMs: 50,
      suspectedReconnectMaxDelayMs: 50,
      releaseStaleForward: false,
      maxChannels: 8,
    },
    ...overrides,
  }
}

/**
 * Tunnel options whose configuration only carries the tunnel half, which is all
 * the manager reads.
 * @param overrides - tunnel fields this check cares about.
 * @param local - where the gateway listener is, for connections that land.
 * @returns the options.
 */
function tunnelOptions(overrides: Partial<ResolvedConfig['tunnel']>, local = { host: '127.0.0.1', port: 1 }): TunnelManagerOptions {
  return { config: testConfig({ tunnel: { ...testConfig().tunnel, ...overrides } }), local, store: new StateStore(join(process.cwd(), '.selfcheck-tunnel.json')), log: silentLog }
}

/** A host context that records what a plugin logged and what it registered. */
interface HarnessContext {
  context: PluginContext
  lines: string[]
  effects: (() => void | Promise<void>)[]
  release: () => void
  /** Fetch routes the plugin registered through `ctx.inject(['connection'])`. */
  routes: FetchRoute[]
  /** Base URLs the plugin asked the Host to authenticate, in call order. */
  authBases: string[]
  /** Run the context's pending `inject` callbacks against a stand-in connection. */
  connect(): void
}

/**
 * Build the context one `apply()` check needs, capturing the console stream the
 * plugin reports on and the routes it registers.
 * @param token - the launch token this stand-in connection hands out, so a check
 * can prove the plugin reads the live one rather than a string it baked in.
 * @param loader - the Host's Loader stand-in, when a check needs the plugin to
 * wait for boot; omitting it is a hand-built context, already fully mounted.
 * @param services - extra Host services `ctx.get` should answer, e.g. the
 * `webStartup` facts the fence message reads.
 * @returns the context, its captured lines, its registered effects, its routes, and the restore hook.
 */
function harnessContext(
  token = 'test-process-token',
  loader?: { await(): Promise<unknown> },
  services: Record<string, unknown> = {},
): HarnessContext {
  const lines: string[] = []
  const effects: (() => void | Promise<void>)[] = []
  const routes: FetchRoute[] = []
  const authBases: string[] = []
  const pending: ((ctx: ConnectionContext) => void)[] = []
  const context: PluginContext = {
    effect: (body) => { effects.push(body()) },
    inject: (_names, callback) => { pending.push(callback); return undefined },
    get: (name: string) => (name === 'loader' ? loader : services[name]),
  }
  return {
    context,
    lines,
    effects,
    routes,
    authBases,
    release: captureConsole(lines),
    connect: () => {
      for (const callback of pending.splice(0)) {
        callback({
          connection: {
            fetch: { register: (route) => { routes.push(route); return undefined } },
            authenticatedUrl: (base) => {
              authBases.push(base)
              return `${base}?token=${token}`
            },
          },
        })
      }
    },
  }
}

/**
 * Set environment variables for one check and restore them afterwards.
 * @param env - the variables to set.
 * @param body - the check body.
 * @returns whatever the body returned.
 */
async function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  try {
    return await body()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/**
 * Set environment variables for one synchronous body and restore them after.
 * @param env - the variables to set.
 * @param body - the body to run.
 * @returns whatever the body returned.
 */
function withEnvSync<T>(env: Record<string, string>, body: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  try {
    return body()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const workdir = await mkdtemp(join(process.cwd(), '.selfcheck-'))

// ── pure modules ────────────────────────────────────────────────────────────

await check('safeNextPath accepts a path and refuses redirect tricks', () => {
  assert.equal(safeNextPath('/sessions?x=1'), '/sessions?x=1')
  assert.equal(safeNextPath('//evil.example'), undefined)
  assert.equal(safeNextPath('https://evil.example/'), undefined)
  assert.equal(safeNextPath('/\\evil'), undefined)
  assert.equal(safeNextPath('/signin'), undefined)
  assert.equal(safeNextPath(''), undefined)
})

await check('session cookies round-trip and reject tampering', () => {
  const secret = toBase64Url(randomBytes(32))
  const session = createSession(secret, { ttlMs: 60_000, credentialId: 'cred-1', audience: 'session' })
  assert.equal(verifySession(session.value, secret)?.credentialId, 'cred-1')
  // Capability binding: the return-path cookie and the enrollment grant are
  // signed with the same secret, and neither may ever pass as a session. Before
  // this check existed, one anonymous `Accept: text/html` request was enough to
  // harvest a `dsh-gw-next` value that then authorized a full session.
  const next = createSession(secret, { ttlMs: 60_000, credentialId: 'next', audience: 'next' })
  assert.equal(verifySession(next.value, secret), undefined, 'a next cookie must never authorize a session')
  assert.equal(verifySession(next.value, secret, Date.now(), 'next')?.credentialId, 'next')
  const grant = createSession(secret, { ttlMs: 60_000, credentialId: 'enrollment', audience: 'enrollment' })
  assert.equal(verifySession(grant.value, secret), undefined, 'an enrollment grant must never authorize a session')
  assert.equal(verifyEnrollment(grant.value, secret)?.audience, 'enrollment')
  assert.equal(verifyEnrollment(session.value, secret), undefined, 'a session must never act as an enrollment grant')
  assert.equal(verifySession(session.value, toBase64Url(randomBytes(32))), undefined)
  const parts = session.value.split('.')
  assert.equal(verifySession(`${parts[0]}.${parts[1]}.${toBase64Url(randomBytes(32))}`, secret), undefined)
  assert.equal(verifySession(session.value, secret, session.expiresAt + 1), undefined)
  assert.equal(verifyValue('v2.a.b', secret), undefined)
  assert.equal(verifyValue('garbage', secret), undefined)
})

await check('parseCookieHeader keeps the first of a repeated name', () => {
  const jar = parseCookieHeader('a=1; b=2; a=3; weird; c=')
  assert.equal(jar.get('a'), '1')
  assert.equal(jar.get('b'), '2')
  assert.equal(jar.get('c'), '')
  assert.equal(jar.size, 3)
})

await check('resolveConfig reads the row and derives what the operator cannot set', () => {
  const config = resolveConfig({
    publicOrigin: 'https://dsh.example.com',
    serverPort: 4090,
    clientPort: 4091,
    sessionTtlHours: 24,
    tunnel: { host: 'vps.example', user: 'dsh', privateKeyFile: '/k/id_ed25519', port: 2222 },
  })
  assert.equal(config.publicOrigin, 'https://dsh.example.com')
  assert.equal(config.rpID, 'dsh.example.com')
  assert.equal(config.rpName, 'DeepSeek Harness')
  assert.equal(config.serverPort, 4090)
  assert.equal(config.bindHost, '127.0.0.1')
  assert.equal(config.target.host, '127.0.0.1')
  assert.equal(config.target.port, 4091)
  assert.equal(config.sessionTtlHours, 24)
  assert.equal(config.tunnel.enabled, true)
  assert.equal(config.tunnel.host, 'vps.example')
  assert.equal(config.tunnel.port, 2222)
  // The VPS-side bind and port follow the gateway's: one port for Nginx to name.
  assert.equal(config.tunnel.remoteHost, '127.0.0.1')
  assert.equal(config.tunnel.remotePort, 4090)
  assert.equal(config.secureCookies, true)
  // Every value with a box in the form is required, so a minimal row names all
  // of them; nothing here is inherited from a default in the code.
  const bare = resolveConfig({ publicOrigin: 'http://127.0.0.1:3090', serverPort: 3090, clientPort: 3080, sessionTtlHours: 720 })
  assert.equal(bare.secureCookies, false)
  assert.equal(bare.serverPort, 3090)
  assert.equal(bare.target.port, 3080)
  assert.equal(bare.sessionTtlHours, 720)
  assert.equal(bare.tunnel.enabled, false)
  assert.equal(bare.stateFile, defaultStateFile())
})

await check('resolveConfig ignores the environment entirely', () => {
  // The deployment configures this plugin in Settings, and nowhere else: a
  // variable left over in the environment must not change a single value.
  const config = withEnvSync({
    DSH_GW_ORIGIN: 'https://env.example.test',
    DSH_GW_PORT: '4090',
    DSH_GW_TARGET: 'http://127.0.0.1:4091',
    VPS_HOST: 'env-vps.example.test',
    VPS_TUNNEL_PORT: '5090',
  }, () => resolveConfig({ publicOrigin: 'https://row.example.test', serverPort: 3090, clientPort: 3080, sessionTtlHours: 720 }))
  assert.equal(config.publicOrigin, 'https://row.example.test')
  assert.equal(config.serverPort, 3090)
  assert.equal(config.target.port, 3080)
  assert.equal(config.tunnel.enabled, false)
  assert.equal(config.tunnel.remotePort, 3090)
})

await check('resolveConfig refuses configurations that fail open', () => {
  assert.throws(() => resolveConfig({}), ConfigError, 'a row with no origin cannot serve')
  assert.throws(() => resolveConfig({ publicOrigin: 'not a url' }), ConfigError)
  assert.throws(() => resolveConfig({ publicOrigin: 'ftp://a.example' }), ConfigError)
  assert.throws(() => resolveConfig({ publicOrigin: 'https://user:pw@a.example' }), ConfigError)
  assert.throws(() => resolveConfig({ publicOrigin: 'https://a.example/path' }), ConfigError)
  assert.throws(() => resolveConfig({ publicOrigin: 'https://a.example', serverPort: '0' }), ConfigError)
  assert.throws(() => resolveConfig({ publicOrigin: 'https://a.example', serverPort: 70_000 }), ConfigError)
  assert.throws(() => resolveConfig({ publicOrigin: 'https://a.example', clientPort: 'x' }), ConfigError)
  assert.throws(() => resolveConfig({ publicOrigin: 'https://a.example', sessionTtlHours: 0 }), ConfigError)
  // The server port has no safe default: it must match Nginx, and a mismatch
  // shows up as a tunnel that looks healthy while the public URL answers 502.
  assert.throws(
    () => resolveConfig({ publicOrigin: 'https://a.example' }),
    /serverPort is required/u,
    'a row that omits the server port must be refused, not defaulted',
  )
  // An enabled tunnel needs all three coordinates; a half-filled one is a
  // configuration the operator must see rather than a tunnel that never opens.
  assert.throws(() => resolveConfig({ publicOrigin: 'https://a.example', tunnel: { enabled: true } }), ConfigError)
  assert.throws(() => resolveConfig({ publicOrigin: 'https://a.example', tunnel: { enabled: true, host: 'vps.example' } }), ConfigError)
  assert.throws(() => resolveConfig({ publicOrigin: 'https://a.example', tunnel: { enabled: 'maybe' } }), ConfigError)
})

await check('every value with a box in the settings form is required', () => {
  // The operator's rule: a field the form asks for is a field the deployment
  // must answer. Nothing in this module may fall back to a guessed value, so
  // removing any single one of them has to be refused — except the tunnel
  // switch, whose state follows the three coordinates it needs (documented as
  // the one deliberate exception).
  const complete = {
    publicOrigin: 'https://dsh.example.test',
    serverPort: 3090,
    clientPort: 3080,
    sessionTtlHours: 720,
    tunnel: { enabled: true, host: 'vps.example.test', port: 22, user: 'root', privateKeyFile: '/k/id_ed25519' },
  }
  // The complete row resolves, so each failure below has exactly one cause.
  assert.equal(resolveConfig(complete).serverPort, 3090)
  assert.equal(resolveConfig(complete).target.port, 3080)

  const required: [string, string][] = [
    ['publicOrigin', 'publicOrigin'],
    ['serverPort', 'serverPort'],
    ['clientPort', 'clientPort'],
    ['sessionTtlHours', 'sessionTtlHours'],
    ['tunnel.host', 'host'],
    ['tunnel.port', 'port'],
    ['tunnel.user', 'user'],
    ['tunnel.privateKeyFile', 'privateKeyFile'],
  ]
  for (const [path, key] of required) {
    const row = path.startsWith('tunnel.')
      ? { ...complete, tunnel: { ...complete.tunnel, [key]: undefined } }
      : { ...complete, [key]: undefined }
    assert.throws(
      () => resolveConfig(row),
      new RegExp(`${path.replace('.', '\\.')} is required`, 'u'),
      `${path} must be required: an input box with a hidden default is what this check exists to prevent`,
    )
  }

  // A disabled tunnel never dials, so its port may stay unset without a guess
  // leaking into a live connection.
  const idle = resolveConfig({ ...complete, tunnel: { enabled: false } })
  assert.equal(idle.tunnel.enabled, false)
})

await check('a state write survives another reader holding the file', async () => {
  // Windows refuses to replace a file that another handle has open, so
  // `writeFile` + `rename` failed with EPERM whenever anything was reading the
  // state file at that instant (this project's acceptance script, a backup agent,
  // an antivirus scanner, a second dsh). Reproduced before the retry: 25 of 40
  // writes failed and left a temp file holding the credentials.
  const file = join(workdir, 'contended.json')
  const store = new StateStore(file)
  await store.load()
  assert.ok(await until(() => true), 'placeholder so the file exists')
  let stop = false
  const reader = (async () => {
    while (!stop) {
      await readFile(file, 'utf8').catch(() => '')
      await new Promise(resolve => setTimeout(resolve, 1))
    }
  })()
  const failures: string[] = []
  for (let i = 0; i < 20; i += 1) {
    store.state.sshHostKey = `SHA256:contended${String(i)}`
    await store.persist().catch((error: unknown) => { failures.push(String((error as NodeJS.ErrnoException).code)) })
  }
  stop = true
  await reader
  assert.deepEqual(failures, [], `a reader must not break a state write: ${failures.join(', ')}`)
  assert.equal((await loadState(file)).sshHostKey, 'SHA256:contended19')
  const leftovers = (await readdir(workdir)).filter(name => name.startsWith('contended.json.') && name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], 'a failed write must not leave a credential copy behind')
})

await check('state files round-trip and refuse a corrupt document', async () => {
  const file = join(workdir, 'nested', 'state.json')
  const store = new StateStore(file)
  const state = await store.load()
  assert.equal(state.passkeys.length, 0)
  assert.equal(state.sshHostKey, null)
  // The first load writes the file, so the signing secret stops rotating.
  assert.equal((await loadState(file)).secret, state.secret)
  // The loader itself says whether it invented a document: `StateStore.load()`
  // persists on that answer, because probing with `access()` first leaves a
  // window where a fresh secret never reaches disk.
  assert.equal((await loadStateOrCreate(file)).created, false, 'an existing file was created by nobody')
  assert.equal((await loadStateOrCreate(join(workdir, 'nested', 'absent.json'))).created, true, 'a missing file must be reported as created')
  // A secret is an HMAC key, not opaque text: a hand-edited one must fail the
  // load with the file named, instead of throwing inside every request (500s).
  const brokenSecret = join(workdir, 'nested', 'broken-secret.json')
  await writeFile(brokenSecret, JSON.stringify({ ...state, secret: 'not base64url!' }), 'utf8')
  await assert.rejects(() => loadState(brokenSecret), /secret that is not canonical base64url/u)
  state.passkeys.push({
    id: 'abc', publicKey: 'def', counter: 0, transports: ['internal'], label: 'laptop', createdAt: 1,
    lastUsedAt: null, deviceType: null, backedUp: null,
  })
  await store.persist()
  const reloaded = await loadState(file)
  assert.equal(reloaded.passkeys[0].label, 'laptop')
  assert.equal(reloaded.secret, state.secret)

  const broken = join(workdir, 'broken.json')
  await writeFile(broken, '{"version":1,"secret":"x"}', 'utf8')
  await assert.rejects(() => loadState(broken), /no usable/)
  const notJson = join(workdir, 'notjson.json')
  await writeFile(notJson, 'nope', 'utf8')
  await assert.rejects(() => loadState(notJson), /not valid JSON/)
})

// ── the tunnel's decisions ──────────────────────────────────────────────────

await check('host-key fingerprints are compared in every spelling a deployment writes', () => {
  const key = randomBytes(32)
  const fingerprints = hostKeyFingerprints(key)
  assert.match(fingerprints.base64, /^SHA256:[A-Za-z0-9+/]+$/)
  assert.match(fingerprints.hex, /^[0-9a-f]{64}$/)
  for (const spelling of [fingerprints.base64, fingerprints.base64.slice(7), fingerprints.hex, fingerprints.hex.toUpperCase()]) {
    assert.equal(fingerprintMatches(spelling, fingerprints), true, spelling)
  }
  assert.equal(fingerprintMatches(hostKeyFingerprints(randomBytes(32)).base64, fingerprints), false)
})

await check('the manager refuses a host key that is not the pinned one', async () => {
  // The crypto helper has a check of its own; this is the manager's own policy:
  // a mismatch is refused, the pin survives it, and a first use is what pins.
  const store = new StateStore(join(workdir, 'hostkey-state.json'))
  await store.load()
  const pinnedKey = randomBytes(32)
  const presentedKey = randomBytes(32)
  store.state.sshHostKey = hostKeyFingerprints(pinnedKey).base64
  const manager = new TunnelManager({ ...tunnelOptions({ enabled: false }), store })
  assert.equal(manager.verifyHostKey(presentedKey), false, 'a different key must be refused')
  assert.equal(store.state.sshHostKey, hostKeyFingerprints(pinnedKey).base64, 'a mismatch must not rewrite the pin')

  store.state.sshHostKey = null
  /** What the tunnel logged while pinning, so a failed write cannot hide. */
  const logged: string[] = []
  const growingLog: Logger = { info: () => {}, warn: line => { logged.push(String(line)) }, error: line => { logged.push(String(line)) } }
  const fresh = new TunnelManager({ ...tunnelOptions({ enabled: false }), store, log: growingLog })
  assert.equal(fresh.verifyHostKey(presentedKey), true, 'the first key seen is trusted')
  assert.equal(store.state.sshHostKey, hostKeyFingerprints(presentedKey).base64, 'and it becomes the pin')
  // Durability, deterministically: the verifier cannot await its own write (ssh2
  // decides from the return value), so drain the store's write chain and then read
  // the file. Polling the file instead raced the `rename` — on Windows a tight
  // read loop on the destination can make the rename fail, and the failure then
  // looked like a slow write.
  await store.persist()
  const reloaded = await loadState(store.file)
  assert.equal(reloaded.sshHostKey, hostKeyFingerprints(presentedKey).base64)
  assert.deepEqual(
    logged.filter(line => line.includes('pinning the host key failed')),
    [],
    `pinning must not fail silently: ${logged.join(' | ')}`,
  )
  await assert.rejects(() => stat(join(workdir, 'hostkey-state.json.999999.tmp')), /ENOENT/)
})

await check('a disabled tunnel does nothing and a missing key file fails the load', async () => {
  const disabledStore = new StateStore(join(workdir, 'tunnel-state.json'))
  await disabledStore.load()
  const disabled = new TunnelManager({
    ...tunnelOptions({ enabled: false }),
    store: disabledStore,
  })
  await disabled.start()
  assert.equal(disabled.snapshot().state, 'disabled')

  const missing = new TunnelManager({
    ...tunnelOptions({ enabled: true, user: 'x', privateKeyFile: join(workdir, 'absent-key') }),
    store: disabledStore,
  })
  await assert.rejects(() => missing.start(), /cannot read the SSH private key/)
  // Terminal, and visible: a key that cannot be read is not a transient failure, so
  // the state must say `failed` (not sit on `starting` forever) and carry the reason
  // the page shows — the throw alone only reaches the caller's log.
  assert.equal(missing.snapshot().state, 'failed')
  assert.equal(missing.snapshot().kind, 'key')
  assert.match(String(missing.snapshot().lastError), /absent-key/)
})

await check('a PKCS#8 key is named instead of surfacing ssh2 wording', async () => {
  const keyFile = join(workdir, 'pkcs8.pem')
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  await writeFile(keyFile, privateKey, 'utf8')
  const store = new StateStore(join(workdir, 'format-state.json'))
  await store.load()
  const manager = new TunnelManager({
    ...tunnelOptions({ enabled: true, port: 1, user: 'nobody', privateKeyFile: keyFile }),
    store,
  })
  await assert.rejects(() => manager.start(), /PKCS#8/)
})

await check('a refused connection is retried instead of failing the plugin', async () => {
  const keyFile = join(workdir, 'id_ed25519')
  // ssh2's own generator, so the fixture is exactly the OpenSSH format the
  // tunnel must accept.
  const { private: openSshKey } = ssh2.utils.generateKeyPairSync('ed25519')
  await writeFile(keyFile, openSshKey, 'utf8')
  const store = new StateStore(join(workdir, 'retry-state.json'))
  await store.load()
  const manager = new TunnelManager({
    ...tunnelOptions({ enabled: true, port: 1, user: 'nobody', privateKeyFile: keyFile }),
    store,
  })
  await manager.start()
  // Poll instead of sleeping a fixed guess: a loaded machine can take longer than
  // any number picked here, and the failure would look like a product bug.
  assert.ok(
    await until(() => manager.snapshot().state === 'reconnecting' && manager.snapshot().attempts >= 1),
    `the tunnel never reported a retry: ${JSON.stringify(manager.snapshot())}`,
  )
  const snapshot = manager.snapshot()
  assert.equal(snapshot.state, 'reconnecting', JSON.stringify(snapshot))
  assert.ok(snapshot.attempts >= 1)
  assert.equal(snapshot.channels, 0)
  await manager.stop()
  assert.equal(manager.snapshot().state, 'stopped')
})

await check('every ssh2 failure is classified into something an operator can act on', () => {
  // The page names the field to fix from this classification, so the mapping is the
  // contract: an authentication rejection, a name that does not resolve, a refused
  // socket, a handshake that never finished, and anything else kept honestly
  // unknown rather than mislabeled into one of them.
  assert.equal(classifySshFailure('client-authentication', 'All configured authentication methods failed'), 'auth')
  assert.equal(classifySshFailure('agent', 'no agent'), 'auth')
  assert.equal(classifySshFailure('client-dns', 'getaddrinfo ENOTFOUND vps.invalid'), 'dns')
  assert.equal(classifySshFailure('client-socket', 'connect ECONNREFUSED 1.2.3.4:22'), 'unreachable')
  assert.equal(classifySshFailure('client-socket', 'getaddrinfo ENOTFOUND vps.invalid'), 'dns')
  assert.equal(classifySshFailure('client-timeout', 'Timed out while waiting for handshake'), 'handshake-timeout')
  assert.equal(classifySshFailure('protocol', 'unexpected packet'), 'unknown')

  // A port a previous session still holds is the failure with an exact remedy, so
  // its sentence carries the remedy and not ssh2's "Unable to bind".
  const forward = describeForwardFailure(3090, 'Unable to bind to 127.0.0.1:3090')
  assert.match(forward, /127\.0\.0\.1:3090/)
  assert.match(forward, /Unable to bind to 127\.0\.0\.1:3090/)
  assert.match(forward, /sudo ss -ltnp \| grep 3090/)
  assert.match(forward, /ClientAliveInterval 30/)
})

await check('the VPS-side release only ever targets a provable sshd on our own port', () => {
  // Ending a process on someone else's server is the sharpest thing this plugin can
  // do, so every shape that must do *nothing* is asserted, not just the happy one.
  const one = 'LISTEN 0      128        127.0.0.1:3090      0.0.0.0:*    users:(("sshd",pid=1234,fd=3))'
  const two = 'LISTEN 0 128 127.0.0.1:3090 0.0.0.0:* users:(("sshd",pid=99,fd=4),("sshd",pid=98,fd=5))'
  assert.deepEqual(parseSshdHolders(one, 3090), [1234])
  assert.deepEqual(parseSshdHolders(two, 3090), [99, 98])
  // The negatives: another port, another address, another process, or no process
  // column at all — a non-root tunnel user cannot see other users' pids.
  assert.deepEqual(parseSshdHolders('LISTEN 0 128 127.0.0.1:3091 0.0.0.0:* users:(("sshd",pid=1234,fd=3))', 3090), [])
  assert.deepEqual(parseSshdHolders('LISTEN 0 128 0.0.0.0:3090 0.0.0.0:* users:(("sshd",pid=1234,fd=3))', 3090), [])
  assert.deepEqual(parseSshdHolders('LISTEN 0 128 127.0.0.1:3090 0.0.0.0:* users:(("nginx",pid=1234,fd=3))', 3090), [])
  assert.deepEqual(parseSshdHolders('LISTEN 0 128 127.0.0.1:3090 0.0.0.0:*', 3090), [])

  assert.deepEqual(planRelease(one, 3090), { kind: 'kill', pids: [1234] })
  // Held, but by something this action will not end: report, never kill.
  assert.deepEqual(planRelease('LISTEN 0 128 127.0.0.1:3090 0.0.0.0:*', 3090), { kind: 'cannot-see' })
  assert.deepEqual(planRelease('LISTEN 0 128 127.0.0.1:3090 0.0.0.0:* users:(("nginx",pid=1,fd=3))', 3090), { kind: 'cannot-see' })
  assert.deepEqual(planRelease('', 3090), { kind: 'nothing' })
  assert.deepEqual(planRelease(null, 3090), { kind: 'unavailable' })

  // `fuser` names pids but never process names, so it can only report.
  assert.deepEqual(parseFuserHolders('3090/tcp:            1234 5678'), [1234, 5678])
  assert.deepEqual(parseFuserHolders(''), [])
  // Every command is fixed text with one validated integer in it.
  assert.equal(ssProbeCommand(3090), "ss -ltnpH 'sport = :3090'")
  assert.equal(fuserProbeCommand(3090), 'fuser -n tcp 3090 2>/dev/null')
  assert.equal(killCommand(1234), 'kill 1234')
})

await check('repeated failures that never once succeeded are called a configuration problem, quietly', async () => {
  const keyFile = join(workdir, 'id_ed25519-escalation')
  const { private: openSshKey } = ssh2.utils.generateKeyPairSync('ed25519')
  await writeFile(keyFile, openSshKey, 'utf8')
  const store = new StateStore(join(workdir, 'escalation-state.json'))
  await store.load()
  // What the tunnel logged, so the throttling is asserted rather than described.
  const logged: string[] = []
  const capturing: Logger = {
    info: () => {},
    warn: line => { logged.push(String(line)) },
    error: line => { logged.push(String(line)) },
  }
  const manager = new TunnelManager({
    ...tunnelOptions({ enabled: true, port: 1, user: 'nobody', privateKeyFile: keyFile, reconnectMaxDelayMs: 20, suspectedReconnectMaxDelayMs: 20 }),
    store,
    log: capturing,
  })
  try {
    await manager.start()
    assert.ok(
      await until(() => manager.snapshot().attempts >= 12, 10_000),
      `the tunnel never reached twelve attempts: ${JSON.stringify(manager.snapshot())}`,
    )
    const snapshot = manager.snapshot()
    assert.equal(snapshot.everListening, false)
    assert.equal(snapshot.kind, 'unreachable')
    // Never once up, and five attempts deep: the page must stop saying "reconnecting"
    // and point at the two fields that can produce this.
    assert.equal(snapshot.suspected, 'configuration')
    assert.ok(snapshot.nextRetryAt !== null && snapshot.nextRetryAt > Date.now() - 1_000, JSON.stringify(snapshot))
    // Twelve failures, at most three console lines: one full line the first time,
    // then only every tenth attempt. Forty identical lines hide the one that matters.
    const lost = logged.filter(line => line.includes('tunnel lost'))
    assert.ok(lost.length <= 3, `${String(lost.length)} lines for ${String(snapshot.attempts)} attempts:\n${logged.join('\n')}`)
    assert.ok(lost.length >= 1, `a failure must still be reported once:\n${logged.join('\n')}`)
    assert.ok(lost.some(line => line.includes('looks like a configuration problem')), logged.join('\n'))
  } finally {
    await manager.stop()
  }
})

await check('a retry after a failure forgets the previous reason instead of presenting it', async () => {
  // "Retry now" and 「重新信任」 both stop and start the manager; a fresh attempt
  // showing the previous attempt's `lastError` would read as a failure that has not
  // happened yet.
  const keyFile = join(workdir, 'id_ed25519-retry')
  const { private: openSshKey } = ssh2.utils.generateKeyPairSync('ed25519')
  await writeFile(keyFile, openSshKey, 'utf8')
  const store = new StateStore(join(workdir, 'retry-clear-state.json'))
  await store.load()
  const manager = new TunnelManager({
    ...tunnelOptions({ enabled: true, port: 1, user: 'nobody', privateKeyFile: keyFile, reconnectMaxDelayMs: 20, suspectedReconnectMaxDelayMs: 20 }),
    store,
  })
  try {
    await manager.start()
    assert.ok(await until(() => manager.snapshot().kind !== null), `no failure was recorded: ${JSON.stringify(manager.snapshot())}`)
    await manager.stop()
    await manager.start()
    const fresh = manager.snapshot()
    assert.equal(fresh.kind, null, JSON.stringify(fresh))
    assert.equal(fresh.lastError, null, JSON.stringify(fresh))
    assert.equal(fresh.attempts, 0, JSON.stringify(fresh))
  } finally {
    await manager.stop()
  }
})

await check('portAccepts tells an open port from a refused one', async () => {
  // This is what turns "ECONNREFUSED on the port you configured" into "…but 22
  // answers, so tunnel.port is probably 22" in the operator's log.
  const server = createServer(() => {})
  const openPort = await listen(server)
  assert.equal(await portAccepts('127.0.0.1', openPort), true)
  await new Promise<void>(resolve => { server.close(() => resolve()) })
  assert.equal(await portAccepts('127.0.0.1', openPort, 300), false, 'a closed port must not read as reachable')
  assert.equal(await portAccepts('127.0.0.1', 1, 300), false)
})

await check('a stopped tunnel starts again instead of staying dead', async () => {
  // Regression: 「重新信任 / Trust again」 stops the tunnel, clears the pinned
  // host key, and starts it again. `start()` used to leave the stop flag set, so
  // the restart did nothing: the state stayed `stopped` (no retries, no error,
  // no chance to re-pin the key) until the whole plugin row reloaded.
  const keyFile = join(workdir, 'restart-key')
  const { private: openSshKey } = ssh2.utils.generateKeyPairSync('ed25519')
  await writeFile(keyFile, openSshKey, 'utf8')
  const store = new StateStore(join(workdir, 'restart-state.json'))
  await store.load()
  const manager = new TunnelManager({
    ...tunnelOptions({ enabled: true, port: 1, user: 'nobody', privateKeyFile: keyFile }),
    store,
  })
  await manager.start()
  assert.ok(
    await until(() => manager.snapshot().state === 'reconnecting'),
    `the restarted tunnel never retried: ${JSON.stringify(manager.snapshot())}`,
  )
  assert.equal(manager.snapshot().state, 'reconnecting')
  await manager.stop()
  assert.equal(manager.snapshot().state, 'stopped')

  await manager.start()
  assert.notEqual(manager.snapshot().state, 'stopped', 'starting a stopped tunnel must resume it')
  assert.ok(
    await until(() => manager.snapshot().attempts >= 1),
    `a resumed tunnel must retry again: ${JSON.stringify(manager.snapshot())}`,
  )
  const resumed = manager.snapshot()
  assert.ok(resumed.attempts >= 1, `a resumed tunnel must retry again: ${JSON.stringify(resumed)}`)
  assert.notEqual(resumed.state, 'stopped')
  await manager.stop()
})

// ── the gateway over real sockets ───────────────────────────────────────────

/** One request the stand-in upstream received. */
interface SeenRequest {
  url: string | undefined
  headers: IncomingHttpHeaders
  upgrade?: boolean
}

const seen: SeenRequest[] = []

/** @returns the most recent request the stand-in upstream answered. */
function lastSeen(): SeenRequest {
  const entry = seen.at(-1)
  if (entry === undefined) throw new Error('the proxy forwarded no request')
  return entry
}

const upstream = createServer((req, res) => {
  seen.push({ url: req.url, headers: req.headers })
  if (req.url === '/api') {
    // The real GUI answers 401 to an unauthenticated /api request once its
    // fence accepts the Host; that is the answer the startup probe classifies.
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('unauthorized')
    return
  }
  if (req.url === '/redirect') {
    res.writeHead(302, { location: '/elsewhere', 'set-cookie': 'upstream=1; Path=/' })
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' })
  res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host ?? null, origin: req.headers.origin ?? null }))
})
upstream.on('upgrade', (req, socket) => {
  seen.push({ url: req.url, headers: req.headers, upgrade: true })
  const accept = createHash('sha1')
    .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`)
  socket.on('data', chunk => socket.write(chunk))
  socket.on('error', () => socket.destroy())
})
const upstreamPort = await listen(upstream)

const store = new StateStore(join(workdir, 'gateway-state.json'))
const state = await store.load()
const config = testConfig({
  target: { host: '127.0.0.1', port: upstreamPort },
  stateFile: join(workdir, 'gateway-state.json'),
})
const passkeys = new PasskeyService({ rpID: config.rpID, rpName: config.rpName, origin: config.publicOrigin, state, store, log: silentLog })
const gateway = new Gateway({ config, passkeys, store, log: silentLog })
await gateway.listen()
const port = (gateway.server.address() as AddressInfo).port
const session = createSession(state.secret, { ttlMs: 60_000, audience: 'session', credentialId: 'test-credential' })
const authCookie = `${SESSION_COOKIE}=${session.value}`
const publicHost = 'dsh.example.test'

await check('an unauthenticated navigation is redirected to the login page', async () => {
  const response = await request(port, { path: '/sessions?x=1', headers: { host: publicHost, accept: 'text/html', 'sec-fetch-dest': 'document' } })
  assert.equal(response.status, 303)
  assert.equal(response.headers.location, '/signin')
  assert.match(String(response.headers['set-cookie']), /dsh-gw-next=/)
})

await check('an unauthenticated API call is refused with 401 and never reaches the upstream', async () => {
  const before = seen.length
  const response = await request(port, { method: 'POST', path: '/api/session.list', headers: { host: publicHost, accept: 'application/json', 'content-type': 'application/json', 'sec-fetch-dest': 'empty' }, body: '{}' })
  assert.equal(response.status, 401)
  assert.equal(seen.length, before)
})

await check('an authenticated request reaches the upstream with Host and Origin preserved', async () => {
  const response = await request(port, {
    path: '/api/session.list',
    headers: {
      host: publicHost,
      origin: 'https://dsh.example.test',
      'sec-fetch-site': 'same-origin',
      cookie: authCookie,
      'x-custom': 'kept',
      'proxy-authorization': 'must-not-cross',
      'te': 'trailers',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers['x-upstream'], 'yes')
  const payload = JSON.parse(response.body)
  assert.equal(payload.host, publicHost)
  assert.equal(payload.origin, 'https://dsh.example.test')
  assert.equal(lastSeen().headers['x-custom'], 'kept')
  assert.equal(lastSeen().headers['proxy-authorization'], undefined)
  assert.equal(lastSeen().headers.te, undefined)
})

await check('the upstream answers through unchanged, including its cookies', async () => {
  const response = await request(port, { path: '/redirect', headers: { host: publicHost, cookie: authCookie } })
  assert.equal(response.status, 302)
  assert.equal(response.headers.location, '/elsewhere')
  assert.ok(String(response.headers['set-cookie']).includes('upstream=1'))
})

await check('an authenticated WebSocket upgrade is proxied byte for byte', async () => {
  const socket = connectTcp({ host: '127.0.0.1', port })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const key = randomBytes(16).toString('base64')
  socket.write([
    'GET /api/remote.mux HTTP/1.1',
    `host: ${publicHost}`,
    `origin: https://${publicHost}`,
    `cookie: ${authCookie}`,
    'upgrade: websocket',
    'connection: Upgrade',
    `sec-websocket-key: ${key}`,
    'sec-websocket-version: 13',
    '',
    '',
  ].join('\r\n'))
  const head = await new Promise<string>((resolve, reject) => {
    let buffer = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1')
      if (buffer.includes('\r\n\r\n')) resolve(buffer)
    })
    socket.once('error', reject)
    setTimeout(() => reject(new Error('no upgrade response')), 5_000).unref()
  })
  assert.match(head, /^HTTP\/1\.1 101 /)
  // The handshake is only a handshake with these two headers: they are
  // hop-by-hop in general, so a header filter that applies the hop-by-hop set to
  // the 101 answer silently breaks every WebSocket in the browser.
  assert.match(head, /upgrade: websocket/iu)
  assert.match(head, /connection: Upgrade/iu)
  const expected = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  assert.ok(head.toLowerCase().includes(`sec-websocket-accept: ${expected.toLowerCase()}`), head)
  const echoed = await new Promise<string>((resolve, reject) => {
    socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
    socket.once('error', reject)
    socket.write('ping-through-the-proxy')
    setTimeout(() => reject(new Error('no echo')), 5_000).unref()
  })
  assert.equal(echoed, 'ping-through-the-proxy')
  socket.destroy()
})

await check('an unauthenticated WebSocket upgrade is rejected', async () => {
  const socket = connectTcp({ host: '127.0.0.1', port })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.write([
    'GET /api/remote.mux HTTP/1.1',
    `host: ${publicHost}`,
    'upgrade: websocket',
    'connection: Upgrade',
    `sec-websocket-key: ${randomBytes(16).toString('base64')}`,
    'sec-websocket-version: 13',
    '',
    '',
  ].join('\r\n'))
  const head = await new Promise<string>((resolve, reject) => {
    let buffer = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1')
      if (buffer.includes('\r\n\r\n')) resolve(buffer)
    })
    socket.once('error', reject)
    setTimeout(() => reject(new Error('no rejection')), 5_000).unref()
  })
  assert.match(head, /^HTTP\/1\.1 401 /)
  socket.destroy()
})

await check('the login page and its script are served with a policy', async () => {
  const page = await request(port, { path: '/signin', headers: { host: publicHost, accept: 'text/html' } })
  assert.equal(page.status, 200)
  assert.match(page.body, /\/app\.js/)
  assert.match(String(page.headers['content-security-policy']), /default-src 'none'/)
  const script = await request(port, { path: '/app.js', headers: { host: publicHost } })
  assert.equal(script.status, 200)
  assert.match(script.body, /navigator\.credentials/)
  const missing = await request(port, { path: '/nope', headers: { host: publicHost } })
  assert.equal(missing.status, 401, 'an unknown path is the GUI\'s business, not a gateway route')
})

await check('the old namespace is gone and neighbouring paths are still proxied', async () => {
  // The gateway used to own a namespace prefix. Namespaces are convenient and
  // hard to remove later, so this check keeps it removed: nothing may answer
  // under it again, and no path may be captured by a prefix rule.
  //
  // The legacy prefix is assembled rather than written out, because a source file
  // that carries it as a *usable route* is exactly what this refactor deleted;
  // the string only ever exists here, as the thing being asserted absent.
  const legacy = ['_', '_', 'gw'].join('')
  for (const path of [`/${legacy}/app.js`, `/${legacy}/status`, `/${legacy}/auth/options`]) {
    // Owned paths never reach the session check, so a challenge is the proof that
    // a path is not the gateway's any more.
    const challenged = await request(port, {
      method: path.endsWith('options') ? 'POST' : 'GET',
      path,
      headers: { host: publicHost },
    })
    assert.equal(challenged.status, 401, `${path} must not be a gateway route any more`)

    // And with a session it must reach the GUI, which is the end of the story for
    // a path this plugin no longer serves.
    const before = seen.length
    const proxied = await request(port, { path, headers: { host: publicHost, cookie: authCookie } })
    assert.equal(proxied.headers['x-upstream'], 'yes', `${path} must be proxied upstream`)
    assert.equal(seen.length, before + 1)
    assert.equal(lastSeen().url, path)
  }

  // Neighbours of the flat names must not be swallowed by a prefix rule: exact
  // matching is what makes a short namespace safe to live in.
  for (const path of ['/statuses', '/auth/extra', '/logout/extra', '/app.js.map', '/signin/extra']) {
    const before = seen.length
    const response = await request(port, { path, headers: { host: publicHost, cookie: authCookie } })
    assert.equal(response.status, 200)
    assert.equal(response.headers['x-upstream'], 'yes', `${path} must be proxied`)
    assert.equal(seen.length, before + 1, `${path} must reach the upstream`)
  }
})

await check('an authenticated login-page visit is returned to the carried destination', async () => {
  const first = await request(port, { path: '/sessions?x=2', headers: { host: publicHost, accept: 'text/html', 'sec-fetch-dest': 'document' } })
  const carried = String(first.headers['set-cookie']).split(';')[0]
  const second = await request(port, { path: '/signin', headers: { host: publicHost, cookie: `${authCookie}; ${carried}` } })
  assert.equal(second.status, 303)
  assert.equal(second.headers.location, '/sessions?x=2')
})

await check('a next-cookie or enrollment grant replayed as a session is still refused', async () => {
  // The regression that mattered most: the `dsh-gw-next` cookie is handed to any
  // anonymous `Accept: text/html` request, and the enrollment grant to anyone who
  // opens a link. Both are signed with the same secret as a session, so before
  // the audience check existed, renaming either one to `dsh-gw-session` skipped
  // the passkey gate entirely. This proves it at the HTTP layer, not just in the
  // cookie helper.
  const challenge = await request(port, { path: '/somewhere', headers: { host: publicHost, accept: 'text/html', 'sec-fetch-dest': 'document' } })
  assert.equal(challenge.status, 303)
  const nextValue = String(challenge.headers['set-cookie']).split(';')[0].replace(/^[^=]+=/u, '')
  assert.ok(nextValue.length > 0, 'the challenge must hand out a return-path cookie')

  const minted = await gateway.mintEnrollment()
  const token = new URL(minted.url).searchParams.get('token') ?? ''
  const enrollPage = await request(port, { path: `/auth?token=${encodeURIComponent(token)}`, headers: { host: publicHost, accept: 'text/html' } })
  assert.equal(enrollPage.status, 200)
  const grantValue = String(enrollPage.headers['set-cookie']).split(';')[0].replace(/^[^=]+=/u, '')
  assert.ok(grantValue.length > 0, 'the enrollment page must hand out a grant')

  for (const [name, value] of [['next-cookie', nextValue], ['enrollment grant', grantValue]]) {
    const before = seen.length
    const replayed = await request(port, {
      path: '/api/session.list',
      headers: { host: publicHost, accept: 'application/json', 'sec-fetch-dest': 'empty', cookie: `dsh-gw-session=${value}` },
    })
    assert.equal(replayed.status, 401, `a replayed ${name} must not authorize a request`)
    assert.match(replayed.body, /passkey authentication required/u, `the gateway must answer for the ${name}, not the GUI`)
    assert.equal(seen.length, before, `a replayed ${name} must never reach the upstream`)
  }
})

await check('enrollment refuses a wrong token and accepts a freshly minted one', async () => {
  const wrong = await request(port, { path: '/auth?token=nope', headers: { host: publicHost, accept: 'text/html' } })
  assert.equal(wrong.status, 403)
  // There is no permanent token any more: a link exists only after it is minted.
  const noLink = await request(port, { path: '/auth', headers: { host: publicHost, accept: 'text/html' } })
  assert.equal(noLink.status, 403)
  const minted = await gateway.mintEnrollment()
  // The scanned address is the short one at the root, and it names the gateway's
  // own route rather than anything upstream.
  assert.match(minted.url, /^https:\/\/dsh\.example\.test\/auth\?token=/)
  assert.equal(new URL(minted.url).pathname, '/auth')
  const mintedToken = new URL(minted.url).searchParams.get('token')
  assert.ok(mintedToken !== null && mintedToken !== '')
  const right = await request(port, { path: `/auth?token=${encodeURIComponent(String(mintedToken))}`, headers: { host: publicHost, accept: 'text/html' } })
  assert.equal(right.status, 200)
  assert.match(String(right.headers['set-cookie']), /dsh-gw-enroll=/)
  const grant = String(right.headers['set-cookie']).split(';')[0]

  // A browser that is already signed in has nothing to enroll: it goes to the
  // GUI, and the one-time token survives for the device it was minted for.
  const signedIn = await request(port, { path: `/auth?token=${encodeURIComponent(String(mintedToken))}`, headers: { host: publicHost, accept: 'text/html', cookie: authCookie } })
  assert.equal(signedIn.status, 303, 'a signed-in browser must not be shown the enrollment page')
  assert.equal(signedIn.headers.location, '/')
  assert.equal(String(signedIn.headers['set-cookie'] ?? '').includes('dsh-gw-enroll='), false, 'the enroll grant must not be issued to a signed-in browser')
  const stillUsable = await request(port, { path: `/auth?token=${encodeURIComponent(String(mintedToken))}`, headers: { host: publicHost, accept: 'text/html' } })
  assert.equal(stillUsable.status, 200, 'opening the link on the wrong device must not consume it')
  // …unless the operator explicitly wants a second passkey on this device.
  const second = await request(port, { path: `/auth?token=${encodeURIComponent(String(mintedToken))}&add=1`, headers: { host: publicHost, accept: 'text/html', cookie: authCookie } })
  assert.equal(second.status, 200, 'add=1 is the deliberate way to enroll another passkey from a signed-in browser')
  const options = await request(port, { method: 'POST', path: '/enroll/options', headers: { host: publicHost, 'content-type': 'application/json', cookie: grant }, body: '{"label":"laptop"}' })
  assert.equal(options.status, 200)
  const parsed = JSON.parse(options.body)
  assert.equal(typeof parsed.options.challenge, 'string')
  assert.equal(parsed.options.rp.id, 'dsh.example.test')
  assert.equal(parsed.options.authenticatorSelection.userVerification, 'required')
})

await check('a ceremony flood slows down instead of locking everyone out', async () => {
  // Every request arrives through the reverse tunnel, so the whole internet
  // shares one client address; a hard 429 after the allowance therefore locked
  // the operator out of their own login for the rest of the window.
  const call = () => request(port, {
    method: 'POST',
    // Enrollment options are reachable with a session and need no registered
    // passkey, so this check can hammer them before one exists.
    path: '/enroll/options',
    headers: { host: publicHost, 'content-type': 'application/json', cookie: authCookie },
    body: '{}',
  })
  for (let i = 0; i < 30; i += 1) {
    const allowed = await call()
    assert.equal(allowed.status, 200, `ceremony ${String(i + 1)} was refused with ${String(allowed.status)}`)
  }
  const started = Date.now()
  const past = await call()
  const elapsed = Date.now() - started
  assert.equal(past.status, 200, 'past the allowance the ceremony must still be served')
  assert.ok(elapsed >= 700, `past the allowance the gateway must slow down; it answered in ${String(elapsed)}ms`)
})

await check('enrollment options need the grant or a session', async () => {
  const denied = await request(port, { method: 'POST', path: '/enroll/options', headers: { host: publicHost, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(denied.status, 403)
  const allowed = await request(port, { method: 'POST', path: '/enroll/options', headers: { host: publicHost, 'content-type': 'application/json', cookie: authCookie }, body: '{}' })
  assert.equal(allowed.status, 200)
})

await check('authentication options are refused before any passkey exists', async () => {
  const response = await request(port, { method: 'POST', path: '/auth/options', headers: { host: publicHost, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(response.status, 400)
  assert.match(JSON.parse(response.body).error, /no passkey is registered/)
})

await check('status takes the read-only token, and only that token', async () => {
  const loopback = await request(port, { path: '/status', headers: { host: '127.0.0.1:3090' } })
  assert.equal(loopback.status, 403)
  const forged = await request(port, { path: '/status', headers: { host: publicHost } })
  assert.equal(forged.status, 403)
  // The old spelling carried the cookie-signing secret in a URL, where it could
  // be read out of a reverse proxy's access log and used to forge a session. It
  // must no longer open this endpoint at all.
  const oldSecret = await request(port, { path: `/status?token=${encodeURIComponent(state.secret)}`, headers: { host: publicHost } })
  assert.equal(oldSecret.status, 403, 'the cookie-signing secret must not open /status any more')
  assert.ok(typeof state.statusToken === 'string' && state.statusToken !== '', 'the state file must carry a status token')
  assert.notEqual(state.statusToken, state.secret, 'the read-only token must not be the signing secret')

  const byHeader = await request(port, { path: '/status', headers: { host: publicHost, 'x-dsh-gw-status': state.statusToken } })
  assert.equal(byHeader.status, 200)
  const payload = JSON.parse(byHeader.body) as { rpID?: string, passkeyCount?: number, passkeys?: unknown }
  assert.equal(payload.rpID, 'dsh.example.test')
  assert.equal(typeof payload.passkeyCount, 'number', 'the payload reports a count, not the devices')
  assert.equal(payload.passkeys, undefined, 'device labels and timestamps must not be readable from the internet')
  // The query spelling stays for scripts written before the header existed.
  const byQuery = await request(port, { path: `/status?token=${encodeURIComponent(state.statusToken)}`, headers: { host: publicHost } })
  assert.equal(byQuery.status, 200)
  assert.equal(byQuery.body, byHeader.body)
})

await check('the upstream fence probe reports what the GUI answered', async () => {
  const probe = await gateway.preflight()
  assert.equal(probe.status, 401)
  assert.equal(probe.authority, 'dsh.example.test')
})

await check('a malformed ceremony body is rejected without a stack trace', async () => {
  const response = await request(port, { method: 'POST', path: '/auth/verify', headers: { host: publicHost, 'content-type': 'application/json' }, body: 'not json' })
  assert.equal(response.status, 400)
  assert.match(response.body, /not valid JSON/)
})

// ── the settings page's Host half ───────────────────────────────────────────

await check('the plugin row Config is a form the settings service can render', () => {
  const validated = Config['~standard'].validate({}) as { issues?: unknown }
  assert.equal(validated.issues, undefined, 'an empty row must validate: every field is optional')
  // The settings service reads `meta.volatile` off the live schema (that marker
  // is what puts a field in a form and what lets the Host restart the row on a
  // change), so the walk below reads the same member it does.
  interface SchemaNode {
    meta?: { volatile?: boolean, role?: string }
    dict?: Record<string, SchemaNode>
  }
  const live: string[] = []
  const secrets: string[] = []
  const walk = (node: SchemaNode, path: string[]): void => {
    if (node.meta?.volatile === true) live.push(path.join('.'))
    if (node.meta?.role === 'secret') secrets.push(path.join('.'))
    for (const [key, child] of Object.entries(node.dict ?? {})) walk(child, [...path, key])
  }
  walk(Config as unknown as SchemaNode, [])
  assert.equal(live.length, 11, `every editable field must be volatile; got ${live.join(', ')}`)
  assert.ok(live.includes('tunnel.privateKeyFile'))
  // The opt-in that lets the plugin act on the VPS is an editable field like any
  // other: it must ride the same volatile path, so turning it on restarts the row.
  assert.ok(live.includes('tunnel.releaseStaleForward'))
  assert.deepEqual(secrets, ['tunnel.passphrase'], 'the key passphrase never rides to the browser')
  // The fields the operator must not set are not fields: the bind address, the
  // state file, the RP ID and RP name, the local DSH URL, the VPS-side bind, and
  // the pinned host key are derived or discovered.
  for (const removed of ['bindHost', 'stateFile', 'rpID', 'rpName', 'target', 'hostKeyFingerprint', 'enrollSecret', 'remoteHost', 'remotePort']) {
    assert.equal(live.includes(removed), false, `${removed} must not be an editable field`)
  }
  // A field that forgot the marker would be silently uneditable, which is what
  // the count above guards; the type check below is the other half.
  const wrongType = Config['~standard'].validate({ serverPort: 'not a number' }) as { issues?: unknown }
  assert.notEqual(wrongType.issues, undefined, 'a wrong type must be refused before the plugin ever loads')
  // …but an out-of-range NUMBER must survive the schema: Cordis validates the
  // raw row before `apply()` runs, and a rejection there unloads the plugin row
  // (vendor/cordis/lib/index.js `_reload()` → `epoch = INACTIVE` → `_unload()`),
  // taking the settings page that could repair the value with it. Bounds belong
  // to `count()`, which reports a ConfigError and keeps the row alive.
  const outOfRange = Config['~standard'].validate({
    publicOrigin: 'https://dsh.example.test',
    serverPort: 70_000,
    clientPort: 0,
    sessionTtlHours: 99_999,
    tunnel: { port: -1 },
  }) as { issues?: unknown }
  assert.equal(outOfRange.issues, undefined, 'bounds must not be enforced by the schema')
  assert.throws(() => resolveConfig({ publicOrigin: 'https://dsh.example.test', serverPort: 70_000, clientPort: 3080, sessionTtlHours: 720 }), /serverPort must be a whole number/u)
})

await check('provenance names the layer each setting came from', () => {
  const sources = provenance({ publicOrigin: 'https://row.example.test', serverPort: 3090, clientPort: 3080, sessionTtlHours: 720, tunnel: { host: 'vps.example.test', port: 22 } })
  assert.equal(sources.publicOrigin, 'patch')
  assert.equal(sources['tunnel.host'], 'patch')
  assert.equal(sources.serverPort, 'patch')
  assert.equal(sources.clientPort, 'patch')
  assert.equal(sources.rpID, 'default')
  assert.equal(sources['tunnel.user'], 'unset')
  assert.equal(sources['tunnel.privateKeyFile'], 'unset')
  // The tunnel switch has no value of its own, so it reports the fallback rule
  // that decided it (on only when all three coordinates are present).
  assert.equal(sources['tunnel.enabled'], 'default')
})

await check('the enrollment QR is a standalone SVG data URL that follows its payload', () => {
  const short = qrDataUrl('https://dsh.example.test/auth?token=a')
  const long = qrDataUrl(`https://dsh.example.test/auth?token=${'a'.repeat(400)}`)
  for (const value of [short, long]) {
    assert.match(value, /^data:image\/svg\+xml;base64,/)
    const svg = Buffer.from(value.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')
    assert.match(svg, /<svg/)
    assert.match(svg, /viewBox=/)
  }
  assert.equal(short, qrDataUrl('https://dsh.example.test/auth?token=a'), 'rendering must be deterministic')
  assert.notEqual(short, long, 'a longer payload needs a bigger code')
  assert.ok(long.length > short.length)
  // The quiet zone is what makes the code scannable: qrcode-generator counts
  // `margin` in SVG units, and a literal 3 left under one module of white on each
  // side (the spec asks for four) — exactly what a phone camera struggles with.
  // `createSvgTag` starts the module path at the margin, so the first "M x,y"
  // pair *is* the quiet zone.
  const svg = Buffer.from(qrDataUrl('https://dsh.example.test/auth?token=abc').slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/u.exec(svg)
  assert.ok(viewBox !== null, 'the SVG must declare a viewBox')
  const size = Number(viewBox[1])
  const first = /<path d="M(\d+),(\d+)/u.exec(svg)
  assert.ok(first !== null, 'the module path must start with an absolute move')
  const margin = Math.min(Number(first[1]), Number(first[2]))
  assert.ok(margin >= 32, `quiet zone is ${String(margin)} units; four modules at cell size 8 need 32`)
  assert.ok(margin / size >= 0.1, `the quiet zone is ${String(Math.round((margin / size) * 100))}% of the code; the spec wants about 12-15%`)
})

await check('the settings status payload carries the state, the devices, and no key material', () => {
  const config = testConfig({ publicOrigin: 'https://dsh.example.test', rpID: 'dsh.example.test', serverPort: 3090 })
  const payload = buildStatus({
    configured: true,
    resolved: config,
    sources: { publicOrigin: 'patch', serverPort: 'default' },
    configError: null,
    enrolled: true,
    enrollmentPending: true,
    enrollmentExpiresAt: 5_000,
    hostKey: 'SHA256:pinned',
    passkeys: [{ id: 'cred-1', label: 'phone', createdAt: 1, lastUsedAt: 2, deviceType: 'multiDevice', backedUp: true }],
    gatewayListening: true,
    tunnel: { state: 'listening', kind: null, attempts: 1, channels: 2, since: 0, everListening: true, nextRetryAt: null, suspected: null, remote: 'vps:22', hostKey: 'SHA256:x', lastError: null },
    fence: { authority: 'dsh.example.test', status: 401 },
  })
  assert.equal(payload.configured, true)
  assert.equal(payload.configError, null)
  assert.equal(payload.effective.publicOrigin, 'https://dsh.example.test')
  assert.equal(payload.effective.serverPort, 3090)
  assert.equal(payload.effective.clientPort, config.target.port)
  assert.equal(payload.sources.publicOrigin, 'patch')
  // A disabled tunnel has no SSH port: the placeholder must not reach the form,
  // where it would be pre-filled and could be saved as if it were configured.
  assert.equal('tunnel.port' in payload.effective, false, 'a disabled tunnel must not publish an SSH port')
  assert.equal('tunnel.port' in payload.sources, false, 'nor may it claim that port came from somewhere')
  assert.equal(payload.info.bind, '127.0.0.1:3090')
  assert.equal(payload.info.rpID, 'dsh.example.test')
  assert.equal(payload.info.rpName, 'DeepSeek Harness')
  assert.equal(payload.info.stateFile, config.stateFile)
  assert.equal(payload.info.hostKey, 'SHA256:pinned')
  assert.equal(payload.info.passphraseSet, false)
  assert.equal(payload.info.sshEquivalent, null, 'a tunnel that is off has no command line to show')
  assert.equal(payload.enrollment.enrolled, true)
  assert.equal(payload.enrollment.pending, true)
  assert.equal(payload.enrollment.expiresAt, 5_000)
  assert.equal(payload.passkeys.length, 1)
  assert.equal(Object.hasOwn(payload.passkeys[0] ?? {}, 'publicKey'), false, 'key material must never reach the browser')
  assert.equal(payload.runtime.fence?.ok, true)
  // A token would have to come from somewhere: the payload's own shape has no
  // field for the link, so rather than assert the impossible, assert that the
  // live mint route is the only thing that ever returns one (covered below).

  // A retrying tunnel must carry its reason: the page shows it, and it is the
  // difference between "wait a moment" and "your SSH port is wrong".
  const failingTunnel = buildStatus({
    configured: true,
    resolved: config,
    sources: {},
    configError: null,
    enrolled: true,
    enrollmentPending: false,
    enrollmentExpiresAt: null,
    hostKey: null,
    passkeys: [],
    gatewayListening: true,
    tunnel: { state: 'reconnecting', kind: 'unreachable', attempts: 9, channels: 0, since: 0, everListening: false, nextRetryAt: 12_345, suspected: 'configuration', remote: 'vps:3090', hostKey: null, lastError: 'connect ECONNREFUSED 1.2.3.4:3090' },
    fence: null,
  })
  assert.equal(failingTunnel.runtime.tunnel?.state, 'reconnecting')
  assert.equal(failingTunnel.runtime.tunnel?.remote, 'vps:3090')
  assert.match(String(failingTunnel.runtime.tunnel?.lastError), /ECONNREFUSED/)
  // The classification and its consequences ride the payload: the page needs the
  // kind to say *what* to fix, and `suspected` to stop saying "reconnecting" about
  // a deployment that has never once been up.
  assert.equal(failingTunnel.runtime.tunnel?.kind, 'unreachable')
  assert.equal(failingTunnel.runtime.tunnel?.suspected, 'configuration')

  // The equivalent `ssh -R` line, so the port mapping is checkable without
  // reading any code — this is the very command a deployment reasons about.
  const tunneled = testConfig({
    publicOrigin: 'https://dsh.example.test',
    serverPort: 3090,
    tunnel: {
      enabled: true,
      host: '203.0.113.10',
      port: 22,
      user: 'root',
      privateKeyFile: 'C:\\Users\\me\\.ssh\\id_ed25519',
      remoteHost: '127.0.0.1',
      remotePort: 3090,
      passphraseSet: undefined,
    } as never,
  })
  assert.equal(
    sshEquivalent(tunneled),
    'ssh -i C:\\Users\\me\\.ssh\\id_ed25519 -p 22 -N -R 3090:127.0.0.1:3090 root@203.0.113.10',
  )
  // A mis-filled SSH port shows up in the line instead of hiding behind a
  // field name, which is exactly how the reported failure looked.
  assert.match(
    String(sshEquivalent({ ...tunneled, tunnel: { ...tunneled.tunnel, port: 3090 } })),
    / -p 3090 -N -R 3090:127\.0\.0\.1:3090 /,
  )
  assert.equal(sshEquivalent(testConfig()), null, 'a disabled tunnel describes nothing')
})

await check('the settings routes answer JSON and refuse bad writes', async () => {
  const registered: FetchRoute[] = []
  let removed: string[] = []
  let minted = 0
  let forgotten = 0
  let retried = 0
  let released = 0
  const source: RouteSource = {
    status: () => buildStatus({
      configured: true, resolved: null, sources: {}, configError: 'publicOrigin is not an absolute URL',
      enrolled: false, enrollmentPending: false, enrollmentExpiresAt: null, hostKey: null,
      passkeys: [], gatewayListening: false, tunnel: null, fence: null,
    }),
    removePasskey: async (id) => {
      if (id === 'missing') return { ok: false, reason: 'no such passkey' }
      removed.push(id)
      return { ok: true }
    },
    mintEnrollment: async () => {
      minted += 1
      return { url: `https://dsh.example.test/auth?token=one-time-${String(minted)}`, expiresAt: 12_345 }
    },
    forgetHostKey: async () => {
      forgotten += 1
      return { ok: true }
    },
    retryTunnel: async () => {
      retried += 1
      return { ok: true }
    },
    releaseStaleForward: async () => {
      released += 1
      return { ok: true, detail: 'ended sshd pid(s) 1234' }
    },
  }
  registerRoutes({ register: (route) => { registered.push(route) } }, source, silentLog)
  assert.deepEqual(
    registered.map(route => route.path).sort(),
    [STATUS_PATH, PASSKEY_REMOVE_PATH, ENROLL_MINT_PATH, TRUST_FORGET_PATH, TUNNEL_RETRY_PATH, TUNNEL_RELEASE_PATH].sort(),
  )
  const statusRoute = registered.find(route => route.path === STATUS_PATH)
  const removeRoute = registered.find(route => route.path === PASSKEY_REMOVE_PATH)
  const mintRoute = registered.find(route => route.path === ENROLL_MINT_PATH)
  const forgetRoute = registered.find(route => route.path === TRUST_FORGET_PATH)
  assert.ok(statusRoute !== undefined && removeRoute !== undefined && mintRoute !== undefined && forgetRoute !== undefined)

  const status = await statusRoute.fetch(new Request(`https://dsh.example.test${STATUS_PATH}`))
  assert.equal(status.status, 200)
  // These payloads describe live state and one of them carries a credential.
  assert.equal(status.headers.get('cache-control'), 'no-store')
  const body = await status.json() as { configError: string | null }
  assert.equal(body.configError, 'publicOrigin is not an absolute URL')

  const post = (value: unknown): Promise<Response> => removeRoute.fetch(new Request(`https://dsh.example.test${PASSKEY_REMOVE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  }))
  assert.equal((await post({ id: 'cred-1' })).status, 200)
  assert.deepEqual(removed, ['cred-1'])
  assert.equal((await post({ id: 'missing' })).status, 400)
  assert.equal((await post({})).status, 400, 'a body with no id is the caller\'s mistake')
  assert.equal((await post('not json')).status, 400)

  // Minting is the only way a link ever reaches a browser, and it arrives with
  // its QR already rendered.
  const mint = await mintRoute.fetch(new Request(`https://dsh.example.test${ENROLL_MINT_PATH}`, { method: 'POST' }))
  assert.equal(mint.status, 200)
  assert.equal(mint.headers.get('cache-control'), 'no-store')
  const mintBody = await mint.json() as { url: string, qr: string, expiresAt: number }
  assert.match(mintBody.url, /\/auth\?token=one-time-1$/)
  assert.match(mintBody.qr, /^data:image\/svg\+xml;base64,/)
  assert.equal(mintBody.expiresAt, 12_345)

  const forget = await forgetRoute.fetch(new Request(`https://dsh.example.test${TRUST_FORGET_PATH}`, { method: 'POST' }))
  assert.equal(forget.status, 200)
  assert.equal(forgotten, 1)

  const retryRoute = registered.find(route => route.path === TUNNEL_RETRY_PATH)
  assert.ok(retryRoute !== undefined)
  const retry = await retryRoute.fetch(new Request(`https://dsh.example.test${TUNNEL_RETRY_PATH}`, { method: 'POST' }))
  assert.equal(retry.status, 200)
  assert.equal(retried, 1)

  const releaseRoute = registered.find(route => route.path === TUNNEL_RELEASE_PATH)
  assert.ok(releaseRoute !== undefined)
  const release = await releaseRoute.fetch(new Request(`https://dsh.example.test${TUNNEL_RELEASE_PATH}`, { method: 'POST' }))
  assert.equal(release.status, 200)
  assert.equal(released, 1)
  // The detail is the whole point of the answer: "released" without what was ended
  // would be unauditable.
  assert.match(JSON.stringify(await release.json()), /ended sshd pid\(s\) 1234/)

  const failing: RouteSource = {
    status: () => { throw new Error('boom') },
    removePasskey: async () => ({ ok: true }),
    mintEnrollment: async () => ({ ok: false, reason: 'the gateway is not running' }),
    forgetHostKey: async () => ({ ok: false, reason: 'nothing is pinned' }),
    retryTunnel: async () => ({ ok: false, reason: 'the GUI refuses this authority' }),
    releaseStaleForward: async () => ({ ok: false, reason: 'unavailable: this row does not allow it' }),
  }
  const captured: FetchRoute[] = []
  registerRoutes({ register: (route) => { captured.push(route) } }, failing, silentLog)
  const failingStatus = captured.find(route => route.path === STATUS_PATH)
  const failingMint = captured.find(route => route.path === ENROLL_MINT_PATH)
  const failingForget = captured.find(route => route.path === TRUST_FORGET_PATH)
  const failingRetry = captured.find(route => route.path === TUNNEL_RETRY_PATH)
  assert.ok(failingStatus !== undefined && failingMint !== undefined && failingForget !== undefined && failingRetry !== undefined)
  assert.equal((await failingStatus.fetch(new Request(`https://x${STATUS_PATH}`))).status, 500)
  // A refusal is the caller's answer, not a server error.
  assert.equal((await failingMint.fetch(new Request(`https://x${ENROLL_MINT_PATH}`, { method: 'POST' }))).status, 409)
  assert.equal((await failingForget.fetch(new Request(`https://x${TRUST_FORGET_PATH}`, { method: 'POST' }))).status, 409)
  // "You may not retry this" is a state the page renders (the fence still refuses),
  // so it is a 409 with the reason, never a 500.
  const refusedRetry = await failingRetry.fetch(new Request(`https://x${TUNNEL_RETRY_PATH}`, { method: 'POST' }))
  assert.equal(refusedRetry.status, 409)
  assert.match(JSON.stringify(await refusedRetry.json()), /refuses this authority/)

  const failingRelease = captured.find(route => route.path === TUNNEL_RELEASE_PATH)
  assert.ok(failingRelease !== undefined)
  const refusedRelease = await failingRelease.fetch(new Request(`https://x${TUNNEL_RELEASE_PATH}`, { method: 'POST' }))
  assert.equal(refusedRelease.status, 409, 'a release the row does not allow is a refusal, not a server error')
  assert.match(JSON.stringify(await refusedRelease.json()), /does not allow it/)
})

await check('apply() boots the gateway and mints one first-run enrollment link', async () => {
  const freePort = await serverPortForTest()

  // The state file is fixed under the home directory, so a check that must not
  // touch the operator's real passkeys scopes the home instead of a path.
  const home = join(workdir, 'home-first-run')
  const stateFile = join(home, '.dsh', 'dsh-sync-remote', 'state.json')
  const enrollFile = join(dirname(stateFile), 'enroll-url.txt')
  const { context, lines, effects, routes, authBases, release, connect } = harnessContext()
  try {
    await withEnv({ USERPROFILE: home, HOME: home }, async () => {
      await apply(context, {
        publicOrigin: 'https://dsh.example.test',
        serverPort: freePort,
        clientPort: upstreamPort,
        sessionTtlHours: 24,
        tunnel: { enabled: false },
      })
    })
    // A healthy start is nearly silent: routine detail — the ports, the probe
    // that answered, the resolved settings — belongs to the settings page, and
    // the console keeps only what a human has to act on.
    assert.equal(lines.some(line => line.includes('passkey gateway listening')), false, lines.join('\n'))
    assert.equal(lines.some(line => line.includes('reverse tunnel is disabled')), false, lines.join('\n'))
    assert.equal(lines.some(line => line.includes('accepts Host "dsh.example.test"')), false, lines.join('\n'))
    assert.ok(lines.some(line => line.includes('no passkey is registered yet')), lines.join('\n'))

    // The link is announced, written beside the state file, and it works.
    const match = lines.map(line => /\/auth\?token=([A-Za-z0-9_-]+)/u.exec(line)).find(found => found !== null)
    assert.ok(match !== null && match !== undefined, `no enrollment link was announced:\n${lines.join('\n')}`)
    const token = match[1]
    assert.match(await readFile(enrollFile, 'utf8'), new RegExp(`token=${String(token)}`))
    const page = await request(freePort, { path: `/auth?token=${String(token)}`, headers: { host: 'dsh.example.test', accept: 'text/html' } })
    assert.equal(page.status, 200)
    const wrong = await request(freePort, { path: '/auth?token=nope', headers: { host: 'dsh.example.test', accept: 'text/html' } })
    assert.equal(wrong.status, 403, 'only the minted token is accepted')

    connect()
    // The one line a healthy start adds, and it is the *local* GUI: the public
    // address `dsh web` prints belongs to a browser somewhere else.
    assert.ok(
      lines.includes(`info dsh-sync-remote: http://127.0.0.1:${String(upstreamPort)}/?token=test-process-token`),
      lines.join('\n'),
    )
    assert.deepEqual(authBases, [`http://127.0.0.1:${String(upstreamPort)}/`], 'the launch URL is asked of the Host, never assembled from a copied token')
    const statusRoute = routes.find(route => route.path === STATUS_PATH)
    const mintRoute = routes.find(route => route.path === ENROLL_MINT_PATH)
    assert.ok(statusRoute !== undefined && mintRoute !== undefined)
    const payload = await statusRoute.fetch(new Request(`https://dsh.example.test${STATUS_PATH}`)).then(response => response.json()) as {
      runtime: { gateway: string, tunnel: { state: string } | null },
      enrollment: { enrolled: boolean, pending: boolean, expiresAt: number | null },
      info: { bind: string | null, web: string | null, rpID: string | null, stateFile: string },
      effective: Record<string, unknown>,
    }
    assert.equal(payload.runtime.gateway, 'listening')
    assert.equal(payload.runtime.tunnel?.state, 'disabled')
    assert.equal(payload.enrollment.enrolled, false)
    assert.equal(payload.enrollment.pending, true)
    assert.equal(typeof payload.enrollment.expiresAt, 'number')
    assert.equal(payload.info.bind, `127.0.0.1:${String(freePort)}`)
    assert.equal(payload.info.web, `http://127.0.0.1:${String(upstreamPort)}`)
    assert.equal(payload.info.rpID, 'dsh.example.test')
    assert.equal(payload.info.stateFile, stateFile)
    assert.equal(JSON.stringify(payload).includes('enroll?token='), false, 'the polled payload must never carry the token')

    // Minting replaces the link, rewrites the file, and retires the old token.
    const minted = await mintRoute.fetch(new Request(`https://dsh.example.test${ENROLL_MINT_PATH}`, { method: 'POST' }))
      .then(response => response.json()) as { url: string, qr: string }
    assert.match(minted.url, /\/auth\?token=/)
    assert.match(minted.qr, /^data:image\/svg\+xml;base64,/)
    assert.equal((await readFile(enrollFile, 'utf8')).trim(), minted.url)
    const retired = await request(freePort, { path: `/auth?token=${String(token)}`, headers: { host: 'dsh.example.test', accept: 'text/html' } })
    assert.equal(retired.status, 403, 'the replaced link must stop working')
  } finally {
    // Disposal lives here so a failed assertion above cannot leak a listener and
    // leave the whole run hanging on it.
    for (const dispose of effects) await dispose()
    // A link outlives nothing: not its use, and not the process that minted it.
    await assert.rejects(() => stat(enrollFile), /ENOENT/)
    // Either refusal spelling proves the listener is gone; a reset can arrive
    // first when the OS still holds the closed socket briefly.
    await assert.rejects(
      () => request(freePort, { path: '/status', headers: { host: `127.0.0.1:${String(freePort)}` } }),
      /ECONNREFUSED|ECONNRESET/,
    )
    release()
  }
})

await check('a registered gateway mints nothing until the settings page asks', async () => {
  // Regression: an earlier version deleted the link file as soon as one
  // credential existed, which left the operator unable to enroll a second
  // device. The rule now is the opposite of permanent: nothing is minted until
  // asked, and the file only exists while the link it names does.
  const home = join(workdir, 'home-enrolled')
  const stateFile = join(home, '.dsh', 'dsh-sync-remote', 'state.json')
  const enrollFile = join(dirname(stateFile), 'enroll-url.txt')
  await withEnv({ USERPROFILE: home, HOME: home }, async () => {
    const seeded = new StateStore(stateFile)
    await seeded.load()
    seeded.state.passkeys.push({
      id: 'seeded-credential', publicKey: 'AAAA', counter: 3, transports: ['internal'], label: 'first device', createdAt: 1,
      lastUsedAt: null, deviceType: null, backedUp: null,
    })
    await seeded.persist()
  })

  const freePort = await serverPortForTest()
  const { context, lines, effects, routes, release, connect } = harnessContext()
  try {
    await withEnv({ USERPROFILE: home, HOME: home }, async () => {
      await apply(context, {
        publicOrigin: 'https://dsh.example.test',
        serverPort: freePort,
        clientPort: upstreamPort,
        sessionTtlHours: 24,
        tunnel: { enabled: false },
      })
    })
    // A healthy, already-enrolled start says nothing at all: the console is not
    // a status feed, and the settings page is where the devices, the ports, and
    // the tunnel state show up.
    assert.equal(lines.length, 0, lines.join('\n'))
    await assert.rejects(() => stat(enrollFile), /ENOENT/, 'no link file may exist without a link')

    connect()
    // …except the one line that tells the operator where the local GUI is.
    assert.deepEqual(
      lines,
      [`info dsh-sync-remote: http://127.0.0.1:${String(upstreamPort)}/?token=test-process-token`],
      'a normal start adds exactly one line',
    )
    const mintRoute = routes.find(route => route.path === ENROLL_MINT_PATH)
    assert.ok(mintRoute !== undefined)
    const minted = await mintRoute.fetch(new Request(`https://dsh.example.test${ENROLL_MINT_PATH}`, { method: 'POST' }))
      .then(response => response.json()) as { url: string, qr: string }
    assert.equal((await readFile(enrollFile, 'utf8')).trim(), minted.url)
    const page = await request(freePort, {
      path: minted.url.replace('https://dsh.example.test', ''),
      headers: { host: 'dsh.example.test', accept: 'text/html' },
    })
    assert.equal(page.status, 200, 'the link the settings page minted must work')
  } finally {
    // Disposal lives here so a failed assertion above cannot leak a listener.
    for (const dispose of effects) await dispose()
    await assert.rejects(() => stat(enrollFile), /ENOENT/)
    release()
  }
})

await check('retiring a link kills the token and its file', async () => {
  const home = join(workdir, 'home-retire')
  const stateFile = join(home, '.dsh', 'dsh-sync-remote', 'state.json')
  const enrollFile = join(dirname(stateFile), 'enroll-url.txt')
  const store = new StateStore(stateFile)
  const state = await withEnv({ USERPROFILE: home, HOME: home }, () => store.load())
  const config = testConfig({ publicOrigin: 'https://dsh.example.test', stateFile })
  const passkeys = new PasskeyService({ rpID: config.rpID, rpName: config.rpName, origin: config.publicOrigin, state, store, log: silentLog })
  let changes = 0
  const manager = new Gateway({
    config, passkeys, store, log: silentLog,
    onEnrollmentChange: async (url) => {
      changes += 1
      if (url === null) await rm(enrollFile, { force: true })
      else await writeFile(enrollFile, `${url}\n`, { encoding: 'utf8', mode: 0o600 })
    },
  })
  const first = await manager.mintEnrollment()
  assert.equal(manager.hasPendingEnrollment(), true)
  assert.equal(manager.enrollmentUrl(), first.url)
  assert.match(first.url, /\/auth\?token=/)
  assert.equal(await readFile(enrollFile, 'utf8'), `${first.url}\n`)
  // A successful registration is exactly this call; no authenticator is needed
  // to prove that a used link stops working.
  await manager.retireEnrollment()
  assert.equal(manager.hasPendingEnrollment(), false)
  assert.equal(manager.enrollmentUrl(), null)
  assert.equal(manager.enrollmentExpiresAt(), null)
  await assert.rejects(() => stat(enrollFile), /ENOENT/)
  assert.equal(changes, 2, 'the host sees both edges: minted and retired')
  // Retiring twice is a no-op, not a second notification.
  await manager.retireEnrollment()
  assert.equal(changes, 2)
})

await check('a link nobody uses expires in ten minutes and takes its file with it', async () => {
  assert.equal(ENROLL_TOKEN_TTL_MS, 10 * 60 * 1000, 'ten minutes is what the settings page promises')
  const home = join(workdir, 'home-expiry')
  const stateFile = join(home, '.dsh', 'dsh-sync-remote', 'state.json')
  const enrollFile = join(dirname(stateFile), 'enroll-url.txt')
  const store = new StateStore(stateFile)
  const state = await withEnv({ USERPROFILE: home, HOME: home }, () => store.load())
  const config = testConfig({ publicOrigin: 'https://dsh.example.test', stateFile })
  const passkeys = new PasskeyService({ rpID: config.rpID, rpName: config.rpName, origin: config.publicOrigin, state, store, log: silentLog })
  let cleared = 0
  const manager = new Gateway({
    config, passkeys, store, log: silentLog,
    onEnrollmentChange: async (url) => {
      if (url === null) { cleared += 1; await rm(enrollFile, { force: true }) }
      else await writeFile(enrollFile, `${url}\n`, { encoding: 'utf8', mode: 0o600 })
    },
  })
  // A zero lifetime drives the same branch a real ten-minute wait would take.
  const expired = await manager.mintEnrollment(0)
  assert.equal(await readFile(enrollFile, 'utf8'), `${expired.url}\n`)
  assert.equal(manager.hasPendingEnrollment(), false, 'an expired link is not pending')
  assert.equal(manager.enrollmentUrl(), null)
  assert.equal(manager.enrollmentExpiresAt(), null)
  // The host learns about it without anyone asking the gateway again. The
  // callback removes the file asynchronously, so poll the observable end state
  // rather than the call count.
  assert.ok(
    await untilAsync(async () => !(await stat(enrollFile).then(() => true, () => false))),
    'expiry must remove the enrollment file',
  )
  assert.equal(cleared, 1, 'expiry retires the file exactly once')
  await assert.rejects(() => stat(enrollFile), /ENOENT/)

  // And the gateway refuses that URL over HTTP, which is what a human sees.
  const live = await gateway.mintEnrollment(0)
  const refused = await request(port, {
    path: new URL(live.url).pathname + new URL(live.url).search,
    headers: { host: publicHost, accept: 'text/html' },
  })
  assert.equal(refused.status, 403)
})

await check('apply() stays idle when no public origin is configured', async () => {
  const { context, lines, effects, routes, release, connect } = harnessContext()
  try {
    await apply(context, {})
    assert.equal(effects.length, 0)
    connect()
    assert.deepEqual(routes.map(route => route.path).sort(),
      [STATUS_PATH, PASSKEY_REMOVE_PATH, ENROLL_MINT_PATH, TRUST_FORGET_PATH, TUNNEL_RETRY_PATH, TUNNEL_RELEASE_PATH].sort(),
      'the settings routes are registered even while nothing serves')
    assert.ok(lines.some(line => line.includes('public access stays off')), lines.join('\n'))
    // Nothing serves yet, so there is no local entry line to add either.
    assert.equal(lines.some(line => line.includes('http://127.0.0.1:')), false, lines.join('\n'))
    // "Nothing configured yet" is guidance, not a failure: the page must show the
    // neutral "name an origin" banner rather than a red one naming a missing value.
    const statusRoute = routes.find(route => route.path === STATUS_PATH)
    assert.ok(statusRoute !== undefined)
    const payload = await statusRoute.fetch(new Request(`https://dsh.example.test${STATUS_PATH}`)).then(response => response.json()) as {
      configured: boolean, configError: string | null, runtime: { gateway: string }, enrollment: { pending: boolean },
    }
    assert.equal(payload.configured, false)
    assert.equal(payload.configError, null, 'an unconfigured row is not a refused configuration')
    assert.equal(payload.runtime.gateway, 'off')
    assert.equal(payload.enrollment.pending, false)
  } finally {
    release()
  }
})

await check('apply() reports a refused configuration instead of unloading the row', async () => {
  // The settings page is how a bad value gets fixed, and a failed row vanishes
  // from the settings service along with that page. So a refusal is logged,
  // reported, and keeps the row active — with the gateway down.
  const { context, lines, effects, routes, release, connect } = harnessContext()
  try {
    await apply(context, { publicOrigin: 'not a url' })
    assert.equal(effects.length, 0, 'a refused configuration must not bind a listener')
    assert.ok(lines.some(line => line.includes('refusing to serve until the configuration is fixed')), lines.join('\n'))
    assert.ok(lines.some(line => line.includes('not an absolute URL')), lines.join('\n'))
    connect()
    const statusRoute = routes.find(route => route.path === STATUS_PATH)
    assert.ok(statusRoute !== undefined, 'the status route must exist even when the row is misconfigured')
    const payload = await statusRoute.fetch(new Request(`https://dsh.example.test${STATUS_PATH}`)).then(response => response.json()) as {
      configured: boolean, configError: string | null,
      enrollment: { pending: boolean },
      runtime: { gateway: string },
      sources: Record<string, string>,
    }
    assert.equal(payload.configured, true, 'a refused configuration is still "configured": it is the page that says so')
    assert.match(String(payload.configError), /not an absolute URL/)
    assert.equal(payload.enrollment.pending, false)
    assert.equal(payload.runtime.gateway, 'off')
    // Resolution still reports how far it got, field by field.
    assert.equal(payload.sources.rpID, undefined)
  } finally {
    release()
  }
})

await check('apply() wires the settings routes and the sign-in redirect to a connection service', async () => {
  const freePort = await serverPortForTest()
  const home = join(workdir, 'home-settings')
  const { context, lines, effects, routes, authBases, release, connect } = harnessContext()
  try {
    await withEnv({ USERPROFILE: home, HOME: home }, async () => {
      await apply(context, {
        publicOrigin: 'https://dsh.example.test',
        serverPort: freePort,
        clientPort: upstreamPort,
        sessionTtlHours: 24,
        tunnel: { enabled: false },
      })
    })
    connect()
    // The startup line, with the token the Host handed out rather than a copy.
    // (This home has no passkey yet, so the one-time enrollment notice above is
    // on the console too — that notice is meant to be there.)
    assert.ok(
      lines.includes(`info dsh-sync-remote: http://127.0.0.1:${String(upstreamPort)}/?token=test-process-token`),
      lines.join('\n'),
    )
    assert.deepEqual(authBases, [`http://127.0.0.1:${String(upstreamPort)}/`])
    assert.deepEqual(routes.map(route => route.path).sort(),
      [STATUS_PATH, PASSKEY_REMOVE_PATH, ENROLL_MINT_PATH, TRUST_FORGET_PATH, TUNNEL_RETRY_PATH, TUNNEL_RELEASE_PATH].sort())
    // This instance has its own state file (its own home), so its session is
    // minted from that secret rather than the main harness one.
    const ownSecret = (await loadState(join(home, '.dsh', 'dsh-sync-remote', 'state.json'))).secret
    const ownSession = createSession(ownSecret, { ttlMs: 60_000, audience: 'session', credentialId: 'settings-check' })
    const ownCookie = `${SESSION_COOKIE}=${ownSession.value}`
    const statusRoute = routes.find(route => route.path === STATUS_PATH)
    const removeRoute = routes.find(route => route.path === PASSKEY_REMOVE_PATH)
    const forgetRoute = routes.find(route => route.path === TRUST_FORGET_PATH)
    assert.ok(statusRoute !== undefined && removeRoute !== undefined && forgetRoute !== undefined)
    const payload = await statusRoute.fetch(new Request(`https://dsh.example.test${STATUS_PATH}`)).then(response => response.json()) as {
      runtime: { gateway: string, tunnel: { state: string } | null },
      enrollment: { enrolled: boolean, pending: boolean },
      info: { passphraseSet: boolean, hostKey: string | null },
      effective: Record<string, unknown>,
    }
    assert.equal(payload.runtime.gateway, 'listening')
    assert.equal(payload.runtime.tunnel?.state, 'disabled')
    assert.equal(payload.enrollment.enrolled, false)
    assert.equal(payload.enrollment.pending, true, 'a first run mints a link')
    assert.equal(payload.effective.publicOrigin, 'https://dsh.example.test')
    assert.equal(payload.effective.serverPort, freePort)
    assert.equal(payload.effective.clientPort, upstreamPort)
    assert.equal(payload.effective.sessionTtlHours, 24)
    assert.equal(payload.info.passphraseSet, false)
    assert.equal(payload.info.hostKey, null)

    // Removing a device that does not exist is refused by the host, not faked.
    const removal = await removeRoute.fetch(new Request(`https://dsh.example.test${PASSKEY_REMOVE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'whatever' }),
    }))
    assert.equal(removal.status, 400)
    assert.match(JSON.stringify(await removal.json()), /no such passkey|last passkey/)

    // Nothing is pinned on a disabled tunnel, so there is nothing to forget.
    const forget = await forgetRoute.fetch(new Request(`https://dsh.example.test${TRUST_FORGET_PATH}`, { method: 'POST' }))
    assert.equal(forget.status, 409)

    // The auto sign-in redirect: DSH answers a navigation with 401 because this
    // browser has no DSH cookie of its own, and the gateway turns that into one
    // redirect through the launch URL instead of showing a sign-in page.
    const redirected = await request(freePort, {
      path: '/api',
      headers: { host: 'dsh.example.test', cookie: ownCookie, accept: 'text/html' },
    })
    assert.equal(redirected.status, 303)
    assert.equal(redirected.headers.location, 'https://dsh.example.test/api?token=test-process-token')
    assert.match(String(redirected.headers['set-cookie']), /dsh-gw-autologin=1/)
    // Once tried, the real answer passes through rather than looping.
    const passedThrough = await request(freePort, {
      path: '/api',
      headers: { host: 'dsh.example.test', cookie: `${ownCookie}; dsh-gw-autologin=1`, accept: 'text/html' },
    })
    assert.equal(passedThrough.status, 401)
    // An XHR must see the 401 itself, not a 303 to an HTML page.
    const xhr = await request(freePort, {
      path: '/api',
      headers: { host: 'dsh.example.test', cookie: ownCookie, accept: 'application/json', 'sec-fetch-dest': 'empty' },
    })
    assert.equal(xhr.status, 401)

    // The auto sign-in redirect asks for the public launch URL through the same
    // live channel the startup line used, so both carry the current token.
    assert.deepEqual(authBases, [
      `http://127.0.0.1:${String(upstreamPort)}/`,
      'https://dsh.example.test/api',
    ])
  } finally {
    for (const dispose of effects) await dispose()
    release()
  }
})

await check('the startup line follows the live launch token instead of a baked-in one', async () => {
  // The token belongs to the running DSH process, not to this bundle, so the
  // line has to be built from whatever the connection service hands out at the
  // moment it is printed. Two rounds with two different tokens are what a Host
  // reload or a fresh `dsh web` looks like from inside this plugin.
  const home = join(workdir, 'home-entry-line')
  const stateFile = join(home, '.dsh', 'dsh-sync-remote', 'state.json')
  await withEnv({ USERPROFILE: home, HOME: home }, async () => {
    const seeded = new StateStore(stateFile)
    await seeded.load()
    seeded.state.passkeys.push({
      id: 'seeded-credential', publicKey: 'AAAA', counter: 1, transports: ['internal'], label: 'first device', createdAt: 1,
      lastUsedAt: null, deviceType: null, backedUp: null,
    })
    await seeded.persist()
  })

  for (const token of ['launch-token-1', 'launch-token-2']) {
    const freePort = await serverPortForTest()
    const { context, lines, effects, authBases, release, connect } = harnessContext(token)
    try {
      await withEnv({ USERPROFILE: home, HOME: home }, async () => {
        await apply(context, {
          publicOrigin: 'https://dsh.example.test',
          serverPort: freePort,
          clientPort: upstreamPort,
          sessionTtlHours: 24,
          tunnel: { enabled: false },
        })
      })
      connect()
      assert.deepEqual(
        lines,
        [`info dsh-sync-remote: http://127.0.0.1:${String(upstreamPort)}/?token=${token}`],
        lines.join('\n'),
      )
      assert.deepEqual(authBases, [`http://127.0.0.1:${String(upstreamPort)}/`])
    } finally {
      for (const dispose of effects) await dispose()
      release()
    }
  }
})

await check('the fence probe waits for boot instead of racing it', async () => {
  // `/api` answers 404 until its route owner mounts, so a probe that wins that
  // race reports a fault the deployment does not have. The plugin asks the
  // Loader when boot finished first; until then a stand-in GUI that keeps
  // answering 404 must produce no line at all.
  const cold = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  const coldPort = await listen(cold)
  const freePort = await serverPortForTest()

  let releaseBoot = (): void => {}
  const settled = new Promise<void>(resolve => { releaseBoot = resolve })
  const home = join(workdir, 'home-probe-wait')
  const { context, lines, effects, release } = harnessContext('test-process-token', { await: () => settled })
  /** @returns whether the captured console carries `text` yet. */
  const printed = (text: string): boolean => lines.some(line => line.includes(text))
  try {
    await withEnv({ USERPROFILE: home, HOME: home }, async () => {
      await apply(context, {
        publicOrigin: 'https://dsh.example.test',
        serverPort: freePort,
        clientPort: coldPort,
        sessionTtlHours: 24,
        tunnel: { enabled: false },
      })
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(printed('expected 401'), false, `the probe must not run while the tree is still mounting:\n${lines.join('\n')}`)

    releaseBoot()
    assert.ok(
      await until(() => printed('answered HTTP 404 for Host "dsh.example.test"; expected 401')),
      `the probe must run — and report — once boot is done:\n${lines.join('\n')}`,
    )
  } finally {
    for (const dispose of effects) await dispose()
    release()
    cold.closeAllConnections()
    cold.close()
  }
})

await check('a refused fence closes the tunnel before it ever opens', async () => {
  // The bug this check exists for: the tunnel used to be requested before the
  // fence was asked, so a GUI started without `--trusted-host` got a live,
  // authenticated, completely unusable deployment published to the internet —
  // a login page in front of an `/api` that answers 403 to everything.
  //
  // The proof that `TunnelManager.start()` was never reached is the key file:
  // this row names one that does not exist, so any path that reaches `start()`
  // must log the read failure. A blocked gate logs no such line.
  //
  // The stand-in also records the Host it was asked about: the fence is the only
  // thing that decides, and it must be asked about the authority *browsers* use
  // (the row's public origin), not about "some authority is configured".
  let probedHost: string | undefined
  const refused = createServer((req, res) => {
    probedHost = req.headers.host
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('forbidden')
  })
  const refusedPort = await listen(refused)
  const freePort = await serverPortForTest()
  const home = join(workdir, 'home-fence-blocked')
  const { context, lines, effects, routes, release, connect } = harnessContext()
  /** @returns whether the captured console carries `text`. */
  const printed = (text: string): boolean => lines.some(line => line.includes(text))
  try {
    await withEnv({ USERPROFILE: home, HOME: home }, async () => {
      await apply(context, {
        publicOrigin: 'https://dsh.example.test',
        serverPort: freePort,
        clientPort: refusedPort,
        sessionTtlHours: 24,
        // A closed port and a missing key: even if a future edit did open the
        // tunnel here, this fixture could not reach anything.
        tunnel: { enabled: true, host: '127.0.0.1', port: 1, user: 'root', privateKeyFile: join(home, 'absent-key') },
      })
    })
    assert.ok(
      await until(() => printed('the reverse tunnel stays closed')),
      `the refusal must reach the console:\n${lines.join('\n')}`,
    )
    assert.equal(
      printed('cannot read the SSH private key'),
      false,
      `the tunnel must never be started when the fence refuses:\n${lines.join('\n')}`,
    )
    assert.match(lines.find(line => line.includes('the reverse tunnel stays closed')) ?? '', /--trusted-host "dsh\.example\.test"/)
    // A `--trusted-host` naming a different host is the same refusal: the probe
    // asks about this row's public origin, so an authority that is not it is
    // simply not trusted.
    assert.equal(probedHost, 'dsh.example.test', 'the fence must be asked about the authority browsers use')

    connect()
    const statusRoute = routes.find(route => route.path === STATUS_PATH)
    assert.ok(statusRoute !== undefined)
    const payload = await statusRoute.fetch(new Request(`https://dsh.example.test${STATUS_PATH}`)).then(response => response.json()) as {
      runtime: { gateway: string, tunnel: { state: string, attempts: number, lastError: string | null } | null, fence: { status: number, ok: boolean } | null },
      info: { remoteBind: string | null, sshEquivalent: string | null },
    }
    // The gateway stays up: it is what serves this page and the local GUI.
    assert.equal(payload.runtime.gateway, 'listening')
    assert.equal(payload.runtime.tunnel?.state, 'blocked')
    assert.equal(payload.runtime.tunnel?.attempts, 0, 'a blocked tunnel never dials the VPS')
    assert.match(payload.runtime.tunnel?.lastError ?? '', /--trusted-host/)
    assert.equal(payload.runtime.fence?.status, 403)
    assert.equal(payload.runtime.fence?.ok, false)
    // Where it would have listened is still reported: that is what the operator
    // checks against `ss -ltnp` on the VPS to confirm nothing is exposed. The
    // VPS-side port follows this row's gateway port, as `sshEquivalent` shows.
    assert.equal(payload.info.remoteBind, `127.0.0.1:${String(freePort)}`)
    assert.ok(payload.info.sshEquivalent !== null)
  } finally {
    for (const dispose of effects) await dispose()
    release()
    refused.closeAllConnections()
    refused.close()
  }
})

await check('an accepting fence still opens the tunnel', async () => {
  // The other half of the contract: the gate must not become a way to keep a
  // correctly launched deployment down. The stand-in upstream answers `/api`
  // with 401, which is what a fence that accepts the Host says.
  const freePort = await serverPortForTest()
  const home = join(workdir, 'home-fence-accepted')
  const { context, lines, effects, release } = harnessContext()
  /** @returns whether the captured console carries `text`. */
  const printed = (text: string): boolean => lines.some(line => line.includes(text))
  try {
    await withEnv({ USERPROFILE: home, HOME: home }, async () => {
      await apply(context, {
        publicOrigin: 'https://dsh.example.test',
        serverPort: freePort,
        clientPort: upstreamPort,
        sessionTtlHours: 24,
        tunnel: { enabled: true, host: '127.0.0.1', port: 1, user: 'root', privateKeyFile: join(home, 'absent-key') },
      })
    })
    assert.ok(
      await until(() => printed('cannot read the SSH private key')),
      `the tunnel must be started once the fence accepts:\n${lines.join('\n')}`,
    )
    assert.equal(printed('the reverse tunnel stays closed'), false, lines.join('\n'))
  } finally {
    for (const dispose of effects) await dispose()
    release()
  }
})

await check('an indeterminate fence answer is re-asked before it blocks', async () => {
  // `/api` answers 404 until its route owner mounts, and a stalled or restarting
  // GUI answers nothing at all. Those describe the moment, not the deployment, so
  // the gate re-asks before it closes the public entry for the life of the row.
  let asked = 0
  const flaky = createServer((_req, res) => {
    asked += 1
    if (asked < 3) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('unauthorized')
  })
  const flakyPort = await listen(flaky)
  const freePort = await serverPortForTest()
  const home = join(workdir, 'home-fence-flaky')
  const { context, lines, effects, release } = harnessContext()
  /** @returns whether the captured console carries `text`. */
  const printed = (text: string): boolean => lines.some(line => line.includes(text))
  try {
    await withEnv({ USERPROFILE: home, HOME: home }, async () => {
      await apply(context, {
        publicOrigin: 'https://dsh.example.test',
        serverPort: freePort,
        clientPort: flakyPort,
        sessionTtlHours: 24,
        tunnel: { enabled: true, host: '127.0.0.1', port: 1, user: 'root', privateKeyFile: join(home, 'absent-key') },
      })
    })
    assert.ok(
      await until(() => printed('cannot read the SSH private key'), 5_000),
      `a 404 that turns into a 401 must still open the tunnel:\n${lines.join('\n')}`,
    )
    assert.ok(asked >= 3, `the first 404s must be re-asked, not taken as final (asked ${String(asked)})`)
    assert.equal(printed('the reverse tunnel stays closed'), false, lines.join('\n'))
  } finally {
    for (const dispose of effects) await dispose()
    release()
    flaky.closeAllConnections()
    flaky.close()
  }
})

await check('a trusted host that is not this deployment is named in the refusal', async () => {
  // The exact mistake behind this check: `--trusted-host` *was* passed, but with a
  // different host. The fence still answers 403 and the tunnel still stays closed —
  // and the message has to say which authorities the GUI actually trusts, instead
  // of repeating "add --trusted-host" at an operator who already did.
  const refused = createServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('forbidden')
  })
  const refusedPort = await listen(refused)
  const freePort = await serverPortForTest()
  const home = join(workdir, 'home-fence-wrong-trust')
  const { context, lines, effects, release } = harnessContext('test-process-token', undefined, {
    webStartup: { trustedHosts: ['other.example.test', 'lab.internal'], publicUrl: 'https://other.example.test' },
  })
  /** @returns whether the captured console carries `text`. */
  const printed = (text: string): boolean => lines.some(line => line.includes(text))
  try {
    await withEnv({ USERPROFILE: home, HOME: home }, async () => {
      await apply(context, {
        publicOrigin: 'https://dsh.example.test',
        serverPort: freePort,
        clientPort: refusedPort,
        sessionTtlHours: 24,
        tunnel: { enabled: true, host: '127.0.0.1', port: 1, user: 'root', privateKeyFile: join(home, 'absent-key') },
      })
    })
    assert.ok(await until(() => printed('the reverse tunnel stays closed')), lines.join('\n'))
    const line = lines.find(candidate => candidate.includes('the reverse tunnel stays closed')) ?? ''
    assert.match(line, /"other\.example\.test", "lab\.internal"/, line)
    assert.match(line, /not the authority browsers use here/, line)
    // `--public-url` is advertising, not trust: a mismatch earns one warning, never
    // a refusal (the tunnel's gate is the probe and nothing else).
    assert.ok(printed('dsh web advertises'), lines.join('\n'))
    assert.equal(printed('cannot read the SSH private key'), false, lines.join('\n'))
  } finally {
    for (const dispose of effects) await dispose()
    release()
    refused.closeAllConnections()
    refused.close()
  }
})

await gateway.close()
// The proxy leaves pooled upstream connections open on purpose; close them
// explicitly or the stand-in server waits forever and the process never exits.
upstream.closeAllConnections()
upstream.close()
await rm(workdir, { recursive: true, force: true })

// ── source hygiene: the shapes this project promised to keep ────────────────
// These are the checks that make the two refactors self-enforcing: a TypeScript
// client half that is really built (not hand-written JS), flat gateway paths with
// no namespace, and one source of truth for a URL.

/** Every file under `dir`, recursively, skipping build output and dependencies. */
async function walk(dir: string, skip: ReadonlySet<string> = new Set(['node_modules', 'lib', '.git'])): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await walk(full, skip))
    else found.push(full)
  }
  return found
}

await check('the browser halves are built from TypeScript, not hand-written JS', async () => {
  const root = process.cwd()
  // One source of truth per browser half, both of them TypeScript.
  for (const source of ['src/client.ts', 'src/app.ts']) await stat(join(root, source))
  const stray = (await walk(join(root, 'src')))
    .map(file => file.slice(root.length + 1).replaceAll('\\', '/'))
    .filter(file => file.endsWith('.js'))
  assert.deepEqual(stray, [], `no hand-written .js may live in src/: ${stray.join(', ')}`)

  // The built artifacts exist, and each half is loaded the way it is written:
  // the page script is an ES module (`<script type="module">`, which is also what
  // lets it use top-level await), while the client half is handed to DSH's module
  // table through a **classic script** — DSH appends `<script async src>` with no
  // `type="module"`, and its own bundles are emitted as CJS for exactly that
  // reason. A stray `export {}` in `client.ts` (the tidiest way to make a file a
  // TS module) therefore ships a bundle the browser refuses to parse, and the
  // settings page goes blank with "Unexpected token 'export'". That mistake was
  // made once while writing this; this assertion is what makes it impossible to
  // repeat silently.
  const app = await readFile(join(root, 'lib/app.js'), 'utf8')
  const client = await readFile(join(root, 'lib/client.js'), 'utf8')
  assert.ok(app.length > 0 && client.length > 0, 'the build must produce both artifacts')
  assert.match(app, /export\s*\{/, 'lib/app.js must be emitted as an ES module')
  assert.equal(/^export\b/mu.test(client), false, 'lib/client.js is a classic script and must not use ESM export syntax')
  assert.equal(/^import\b/mu.test(client), false, 'lib/client.js is a classic script and must not use ESM import syntax')
  assert.equal(/require\(/u.test(app), false, 'lib/app.js is a browser module: it can reach nothing through require')
  // The browser resolves nothing, so a relative specifier in either artifact is a
  // page that fails to load. A value import in client.ts would produce exactly
  // that, which is why this is asserted rather than assumed.
  for (const [name, artifact] of [['lib/app.js', app], ['lib/client.js', client]] as const) {
    assert.equal(/from\s+'\.\//u.test(artifact), false, `${name} must not import a relative path`)
    assert.equal(/require\('\.\//u.test(artifact), false, `${name} must not require a relative path`)
  }
  assert.match(client, /__ModuleLoader__/u, 'the client half must still register through the module table')
})

await check('every URL the page script asks for is a gateway path', async () => {
  // One source of truth for a URL: the gateway owns `LOCAL_PATHS`, and the served
  // script may only name those. A rename in one place and not the other is the
  // failure this refactor could have introduced silently.
  const asked = [...APP_JS.matchAll(/\b(?:fetch|post)\(\s*'(\/[^']*)'/gu)].map(match => match[1] ?? '')
  assert.ok(asked.length >= 5, `the page script should ask for its steps: ${JSON.stringify(asked)}`)
  for (const path of asked) {
    assert.ok(LOCAL_PATHS.has(path), `${path} is not one of the gateway's paths: ${[...LOCAL_PATHS].join(', ')}`)
  }
})

await check('the client bundle names exactly the Host routes that exist', async () => {
  // The client half is a classic script: it cannot import `routes.ts`, so its
  // `/api/sync-remote.*` literals are a hand-written copy of the Host's authority
  // (a copy is structurally forced — no bundler, no imports). Nothing else
  // connects the two, so this is what connects them: rename a route on one side
  // and the settings page would 404 in silence.
  const bundle = await readFile(join(process.cwd(), 'lib/client.js'), 'utf8')
  const declared = new Set([STATUS_PATH, ENROLL_MINT_PATH, PASSKEY_REMOVE_PATH, TRUST_FORGET_PATH, TUNNEL_RETRY_PATH, TUNNEL_RELEASE_PATH])
  const named = new Set([...bundle.matchAll(/\/api\/sync-remote\.[A-Za-z.]+/gu)].map(match => match[0]))
  assert.ok(named.size >= declared.size, `the bundle should talk to every route: ${[...named].join(', ')}`)
  for (const route of named) {
    assert.ok(declared.has(route), `${route} is not a Host route: ${[...declared].join(', ')}`)
  }
  for (const route of declared) {
    assert.ok(bundle.includes(route), `the bundle never mentions the Host route ${route}`)
  }
})

await check('the plugin carries no namespace prefix anywhere', async () => {
  // The gateway used to own a path prefix. It is gone, and this is the assertion
  // that keeps it gone: the literal is assembled so that no source file carries
  // it as a usable route while the check still names exactly what it forbids.
  const legacy = ['_', '_', 'gw'].join('')
  const files = [
    ...await walk(join(process.cwd(), 'src')),
    ...await walk(join(process.cwd(), 'test')),
    join(process.cwd(), 'README.md'),
    join(process.cwd(), 'package.json'),
  ]
  const offenders: string[] = []
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    if (text.includes(legacy)) offenders.push(file.slice(process.cwd().length + 1))
  }
  assert.deepEqual(offenders, [], `the removed path prefix reappeared in: ${offenders.join(', ')}`)
})

await check('every tunnel start in the composition goes through the fence gate', async () => {
  // The behaviour is covered above; this is the source-level half. A third call
  // site — a reconnection shortcut, a "trust again" fast path — would restore the
  // bug the gate exists for, and it would do so silently: the deployment would
  // look healthy while publishing a GUI that 403s every request.
  //
  // Exactly two are legitimate, and both are named here: `startTunnel`'s branch
  // for a row that turns the tunnel off (nothing to gate) and the gated start
  // itself. Any other `.start()` on the manager is the regression.
  const source = await readFile(join(process.cwd(), 'src/index.ts'), 'utf8')
  // Prose names the API too, and a comment about `tunnel.start()` is not a call
  // site; strip both comment forms so this measures code rather than wording.
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[ \t]*\/\/.*$/gmu, '')
  const direct = [...code.matchAll(/\btunnel\.start\(/gu)].length
  assert.equal(direct, 0, 'the manager must be started through the gate, never through a direct tunnel.start() call')
  const calls = [...code.matchAll(/\blive\.start\(\)/gu)].length
  assert.equal(calls, 2, `expected the disabled branch and the gated start, found ${String(calls)} call site(s)`)
  assert.ok(code.includes('const startTunnelWhenTrusted'), 'the gated starter must still exist')
})

console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
process.exitCode = failures === 0 ? 0 : 1

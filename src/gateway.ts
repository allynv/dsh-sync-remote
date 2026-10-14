/**
 * The public entry: a passkey gate in front of the local DSH Web GUI.
 *
 * This gateway is deliberately a *transparent* proxy. It forwards the request's
 * `Host`, `Origin`, `Referer`, and Fetch-Metadata headers unchanged, so the
 * GUI's own browser-trust fence, its signed session cookie, and its CSRF checks
 * all keep working exactly as they do on loopback: the passkey gate is an
 * additional door, not a replacement for the lock behind it.
 *
 * That is why `trustedHosts` must name the public authority: rewriting `Host`
 * to a loopback spelling would satisfy the fence but break DSH's
 * authority-bound session cookie, and stripping `Origin` would remove the
 * check that stops a cross-site request from riding a logged-in session.
 *
 * Everything that fails a check fails closed: an unauthenticated request never
 * reaches the upstream at all.
 *
 * @module @allynv/dsh-sync-remote/gateway
 */

import { timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { APP_JS, PAGE_CSP, renderPage } from './pages.ts'
import { CeremonyError, type PasskeyService } from './webauthn.ts'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { randomText } from './encoding.ts'
import {
  AUTOLOGIN_COOKIE,
  ENROLL_COOKIE,
  NEXT_COOKIE,
  SESSION_COOKIE,
  createSession,
  parseCookieHeader,
  serializeCookie,
  verifyEnrollment,
  verifySession,
  verifyValue,
  type SignedPayload,
} from './session-cookie.ts'
import type { ResolvedConfig } from './config.ts'
import type { StateStore } from './state.ts'
import type { TunnelManager } from './tunnel.ts'
import type { Logger } from './types.ts'

/** Headers the proxy may set on a response. */
type ProxyHeaders = Record<string, string | string[] | undefined>

/**
 * Canonical entry point for a one-time enrollment link.
 *
 * A human scans, reads, or pastes this URL: `/auth?token=...` is the whole
 * address a phone has to reach. Its ceremony steps are `/auth/options` and
 * `/auth/verify`.
 */
const AUTH_PATH = '/auth'

/** The enrollment panel: the page that runs the registration ceremony. */
const ENROLL_PATH = '/enroll'

/** The sign-in page: the address a person reads, types, or bookmarks. */
const LOGIN_PATH = '/signin'

/**
 * The machine-readable status path.
 *
 * A human types it into a shell or a monitoring script. It is guarded by the
 * read-only `statusToken` from the state file, never by the Host header.
 */
const STATUS_PATH = '/status'

/** Clears the gateway session; `POST` only. */
const LOGOUT_PATH = '/logout'

/** The login page's own script, and the capabilities it may need to decide with. */
const APP_JS_PATH = '/app.js'
const BOOTSTRAP_PATH = '/bootstrap'

/** Removes one registered passkey; `POST` only, and requires a session. */
const PASSKEYS_REMOVE_PATH = '/passkeys/remove'

/**
 * Every path this gateway answers itself, and therefore never proxies.
 *
 * Flat root paths, matched **exactly**: the first design parked everything under
 * one namespace prefix with a `startsWith` rule, and that rule over a short
 * namespace is a footgun of its own — `/statuses` or `/auth/extra` would be
 * swallowed with it. These names
 * are checked against the Web GUI's own surface: the served dist root holds only
 * `assets/`, `preview/`, `index.html`, `manifest.webmanifest` and two favicons,
 * and the static server maps a pathname onto that directory one-to-one, so none
 * of these shadows an existing route. A future DSH release could add one, which
 * is why the list stays explicit and short.
 */
export const LOCAL_PATHS: ReadonlySet<string> = new Set([
  AUTH_PATH,
  `${AUTH_PATH}/options`,
  `${AUTH_PATH}/verify`,
  ENROLL_PATH,
  `${ENROLL_PATH}/options`,
  `${ENROLL_PATH}/verify`,
  LOGIN_PATH,
  STATUS_PATH,
  LOGOUT_PATH,
  APP_JS_PATH,
  BOOTSTRAP_PATH,
  PASSKEYS_REMOVE_PATH,
])

/** Header carrying the read-only status token; the documented way to ask. */
const STATUS_HEADER = 'x-dsh-gw-status'

/** The four passkey ceremony steps, all `POST` and all rate-limited. */
const CEREMONY_PATHS: ReadonlySet<string> = new Set([
  `${AUTH_PATH}/options`,
  `${AUTH_PATH}/verify`,
  `${ENROLL_PATH}/options`,
  `${ENROLL_PATH}/verify`,
])

/**
 * Whether a path is served by this gateway itself, and therefore never
 * forwarded upstream, including as a WebSocket upgrade.
 * @param pathname - the request's path.
 * @returns true for a gateway-owned path.
 */
function isLocalPath(pathname: string): boolean {
  return LOCAL_PATHS.has(pathname)
}

/** How long a carried destination stays valid. */
const NEXT_TTL_MS = 10 * 60 * 1000

/** Enrollment grant lifetime once the one-time token has been presented. */
const ENROLL_TTL_MS = 15 * 60 * 1000

/**
 * How long a minted one-time enrollment link stays valid.
 *
 * Long enough to walk to the device being enrolled, short enough that a link
 * seen over a shoulder is worthless by the time anyone acts on it.
 */
export const ENROLL_TOKEN_TTL_MS = 10 * 60 * 1000

/** How long that marker suppresses a second redirect. */
const AUTOLOGIN_TTL_SECONDS = 60

/** Largest accepted JSON body from the browser. */
const MAX_BODY_BYTES = 64 * 1024

/** How long one ceremony body may take; see {@link readJsonBody}. */
const BODY_TIMEOUT_MS = 10_000

/** Wall-clock bound on receiving any one request, headers and body together. */
const REQUEST_TIMEOUT_MS = 120_000

/** Ceremony requests allowed per client key inside one window. */
const RATE_LIMIT = 30

/** Length of one rate-limit window. */
const RATE_WINDOW_MS = 5 * 60 * 1000

/** Added to each ceremony past the allowance, instead of refusing it outright. */
const RATE_DELAY_MS = 750

/** Cap on the rate-limit map, so distinct keys cannot grow it without bound. */
const MAX_RATE_KEYS = 4096

/** Cap on carried post-ceremony destinations; see {@link Gateway.rememberNext}. */
const MAX_PENDING_NEXT = 1024

/**
 * Headers that describe this hop only and must never be forwarded.
 *
 * `upgrade` and `connection` are *not* in this set: the plain-HTTP path removes
 * them explicitly, while the WebSocket path must forward them.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Headers dropped from a 101 response; the rest (including upgrade) pass through. */
const UPGRADE_RESPONSE_SKIP = new Set(['keep-alive', 'transfer-encoding', 'content-length'])

/** An HTTP failure with the status and message the caller should see. */
class HttpError extends Error {
  readonly status: number

  /**
   * @param status - HTTP status code.
   * @param message - body text.
   */
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/**
 * Compare two secrets without leaking their matching prefix length.
 * @param a - presented text.
 * @param b - expected text.
 * @returns true only when they are equal.
 */
function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

/**
 * Accept only a same-origin absolute path as the post-ceremony destination.
 *
 * A protocol-relative or absolute URL here would turn the login page into an
 * open redirect, which is exactly what an attacker would want on a page whose
 * whole purpose is authentication.
 * @param value - candidate path.
 * @returns the path, or undefined when it is not usable.
 */
export function safeNextPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined
  // A destination must not be one of this gateway's own endpoints: landing on a
  // ceremony path after a successful sign-in is a loop, not a destination.
  const pathname = value.split('?')[0] ?? value
  if (LOCAL_PATHS.has(pathname)) return undefined
  return value
}

/**
 * The pathname of a request target, dropping the query string.
 *
 * Failure logs used to print `req.url` verbatim, and a request like
 * `HEAD /auth?token=...`, exactly what a link unfurler or a bot sends, put the
 * one-time enrollment token into the log. The path alone is what a reader needs.
 * @param target - `req.url`, possibly undefined or absolute-form.
 * @returns the pathname, or `/` when the target cannot be parsed.
 */
function pathnameOf(target: string | undefined): string {
  try {
    return new URL(target ?? '/', 'http://gateway.invalid').pathname
  } catch {
    return '/'
  }
}

/**
 * Copy request headers across this hop, dropping hop-by-hop ones.
 *
 * One implementation for both the plain and the upgrade path: the upgrade path
 * used to filter only `keep-alive` and `proxy-*`, which let `te`, `trailer`, and
 * `transfer-encoding` cross the hop, and copied `connection`/`upgrade` only to
 * overwrite them.
 * @param req - incoming request.
 * @param overrides - headers this hop sets for the upstream.
 * @returns headers for the upstream request.
 */
function copyRequestHeaders(req: IncomingMessage, overrides: ProxyHeaders = {}): ProxyHeaders {
  const headers: ProxyHeaders = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name)) continue
    headers[name] = value
  }
  for (const [name, value] of Object.entries(overrides)) headers[name] = value
  return headers
}

/**
 * Copy an upstream response's headers.
 *
 * `dropHopByHop` exists for the 101 handshake: `connection` and `upgrade` are
 * hop-by-hop in general, but a Switching Protocols answer is meaningless without
 * them, so that one path keeps them while every other response drops them.
 * @param headers - upstream headers.
 * @param skip - additional names to drop.
 * @param dropHopByHop - whether the hop-by-hop set applies.
 * @returns headers for the browser.
 */
function copyResponseHeaders(headers: ProxyHeaders, skip: Set<string> = new Set(), dropHopByHop = true): ProxyHeaders {
  const out: ProxyHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (skip.has(name)) continue
    if (dropHopByHop && HOP_BY_HOP.has(name)) continue
    out[name] = value
  }
  return out
}

/** Serialize headers for a hand-written HTTP response (the upgrade path). */
function headerLines(headers: ProxyHeaders, status: string): string[] {
  const lines = [`HTTP/1.1 ${status}`]
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
  }
  return lines
}

/**
 * Read a JSON request body within a byte cap AND a deadline.
 *
 * The cap bounds size, not time: a client sending one byte a minute would hold a
 * socket (and, through the tunnel, a forwarded channel) open forever. Node's
 * `requestTimeout` covers the whole request, which is neither tight enough nor
 * safe to tighten for large proxied uploads, so the ceremony bodies carry their
 * own deadline.
 * @param req - incoming request.
 * @param timeoutMs - how long the body may take.
 * @returns the parsed object.
 */
async function readJsonBody(req: IncomingMessage, timeoutMs: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      req.destroy()
      reject(new HttpError(408, 'request body took too long'))
    }, timeoutMs)
    timer.unref()
  })
  const read = (async (): Promise<Record<string, unknown>> => {
    for await (const chunk of req) {
      const buffer = chunk as Buffer
      size += buffer.length
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large')
      chunks.push(buffer)
    }
    if (size === 0) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new HttpError(400, 'request body is not valid JSON')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, 'request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  })()
  // The loser of the race must not surface as an unhandled rejection.
  read.catch(() => undefined)
  try {
    return await Promise.race([read, expired])
  } finally {
    clearTimeout(timer)
  }
}

/** Send a small text or JSON response with the headers this gateway always sets. */
function send(res: ServerResponse, status: number, body: string | Buffer, contentType = 'text/plain; charset=utf-8', headers: ProxyHeaders = {}): void {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(payload)
}

/** Send a response whose body is a document this gateway rendered. */
function sendHtml(res: ServerResponse, status: number, html: string): void {
  send(res, status, html, 'text/html; charset=utf-8', { 'content-security-policy': PAGE_CSP })
}

/** Journal one message at one level. */
function logLine(log: Logger, level: 'info' | 'warn' | 'error', message: string): void {
  log[level](message)
}

/** Everything the gateway needs from its host. */
export interface GatewayOptions {
  config: ResolvedConfig
  passkeys: PasskeyService
  store: StateStore
  log: Logger
  tunnel?: TunnelManager | null
  /**
   * Build DSH's own tokenized entry URL for one path, when the Host can.
   *
   * A browser that passed this gate still has no DSH session of its own, so the
   * GUI answers its navigation with a sign-in page. The gateway turns that
   * answer into one redirect through this URL, which is how a freshly enrolled
   * phone reaches the GUI without a second credential to copy.
   * @param path - the path the browser asked for, query included.
   * @returns an absolute URL carrying DSH's launch token, or null.
   */
  dshEntry?: (path: string) => string | null
  /**
   * Called whenever the pending enrollment link appears or goes away, so the
   * host can keep `enroll-url.txt` in step with reality.
   * @param url - the current one-time link, or null when none is pending.
   */
  onEnrollmentChange?: (url: string | null) => void | Promise<void>
  /**
   * Deadline for reading one ceremony's JSON body.
   *
   * `server.requestTimeout` bounds the whole request, which is too coarse to
   * reason about here and cannot be tightened without capping large proxied
   * uploads; a body that dribbles in one byte at a time would otherwise hold a
   * channel open indefinitely. Defaults to {@link BODY_TIMEOUT_MS}.
   */
  bodyTimeoutMs?: number
}

/** What the startup probe learned from the GUI's own trust fence. */
export interface PreflightResult {
  status: number
  authority: string
  error?: string
}

/**
 * Own the listener, the passkey gate, and the reverse proxy.
 */
export class Gateway {
  /** The tunnel, once mounted; the status endpoint reports it. */
  tunnel: TunnelManager | null
  private readonly config: ResolvedConfig
  private readonly passkeys: PasskeyService
  private readonly store: StateStore
  private readonly log: Logger
  /**
   * The one-time enrollment link a human is holding right now, if any.
   *
   * Deliberately in memory only: the link is a credential, and the whole point
   * of a one-time link is that it stops existing after it is used, after it
   * expires, and after a restart. Nothing durable ever carries it.
   */
  private pending: { token: string; expiresAt: number } | null = null
  /** Grants handed out for the current link, so retiring it revokes them. */
  private readonly grants = new Map<string, number>()
  /** Builds DSH's tokenized entry URL, when the Host has the service for it. */
  private readonly dshEntry: ((path: string) => string | null) | null
  /** Keeps the host's enrollment file in step with {@link pending}. */
  private readonly onEnrollmentChange: ((url: string | null) => void | Promise<void>) | null
  private readonly attempts = new Map<string, { since: number; count: number }>()
  private readonly pendingNext = new Map<string, { path: string; expiresAt: number }>()
  private readonly upgraded = new Set<Duplex>()
  /** Per-ceremony body deadline; see {@link GatewayOptions.bodyTimeoutMs}. */
  private readonly bodyTimeoutMs: number
  /** The listener; exported reads wait on it through the test harness. */
  readonly server: Server

  /**
   * @param options - resolved settings, the passkey service, its store, and a logger.
   */
  constructor(options: GatewayOptions) {
    this.config = options.config
    this.passkeys = options.passkeys
    this.store = options.store
    this.log = options.log
    this.tunnel = options.tunnel ?? null
    this.dshEntry = options.dshEntry ?? null
    this.onEnrollmentChange = options.onEnrollmentChange ?? null
    this.bodyTimeoutMs = options.bodyTimeoutMs ?? BODY_TIMEOUT_MS
    this.server = createServer((req, res) => { this.dispatch(req, res) })
    // `requestTimeout` bounds *receiving* the request (headers and body), not the
    // response, so it can stay finite without touching the SSE channel or a
    // WebSocket: leaving it at 0 removed the only bound on a slow request. It is
    // generous because a proxied upload over a phone link is legitimate traffic.
    this.server.requestTimeout = REQUEST_TIMEOUT_MS
    // Response-side deadlines WOULD cut the client-reload SSE channel and
    // long-lived upgrades, which share this listener.
    this.server.timeout = 0
    this.server.keepAliveTimeout = 65_000
    this.server.headersTimeout = 60_000
    this.server.on('upgrade', (req, socket, head) => { this.upgrade(req, socket, head) })
    this.server.on('clientError', (error, socket) => {
      logLine(this.log, 'warn', `dsh-sync-remote: rejected a malformed request: ${error.message}`)
      socket.destroy()
    })
    // Permanent: `net.Server` emits 'error' after binding too (accept failures
    // such as EMFILE under descriptor pressure), and an EventEmitter error with
    // no listener is an uncaught exception that would take the whole process
    // down. `listen()` borrows this event only to settle its own promise.
    this.server.on('error', (error) => {
      logLine(this.log, 'error', `dsh-sync-remote: the gateway listener failed: ${error.message}`)
    })
  }

  /**
   * Mint a fresh one-time enrollment link, replacing any link still pending.
   *
   * There is no long-lived enrollment credential: a device can only be added
   * while a link minted seconds ago is pending, and a successful registration
   * retires it. Losing the link costs one click in the settings page, while a
   * permanent link would sit in every backup of the profile.
   * @param ttlMs - how long the link stays valid.
   * @returns the link and when it stops working.
   */
  async mintEnrollment(ttlMs: number = ENROLL_TOKEN_TTL_MS): Promise<{ url: string; expiresAt: number }> {
    const token = randomText(24)
    const expiresAt = Date.now() + ttlMs
    this.pending = { token, expiresAt }
    this.grants.clear()
    // Built here rather than through `enrollmentUrl()`, which is a *reader*: it
    // sweeps an expired link, and a caller asking for a one-millisecond link is
    // still entitled to the URL it just created.
    const url = `${this.config.publicOrigin}${AUTH_PATH}?token=${encodeURIComponent(token)}`
    await this.onEnrollmentChange?.(url)
    return { url, expiresAt }
  }

  /** @returns the pending one-time link, or null when none is usable. */
  enrollmentUrl(): string | null {
    this.sweepEnrollment()
    if (this.pending === null) return null
    return `${this.config.publicOrigin}${AUTH_PATH}?token=${encodeURIComponent(this.pending.token)}`
  }

  /** @returns whether a one-time link is pending right now. */
  hasPendingEnrollment(): boolean {
    return this.enrollmentUrl() !== null
  }

  /** @returns when the pending link stops working, or null when none is pending. */
  enrollmentExpiresAt(): number | null {
    return this.enrollmentUrl() === null ? null : this.pending?.expiresAt ?? null
  }

  /**
   * Retire a link whose time is up, telling the host once so its copy (the
   * `enroll-url.txt` beside the state file) disappears with it.
   *
   * Synchronous because every reader of the link is: the notification is fired
   * and its failure is logged rather than propagated, since an expired link is
   * not an error, only a link nobody used.
   */
  private sweepEnrollment(): void {
    this.sweepGrants()
    if (this.pending === null || this.pending.expiresAt > Date.now()) return
    this.pending = null
    this.grants.clear()
    Promise.resolve(this.onEnrollmentChange?.(null)).catch((error: unknown) => {
      logLine(this.log, 'warn', `dsh-sync-remote: could not remove the expired enrollment file: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * Drop grants whose signature has expired.
   *
   * A grant is a self-contained signed value with a longer life than the link
   * that produced it, so without this registry a browser that opened the link
   * before it was retired could still register a passkey afterwards, turning a
   * ten-minute link into a twenty-five-minute one.
   */
  private sweepGrants(): void {
    const now = Date.now()
    for (const [nonce, expiresAt] of this.grants) {
      if (expiresAt <= now) this.grants.delete(nonce)
    }
  }

  /**
   * Retire the pending link and tell the host, so its file disappears too.
   *
   * Called after a successful registration, the whole point of a one-time link,
   * and available to the host when an operator wants to cancel one. Public
   * because that promise is otherwise untestable: nothing else can observe that
   * a used link stopped working.
   */
  async retireEnrollment(): Promise<void> {
    this.grants.clear()
    if (this.pending === null) return
    this.pending = null
    await this.onEnrollmentChange?.(null)
  }

  /** Bind the listener. @returns when the socket is accepting connections. */
  async listen(): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => { reject(error) }
        this.server.once('error', onError)
        this.server.listen(this.config.serverPort, this.config.bindHost, () => {
          this.server.off('error', onError)
          resolve()
        })
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new Error(
          `dsh-sync-remote: ${this.config.bindHost}:${String(this.config.serverPort)} is already in use; `
          + 'another process holds the server port — change 服务端端口 / serverPort in Settings → Remote access '
          + '(the VPS listener, Nginx upstream, and this gateway share one number, so Nginx needs the same change)',
        )
      }
      throw error
    }
    logLine(this.log, 'info', `dsh-sync-remote: passkey gateway listening on http://${this.config.bindHost}:${String(this.config.serverPort)} for ${this.config.publicOrigin}`)
  }

  /** Close the listener, every open connection, and every upgraded socket. */
  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
    for (const socket of this.upgraded) socket.destroy()
    this.upgraded.clear()
    this.server.closeAllConnections()
    await closed
  }

  /**
   * Ask the GUI's own browser-trust fence whether it accepts the authority
   * browsers use.
   *
   * The probe is the difference between a working deployment and one where every
   * call 403s, and the answer is not inferable from here: `--trusted-host` lives
   * in the DSH invocation, not in this plugin. An unauthenticated `/api` request
   * answers 403 when the fence refuses the `Host` and 401 when it accepts it, so
   * the two failure modes are distinguishable without a credential.
   * @returns the observed status, and the authority it was probed with.
   */
  async preflight(): Promise<PreflightResult> {
    const authority = new URL(this.config.publicOrigin).host
    return new Promise((resolve) => {
      const probe = httpRequest({
        host: this.config.target.host,
        port: this.config.target.port,
        method: 'GET',
        path: '/api',
        headers: { host: authority, accept: 'application/json' },
      })
      probe.setTimeout(5_000, () => { probe.destroy(new Error('timed out')) })
      probe.on('response', (response) => {
        response.resume()
        resolve({ status: response.statusCode ?? 0, authority })
      })
      probe.on('error', (error) => resolve({ status: 0, authority, error: error.message }))
      probe.end()
    })
  }

  /**
   * Route one request: the gateway's own paths first, then the passkey gate,
   * then the upstream GUI.
   * @param req - incoming request.
   * @param res - response this gateway owns.
   */
  dispatch(req: IncomingMessage, res: ServerResponse): void {
    this.route(req, res).catch((error) => {
      logLine(this.log, 'warn', `dsh-sync-remote: request ${req.method ?? '?'} ${pathnameOf(req.url)} failed: ${error instanceof Error ? error.message : String(error)}`)
      if (res.headersSent) {
        res.destroy()
        return
      }
      // A ceremony that is unknown, expired, or refused is the browser's
      // mistake, not a gateway fault; the login page renders the message.
      const clientFault = error instanceof HttpError || error instanceof CeremonyError
      const status = error instanceof HttpError ? error.status : clientFault ? 400 : 500
      const message = clientFault ? error.message : 'gateway error'
      if (isLocalPath(pathnameOf(req.url))) {
        send(res, status, JSON.stringify({ error: message }), 'application/json; charset=utf-8')
        return
      }
      send(res, status, `${message}\n`)
    })
  }

  /**
   * @param req - incoming request.
   * @param res - response.
   */
  async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://gateway.invalid')
    if (isLocalPath(url.pathname)) {
      await this.localRoute(req, res, url)
      return
    }
    if (!this.authorized(req)) {
      this.challenge(req, res, url)
      return
    }
    this.proxy(req, res, url)
  }

  /** @param req - incoming request. @returns the verified session, or undefined. */
  session(req: IncomingMessage): SignedPayload | undefined {
    const jar = parseCookieHeader(req.headers.cookie)
    const value = jar.get(SESSION_COOKIE)
    if (value === undefined) return undefined
    return verifySession(value, this.store.state.secret)
  }

  /** @param req - incoming request. @returns whether it carries a valid session. */
  authorized(req: IncomingMessage): boolean {
    return this.session(req) !== undefined
  }

  /**
   * @param req - incoming request.
   * @returns whether it carries an enrollment grant that is still registered.
   */
  enrollmentGrant(req: IncomingMessage): boolean {
    const value = parseCookieHeader(req.headers.cookie).get(ENROLL_COOKIE)
    if (value === undefined) return false
    const payload = verifyEnrollment(value, this.store.state.secret)
    if (payload === undefined) return false
    this.sweepGrants()
    return this.grants.has(payload.nonce)
  }

  /**
   * Remember where an unauthenticated visitor was heading, in a signed cookie
   * rather than the redirect URL, so a one-time DSH launch token never appears
   * again in a second access-log line or in browser history.
   * @param path - the validated destination.
   * @returns the Set-Cookie value carrying that destination.
   */
  rememberNext(path: string): string {
    const session = createSession(this.store.state.secret, {
      ttlMs: NEXT_TTL_MS,
      credentialId: 'next',
      audience: 'next',
    })
    const now = Date.now()
    for (const [nonce, entry] of this.pendingNext) {
      if (entry.expiresAt <= now) this.pendingNext.delete(nonce)
    }
    // Every unauthenticated navigation adds an entry, so the map needs a ceiling
    // as well as a sweep; dropping the oldest is harmless, because the carried
    // destination only means anything for a browser still on its way to the
    // login page.
    if (this.pendingNext.size >= MAX_PENDING_NEXT) {
      const oldest = this.pendingNext.keys().next()
      if (!oldest.done) this.pendingNext.delete(oldest.value)
    }
    const payload = verifyValue(session.value, this.store.state.secret)
    if (payload !== undefined) this.pendingNext.set(payload.nonce, { path, expiresAt: now + NEXT_TTL_MS })
    return serializeCookie(NEXT_COOKIE, session.value, {
      maxAgeSeconds: Math.floor(NEXT_TTL_MS / 1000),
      expiresAt: session.expiresAt,
      secure: this.config.secureCookies,
      sameSite: 'Strict',
    })
  }

  /**
   * Read back the carried destination, consuming it exactly once.
   * @param req - incoming request.
   * @returns the destination path, defaulting to the site root.
   */
  takeNext(req: IncomingMessage): string {
    const raw = parseCookieHeader(req.headers.cookie).get(NEXT_COOKIE)
    if (raw === undefined) return '/'
    const payload = verifyValue(raw, this.store.state.secret)
    if (payload === undefined || payload.audience !== 'next' || payload.credentialId !== 'next' || payload.expiresAt <= Date.now()) return '/'
    const entry = this.pendingNext.get(payload.nonce)
    if (entry === undefined) return '/'
    this.pendingNext.delete(payload.nonce)
    return safeNextPath(entry.path) ?? '/'
  }

  /** @returns a Set-Cookie value clearing the carried destination. */
  clearNext(): string {
    return serializeCookie(NEXT_COOKIE, '', { maxAgeSeconds: 0, secure: this.config.secureCookies, sameSite: 'Strict' })
  }

  /** @returns a Set-Cookie value retiring the enrollment grant. */
  clearEnrollment(): string {
    return serializeCookie(ENROLL_COOKIE, '', { maxAgeSeconds: 0, secure: this.config.secureCookies, sameSite: 'Strict' })
  }

  /**
   * Answer an unauthenticated request: a browser navigation gets the login page,
   * while an API or Fetch call gets a bare 401 so the GUI's own transport reports
   * a normal authentication failure instead of parsing HTML.
   * @param req - incoming request.
   * @param res - response.
   * @param url - the parsed request URL.
   */
  challenge(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const acceptsHtml = String(req.headers.accept ?? '').includes('text/html')
    const destination = String(req.headers['sec-fetch-dest'] ?? '')
    if (acceptsHtml && (destination === '' || destination === 'document')) {
      const next = safeNextPath(`${url.pathname}${url.search}`)
      res.writeHead(303, {
        location: LOGIN_PATH,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        ...(next === undefined ? {} : { 'set-cookie': this.rememberNext(next) }),
      })
      res.end()
      return
    }
    send(res, 401, 'passkey authentication required; open the public URL in a browser to sign in\n')
  }

  /**
   * Serve one of the gateway's own endpoints.
   * @param req - incoming request.
   * @param res - response.
   * @param url - the parsed request URL.
   */
  async localRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname
    const method = req.method ?? 'GET'
    if (path === APP_JS_PATH) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed')
      if (method === 'HEAD') {
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'content-length': String(Buffer.byteLength(APP_JS)),
          'content-security-policy': PAGE_CSP,
          'cache-control': 'no-store',
        })
        res.end()
        return
      }
      send(res, 200, APP_JS, 'application/javascript; charset=utf-8', { 'content-security-policy': PAGE_CSP })
      return
    }
    if (path === LOGIN_PATH) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed')
      if (this.authorized(req)) {
        res.writeHead(303, { location: this.takeNext(req), 'cache-control': 'no-store' })
        res.end()
        return
      }
      sendHtml(res, 200, renderPage('login', this.config.publicOrigin))
      return
    }
    // The link path (`/auth`) and the panel path (`/enroll`) both serve the
    // enrollment document; `/auth?token=...` is what a one-time link points at.
    if (path === AUTH_PATH || path === ENROLL_PATH) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed')
      // A browser that already holds a session has nothing to enroll: this link
      // exists for a device that has none. Send it to the GUI and, importantly,
      // leave the token untouched, so opening the link on the wrong device does
      // not cost the operator the link they minted for the right one. `add=1` is
      // the explicit exception: registering a second passkey (a security key
      // beside Windows Hello) from a signed-in browser.
      if (this.authorized(req) && url.searchParams.get('add') !== '1') {
        res.writeHead(303, { location: this.takeNext(req), 'cache-control': 'no-store' })
        res.end()
        return
      }
      const token = url.searchParams.get('token')
      if (token !== null) {
        // Sweep an expired link first, then compare against what is left.
        this.enrollmentUrl()
        const pending = this.pending
        if (pending === null || !secretEquals(token, pending.token)) {
          send(res, 403, 'this enrollment link is no longer valid; it works once, for ten minutes, and must be minted again in DSH → Settings → Remote access\n')
          return
        }
        const grant = createSession(this.store.state.secret, { ttlMs: ENROLL_TTL_MS, credentialId: 'enrollment', audience: 'enrollment' })
        const payload = verifyValue(grant.value, this.store.state.secret)
        if (payload !== undefined) this.grants.set(payload.nonce, grant.expiresAt)
        res.setHeader('set-cookie', serializeCookie(ENROLL_COOKIE, grant.value, {
          maxAgeSeconds: Math.floor(ENROLL_TTL_MS / 1000),
          expiresAt: grant.expiresAt,
          secure: this.config.secureCookies,
          sameSite: 'Strict',
        }))
        sendHtml(res, 200, renderPage('enroll', this.config.publicOrigin))
        return
      }
      if (!this.enrollmentGrant(req) && !this.authorized(req)) {
        send(res, 403, 'enrollment needs a one-time link; mint one in DSH → Settings → Remote access\n')
        return
      }
      sendHtml(res, 200, renderPage('enroll', this.config.publicOrigin))
      return
    }
    if (path === BOOTSTRAP_PATH) {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed')
      send(res, 200, JSON.stringify({
        origin: this.config.publicOrigin,
        rpName: this.config.rpName,
        enrolled: this.passkeys.enrolled,
      }), 'application/json; charset=utf-8')
      return
    }
    // The gate is a bearer token from the state file, not the Host header: a
    // reverse proxy that preserves the browser's Host (which DSH's own docs
    // require) lets any remote client send `Host: 127.0.0.1`, so a Host-based
    // rule would be forgeable. The token is the *read-only* `statusToken`, not
    // the cookie-signing secret: this endpoint is reachable from the internet and
    // its token travels in a URL, so a leak must cost reconnaissance only, never
    // the ability to forge a session. The header is the documented form; the
    // query spelling is kept because links and scripts already use it.
    if (path === STATUS_PATH) {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed')
      const header = req.headers[STATUS_HEADER]
      const presented = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('token') ?? ''
      if (!secretEquals(presented, this.store.state.statusToken)) {
        throw new HttpError(403, `status requires the read-only status token from the state file (send it as ${STATUS_HEADER}, or as ?token=): /status`)
      }
      send(res, 200, JSON.stringify({
        origin: this.config.publicOrigin,
        rpID: this.config.rpID,
        enrolled: this.passkeys.enrolled,
        // A count, not the devices: labels and timestamps are the operator's
        // business and this endpoint is reachable from the internet.
        passkeyCount: this.store.state.passkeys.length,
        tunnel: this.tunnel?.snapshot() ?? null,
        // The values an outside verifier needs to reach this deployment without
        // reading any configuration of its own.
        bind: `${this.config.bindHost}:${String(this.config.serverPort)}`,
        web: `http://${this.config.target.host}:${String(this.config.target.port)}`,
        secureCookies: this.config.secureCookies,
        enrollmentPending: this.hasPendingEnrollment(),
      }, undefined, 2), 'application/json; charset=utf-8')
      return
    }
    if (path === LOGOUT_PATH) {
      if (method !== 'POST') throw new HttpError(405, 'method not allowed')
      res.setHeader('set-cookie', serializeCookie(SESSION_COOKIE, '', {
        maxAgeSeconds: 0,
        secure: this.config.secureCookies,
        sameSite: 'Strict',
      }))
      send(res, 200, JSON.stringify({ ok: true, redirect: LOGIN_PATH }), 'application/json; charset=utf-8')
      return
    }
    if (CEREMONY_PATHS.has(path)) {
      if (method !== 'POST') throw new HttpError(405, 'method not allowed')
      await this.limit(req)
      await this.ceremony(req, res, path)
      return
    }
    if (path === PASSKEYS_REMOVE_PATH) {
      if (method !== 'POST') throw new HttpError(405, 'method not allowed')
      if (!this.authorized(req)) throw new HttpError(401, 'sign in before managing passkeys')
      const body = await readJsonBody(req, this.bodyTimeoutMs)
      const removed = await this.passkeys.remove(String(body.id ?? ''))
      send(res, 200, JSON.stringify({ ok: true, removed }), 'application/json; charset=utf-8')
      return
    }
    throw new HttpError(404, 'no such gateway route')
  }

  /**
   * Slow down a client that has burned through its ceremony allowance.
   *
   * Through the reverse tunnel every request arrives from loopback, so
   * `remoteAddress` is the same string for the whole internet: a limiter keyed on
   * it alone became one bucket shared by everybody, and 31 requests were enough
   * to lock the operator out of their own login for the rest of the window. Two
   * changes fix that: the key prefers the address the reverse proxy recorded
   * (trusted only because this listener is bound to loopback, so the only ways in
   * are the tunnel and this machine) and falls back to the socket address; and
   * over the limit the answer is a delay rather than a refusal, so a flood
   * becomes pointless while a real human's next attempt still succeeds.
   * @param req - incoming request.
   */
  async limit(req: IncomingMessage): Promise<void> {
    const key = this.clientKey(req)
    const now = Date.now()
    const record = this.attempts.get(key)
    if (record === undefined || now - record.since > RATE_WINDOW_MS) {
      this.attempts.set(key, { since: now, count: 1 })
      if (this.attempts.size > MAX_RATE_KEYS) this.attempts.clear()
      return
    }
    record.count += 1
    if (record.count <= RATE_LIMIT) return
    if (record.count === RATE_LIMIT + 1) {
      logLine(this.log, 'warn', `dsh-sync-remote: ${String(record.count)} passkey attempts from ${key} within ${String(Math.round(RATE_WINDOW_MS / 60_000))} minutes; new ceremonies are being delayed`)
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, RATE_DELAY_MS) })
  }

  /**
   * The address a request is attributed to.
   * @param req - incoming request.
   * @returns a bucket key: the proxy's record when one is present and trusted, otherwise the peer.
   */
  private clientKey(req: IncomingMessage): string {
    const peer = req.socket.remoteAddress ?? ''
    const forwarded = req.headers['x-real-ip'] ?? req.headers['x-forwarded-for']
    const header = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded
    const candidate = typeof header === 'string' ? (header.split(',').pop() ?? '').trim() : ''
    const fromProxy = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
    if (fromProxy && candidate !== '' && candidate.length <= 45) return candidate
    return peer === '' ? 'unknown' : peer
  }

  /**
   * Run one passkey ceremony step.
   * @param req - incoming request.
   * @param res - response.
   * @param path - the gateway path naming the step.
   */
  async ceremony(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const body = await readJsonBody(req, this.bodyTimeoutMs)
    if (path === `${AUTH_PATH}/options`) {
      const started = await this.passkeys.beginAuthentication()
      send(res, 200, JSON.stringify(started), 'application/json; charset=utf-8')
      return
    }
    if (path === `${AUTH_PATH}/verify`) {
      // The browser's JSON is untrusted input; simplewebauthn validates every
      // field of it during verification, which is where the shape is enforced.
      const credentialId = await this.passkeys.finishAuthentication({
        ceremonyId: String(body.ceremonyId ?? ''),
        response: body.response as AuthenticationResponseJSON,
      })
      const session = createSession(this.store.state.secret, {
        ttlMs: this.config.sessionTtlHours * 60 * 60 * 1000,
        credentialId,
        audience: 'session',
      })
      const redirect = this.takeNext(req)
      res.setHeader('set-cookie', [
        serializeCookie(SESSION_COOKIE, session.value, {
          maxAgeSeconds: this.config.sessionTtlHours * 60 * 60,
          expiresAt: session.expiresAt,
          secure: this.config.secureCookies,
          sameSite: 'Strict',
        }),
        this.clearNext(),
      ])
      logLine(this.log, 'info', 'dsh-sync-remote: passkey sign-in succeeded')
      send(res, 200, JSON.stringify({ ok: true, redirect }), 'application/json; charset=utf-8')
      return
    }
    if (!this.enrollmentGrant(req) && !this.authorized(req)) {
      throw new HttpError(403, 'enrollment needs a one-time link; mint one in DSH → Settings → Remote access')
    }
    if (path === `${ENROLL_PATH}/options`) {
      const started = await this.passkeys.beginRegistration({ label: body.label })
      send(res, 200, JSON.stringify(started), 'application/json; charset=utf-8')
      return
    }
    await this.passkeys.finishRegistration({
      ceremonyId: String(body.ceremonyId ?? ''),
      response: body.response as RegistrationResponseJSON,
    })
    // The link has done its job: the next device needs a freshly minted one, and
    // any grant handed out for this link stops working with it.
    await this.retireEnrollment()
    const redirect = this.takeNext(req)
    res.setHeader('set-cookie', [
      this.clearNext(),
      this.clearEnrollment(),
    ])
    send(res, 200, JSON.stringify({ ok: true, redirect }), 'application/json; charset=utf-8')
  }

  /**
   * Whether this request is a top-level navigation, which is the only place the
   * DSH sign-in redirect belongs: an XHR or a WebSocket upgrade must see the 401
   * itself, not a 303 to an HTML page.
   * @param req - incoming request.
   * @returns true for a document navigation.
   */
  navigation(req: IncomingMessage): boolean {
    const dest = req.headers['sec-fetch-dest']
    if (typeof dest === 'string') return dest === 'document'
    const accept = req.headers.accept ?? ''
    return accept.includes('text/html')
  }

  /**
   * @param req - incoming request.
   * @returns whether this browser already spent its one sign-in redirect recently.
   */
  autoLoginTried(req: IncomingMessage): boolean {
    const header = req.headers.cookie
    if (typeof header !== 'string') return false
    return parseCookieHeader(header).has(AUTOLOGIN_COOKIE)
  }

  /**
   * Copy the request headers the upstream should see. `Host`, `Origin`,
   * `Referer`, and every `Sec-Fetch-*` header cross this hop untouched: they are
   * what the GUI's fence authenticates, and rewriting them would disable it.
   * @param req - incoming request.
   * @returns headers for the upstream request.
   */
  upstreamHeaders(req: IncomingMessage): ProxyHeaders {
    const headers = copyRequestHeaders(req)
    if (headers.host === undefined) {
      headers.host = `${this.config.target.host}:${String(this.config.target.port)}`
    }
    return headers
  }

  /**
   * Relay one request to the local GUI.
   * @param req - incoming request.
   * @param res - response.
   * @param url - the parsed request URL.
   */
  proxy(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const upstream = httpRequest({
      host: this.config.target.host,
      port: this.config.target.port,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: this.upstreamHeaders(req),
    })
    // A browser that goes away before the GUI answers (a closed tab on the reload
    // SSE channel, an aborted upload) must stop the upstream work with it. Watch
    // the *response*: a request's 'close' also fires when a bodyless request was
    // simply read to the end, and destroying the upstream there would turn every
    // proxied call into a 502 before the GUI could answer.
    let pending: IncomingMessage | null = null
    res.on('close', () => {
      if (res.writableEnded) return
      pending?.destroy()
      upstream.destroy()
    })
    upstream.on('response', (upstreamResponse) => {
      pending = upstreamResponse
      // A browser that passed this gate can still have no DSH session of its own:
      // a phone that just enrolled a passkey, or any browser after DSH's cookie
      // expires. The GUI answers the navigation with its sign-in page; one
      // redirect through DSH's own tokenized entry URL mints that cookie, so the
      // operator never sees a second credential to copy. The marker cookie makes
      // it one attempt per minute, so a browser that still refuses the cookie
      // falls through to the sign-in page instead of looping.
      if (upstreamResponse.statusCode === 401 && this.navigation(req) && this.dshEntry !== null
        && !this.autoLoginTried(req)) {
        const entry = this.dshEntry(`${url.pathname}${url.search}`)
        if (entry !== null) {
          upstreamResponse.resume()
          res.writeHead(303, {
            location: entry,
            'cache-control': 'no-store',
            'set-cookie': serializeCookie(AUTOLOGIN_COOKIE, '1', {
              maxAgeSeconds: AUTOLOGIN_TTL_SECONDS,
              secure: this.config.secureCookies,
              sameSite: 'Lax',
            }),
          })
          res.end()
          logLine(this.log, 'info', 'dsh-sync-remote: the browser had no DSH session; redirecting once through the GUI launch URL')
          return
        }
      }
      res.writeHead(upstreamResponse.statusCode ?? 502, copyResponseHeaders(upstreamResponse.headers))
      upstreamResponse.pipe(res)
    })
    upstream.on('error', (error) => {
      logLine(this.log, 'warn', `dsh-sync-remote: upstream ${this.config.target.host}:${String(this.config.target.port)} failed: ${error.message}`)
      if (res.headersSent) {
        res.destroy()
        return
      }
      send(res, 502, 'the local DSH Web server is not reachable\n')
    })
    req.pipe(upstream)
  }

  /**
   * Relay one WebSocket upgrade. The handshake is replayed as an ordinary
   * upstream request so the GUI's fence sees exactly the headers the browser
   * sent, and the byte streams are piped afterwards.
   * @param req - the upgrade request.
   * @param socket - the client socket.
   * @param head - bytes already read past the request headers.
   */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => { socket.destroy() })
    const url = new URL(req.url ?? '/', 'http://gateway.invalid')
    if (isLocalPath(url.pathname)) {
      // A gateway-owned path is never an upstream route, upgrade or not.
      socket.destroy()
      return
    }
    if (!this.authorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    const upstream = httpRequest({
      host: this.config.target.host,
      port: this.config.target.port,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: copyRequestHeaders(req, { connection: 'Upgrade', upgrade: 'websocket' }),
      agent: false,
    })
    // No `req` 'close' watch here: the socket's own close handler below tears both
    // sides down, and a request's 'close' needs no handling of its own.
    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      const lines = headerLines(
        copyResponseHeaders(upstreamResponse.headers, UPGRADE_RESPONSE_SKIP, false),
        `${String(upstreamResponse.statusCode ?? 101)} ${upstreamResponse.statusMessage ?? 'Switching Protocols'}`,
      )
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length > 0) socket.write(upstreamHead)
      if (head.length > 0) upstreamSocket.write(head)
      // Both sides are real TCP sockets here; `Duplex` is the narrowest type the
      // upgrade event promises, so the idle-timeout opt-out needs the cast.
      ;(socket as Duplex & { setTimeout(ms: number): void }).setTimeout(0)
      upstreamSocket.setTimeout(0)
      this.upgraded.add(socket)
      this.upgraded.add(upstreamSocket)
      const finish = (): void => {
        this.upgraded.delete(socket)
        this.upgraded.delete(upstreamSocket)
        socket.destroy()
        upstreamSocket.destroy()
      }
      socket.on('error', finish)
      upstreamSocket.on('error', finish)
      socket.on('close', finish)
      upstreamSocket.on('close', finish)
      socket.pipe(upstreamSocket)
      upstreamSocket.pipe(socket)
    })
    upstream.on('response', (upstreamResponse) => {
      // The upstream refused the upgrade; pass that answer through verbatim, but
      // without the hop-by-hop headers: Node has already decoded the body, so
      // relaying `transfer-encoding: chunked` would send plain bytes labelled as
      // chunks and the browser would hang or truncate.
      const lines = headerLines(
        copyResponseHeaders(upstreamResponse.headers),
        `${String(upstreamResponse.statusCode ?? 502)} ${upstreamResponse.statusMessage ?? 'Bad Gateway'}`,
      )
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      upstreamResponse.pipe(socket)
    })
    upstream.on('error', (error) => {
      logLine(this.log, 'warn', `dsh-sync-remote: upstream upgrade failed: ${error.message}`)
      socket.write('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      socket.destroy()
    })
    upstream.end()
  }
}

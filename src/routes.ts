/**
 * The four Fetch routes the settings page reads and writes through.
 *
 * They are registered into DSH's authenticated `/api` channel
 * (`ctx.connection.fetch`), which means DSH itself applies the browser-trust
 * fence and the operator session before any handler runs. That matters more here
 * than anywhere else in this bundle: one of these routes mints the enrollment
 * link, and the link is a credential.
 *
 * The module stays transport-shaped on purpose — it moves JSON and maps
 * failures, and knows nothing about gateways, tunnels, or passkeys — so a test
 * can drive every handler with a stub registry and a stub source.
 *
 * @module @allynv/dsh-sync-remote/routes
 */

import { qrDataUrl } from './qr.ts'
import type { SyncRemoteStatus } from './status.ts'
import type { Logger } from './types.ts'

/** Exact path of the settings page's status read. */
export const STATUS_PATH = '/api/sync-remote.state'

/** Exact path of the device-removal write. */
export const PASSKEY_REMOVE_PATH = '/api/sync-remote.passkey.remove'

/** Exact path that mints a fresh one-time enrollment link. */
export const ENROLL_MINT_PATH = '/api/sync-remote.enroll.mint'

/** Exact path that forgets the pinned SSH host key. */
export const TRUST_FORGET_PATH = '/api/sync-remote.trust.forget'

/** Exact path that re-dials the tunnel now, instead of waiting out the backoff. */
export const TUNNEL_RETRY_PATH = '/api/sync-remote.tunnel.retry'

/** Exact path that proves a candidate tunnel configuration by dialing it once. */
export const TUNNEL_TEST_PATH = '/api/sync-remote.tunnel.test'

/** Exact path that ends an sshd on the VPS still holding the tunnel port (opt-in). */
export const TUNNEL_RELEASE_PATH = '/api/sync-remote.tunnel.release'

/**
 * The tunnel fields a connection test may carry.
 *
 * Every field is optional: the page sends only what it can see, and the Host
 * merges the rest from the row it already has (an omitted `passphrase` means
 * "keep the stored one"; `null` means "this row has none").
 */
export interface TunnelTestPatch {
  enabled?: boolean
  host?: string
  port?: number
  user?: string
  privateKeyFile?: string
  passphrase?: string | null
  /** The VPS-side port Nginx reaches the tunnel on; proven by the public round trip. */
  serverPort?: number
  /** The local DSH Web port the gateway proxies to; proven by asking it for an answer. */
  clientPort?: number
  /** The public origin the round trip targets. */
  publicOrigin?: string
  /**
   * The session lifetime is not proven by the test, but the candidate has to resolve to
   * be dialed and the resolver requires it — so the page sends it with everything else.
   */
  sessionTtlHours?: number
}

/** One exact Fetch route, in the shape `ctx.connection.fetch.register` takes. */
export interface FetchRoute {
  path: string
  methods: ('GET' | 'HEAD' | 'POST')[]
  requestBody: 'buffered'
  fetch(request: Request): Promise<Response>
}

/** The slice of `ctx.connection.fetch` these routes register into. */
export interface RouteRegistry {
  register(route: FetchRoute): unknown
}

/** The live facts and actions the routes reach; `index.ts` supplies them. */
export interface RouteSource {
  /** @returns the payload the settings page renders. */
  status(): Promise<SyncRemoteStatus> | SyncRemoteStatus
  /**
   * Unregister one device.
   * @param id - credential id to remove.
   * @returns whether it was removed, or why it was not.
   */
  removePasskey(id: string): Promise<{ ok: true } | { ok: false; reason: string }>
  /**
   * Mint a one-time enrollment link.
   * @returns the link and when it expires, or why none could be minted.
   */
  mintEnrollment(): Promise<{ url: string; expiresAt: number } | { ok: false; reason: string }>
  /**
   * Forget the pinned SSH host key so the next connection trusts again.
   * @returns whether it was forgotten, or why it was not.
   */
  forgetHostKey(): Promise<{ ok: true } | { ok: false; reason: string }>
  /**
   * Re-dial the tunnel immediately, through the same fence gate as the boot path.
   *
   * The operator needs this after fixing something the plugin cannot see (a VPS
   * that was down, a port a stale session held): without it the next attempt is up
   * to five minutes away, and a reload of the row would be the only way out.
   * @returns whether an attempt was started, or why it was not.
   */
  retryTunnel(): Promise<{ ok: true } | { ok: false; reason: string }>
  /**
   * Prove a candidate deployment configuration by walking the whole publish path.
   *
   * The settings page calls this before every write that touches the tunnel, and the
   * running plugin refuses to dial a configuration this has not passed for. It dials
   * SSH, binds the remote port (and releases it), and proves the public origin comes
   * back to this process — because a tunnel that authenticates against the wrong
   * remote port is a deployment nobody can reach.
   * @param patch - the draft values from the form; everything omitted comes from
   * the current row.
   * @returns the presented host key on success, or which stage failed and why.
   */
  testTunnel(patch: TunnelTestPatch): Promise<
    | { ok: true; hostKey: string | null; verifiedAt: number; restarted: boolean }
    | { ok: false; reason: string; stage?: string; code?: string; evidence?: string }
  >
  /**
   * End an sshd on the VPS that still holds the tunnel port.
   *
   * The only action this plugin may take on the VPS, and it is off unless the row
   * allows it. The Host refuses rather than approximating when it is off, when the
   * holder is not a provable sshd, or when the port is already free.
   * @returns what happened, or why nothing was done.
   */
  releaseStaleForward(): Promise<{ ok: true; detail: string } | { ok: false; reason: string }>
}

/**
 * Build one JSON response. No response is ever cached: these payloads describe
 * live state and one of them carries a credential.
 * @param body - the JSON-shaped payload.
 * @param status - HTTP status to answer with.
 * @returns the response.
 */
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * Accept only the fields a connection test may carry, and only as their real
 * types.
 *
 * The patch becomes part of a resolved configuration and is then dialed, so a
 * string where a number belongs is a `400` here rather than a TypeError deeper
 * in, and an unknown field is simply not part of the shape.
 * @param body - the parsed JSON body.
 * @returns the patch, or one message naming what was wrong.
 */
function parseTunnelTestPatch(body: unknown): { patch: TunnelTestPatch } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'the request body must be a JSON object' }
  }
  const source = body as Record<string, unknown>
  const patch: TunnelTestPatch = {}
  if (source.enabled !== undefined) {
    if (typeof source.enabled !== 'boolean') return { error: '"enabled" must be a boolean' }
    patch.enabled = source.enabled
  }
  for (const field of ['host', 'user', 'privateKeyFile'] as const) {
    const value = source[field]
    if (value === undefined) continue
    if (typeof value !== 'string') return { error: `"${field}" must be a string` }
    patch[field] = value
  }
  if (source.port !== undefined) {
    if (typeof source.port !== 'number' || !Number.isSafeInteger(source.port)) {
      return { error: '"port" must be a whole number' }
    }
    patch.port = source.port
  }
  if (source.passphrase !== undefined) {
    if (source.passphrase !== null && typeof source.passphrase !== 'string') {
      return { error: '"passphrase" must be a string or null' }
    }
    patch.passphrase = source.passphrase
  }
  for (const field of ['serverPort', 'clientPort', 'sessionTtlHours'] as const) {
    const value = source[field]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      return { error: `"${field}" must be a whole number` }
    }
    patch[field] = value
  }
  if (source.publicOrigin !== undefined) {
    if (typeof source.publicOrigin !== 'string') return { error: '"publicOrigin" must be a string' }
    patch.publicOrigin = source.publicOrigin
  }
  return { patch }
}

/**
 * Register every route.
 * @param registry - the fetch registry to register into.
 * @param source - live facts and actions.
 * @param log - operator-facing log for failures the browser should not read.
 */
export function registerRoutes(registry: RouteRegistry, source: RouteSource, log: Logger): void {
  registry.register({
    path: STATUS_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        return json(await source.status())
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        log.error(`dsh-sync-remote: the settings status read failed: ${reason}`)
        return json({ error: 'the status read failed; see the DSH log' }, 500)
      }
    },
  })

  registry.register({
    path: ENROLL_MINT_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        const minted = await source.mintEnrollment()
        if ('ok' in minted) return json({ error: minted.reason }, 409)
        // The QR is rendered here so the page needs no QR library of its own.
        return json({ url: minted.url, qr: qrDataUrl(minted.url), expiresAt: minted.expiresAt })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        log.error(`dsh-sync-remote: minting an enrollment link failed: ${reason}`)
        return json({ error: 'minting an enrollment link failed; see the DSH log' }, 500)
      }
    },
  })

  registry.register({
    path: PASSKEY_REMOVE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let id: unknown
      try {
        const body: unknown = await request.json()
        id = typeof body === 'object' && body !== null ? (body as { id?: unknown }).id : undefined
      } catch {
        return json({ error: 'the request body is not valid JSON' }, 400)
      }
      if (typeof id !== 'string' || id.trim() === '') {
        return json({ error: 'the request needs a string "id"' }, 400)
      }
      try {
        const result = await source.removePasskey(id)
        return result.ok ? json({ ok: true }) : json({ error: result.reason }, 400)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        log.error(`dsh-sync-remote: removing a passkey failed: ${reason}`)
        return json({ error: 'the removal failed; see the DSH log' }, 500)
      }
    },
  })

  registry.register({
    path: TRUST_FORGET_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        const result = await source.forgetHostKey()
        return result.ok ? json({ ok: true }) : json({ error: result.reason }, 409)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        log.error(`dsh-sync-remote: forgetting the pinned host key failed: ${reason}`)
        return json({ error: 'forgetting the pinned host key failed; see the DSH log' }, 500)
      }
    },
  })

  registry.register({
    path: TUNNEL_RETRY_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        const result = await source.retryTunnel()
        // 409, not 500: "you may not retry this" is a state the page renders, not a
        // failure it has to interpret.
        return result.ok ? json({ ok: true }) : json({ error: result.reason }, 409)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        log.error(`dsh-sync-remote: retrying the tunnel failed: ${reason}`)
        return json({ error: 'the retry failed; see the DSH log' }, 500)
      }
    },
  })

  registry.register({
    path: TUNNEL_TEST_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return json({ error: 'the request body is not valid JSON' }, 400)
      }
      const parsed = parseTunnelTestPatch(body)
      if ('error' in parsed) return json({ error: parsed.error }, 400)
      try {
        const result = await source.testTunnel(parsed.patch)
        // A failed test is a state the page renders ("these values do not work"),
        // never a server error. The stage and code travel with the reason so the page
        // can say it in the operator's own language and keep the raw text as evidence.
        return result.ok ? json(result) : json({ error: result.reason, stage: result.stage, code: result.code, evidence: result.evidence }, 409)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        log.error(`dsh-sync-remote: the connection test failed unexpectedly: ${reason}`)
        return json({ error: 'the connection test failed; see the DSH log' }, 500)
      }
    },
  })

  registry.register({
    path: TUNNEL_RELEASE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        const result = await source.releaseStaleForward()
        return result.ok ? json({ ok: true, detail: result.detail }) : json({ error: result.reason }, 409)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        log.error(`dsh-sync-remote: releasing the VPS-side listener failed: ${reason}`)
        return json({ error: 'releasing the VPS-side listener failed; see the DSH log' }, 500)
      }
    },
  })
}

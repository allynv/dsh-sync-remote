/**
 * `dsh-sync-remote` — publish this DSH Web GUI without opening its port, and
 * without trusting the network in front of it.
 *
 * Three pieces, one process:
 *
 * 1. A **reverse SSH tunnel** asks the VPS to listen on a loopback port and
 *    hand the accepted connections here, so the VPS runs nothing but its own
 *    `sshd` and the public port never exists on this machine.
 * 2. A **passkey gateway** answers on a loopback port: unauthenticated browsers
 *    get a WebAuthn login page, and nothing unauthenticated is ever forwarded.
 * 3. A **reverse proxy** relays the authenticated request to the local DSH Web
 *    server with `Host`, `Origin`, and the Fetch-Metadata headers untouched, so
 *    the GUI's own trust fence and signed session cookie keep working.
 *
 * The tunnel is gated on the GUI that sits behind it: DSH's browser-trust fence
 * must accept the public authority before any remote forward is requested, so a
 * `dsh web` started without `--trusted-host` publishes nothing at all instead of
 * a login page in front of an `/api` that answers 403.
 *
 * The plugin needs no Host service to serve. The one it optionally uses is
 * `connection`, and only for two things: putting the settings page's routes
 * behind DSH's own browser-trust fence and operator session, and building the
 * tokenized entry URL that signs a browser into the GUI after this gate has
 * admitted it.
 *
 * Enrollment is one-time by design: a link is minted on demand (by the settings
 * page, or once at startup when no passkey exists yet), dies with the process or
 * with its first successful use, and is never written into any durable setting.
 *
 * A configuration this plugin refuses no longer unloads its row. That is
 * deliberate: the settings page is how the value gets fixed, and a failed row
 * disappears from the settings service along with the only surface that could
 * repair it. The refusal is logged, reported to the page, and the gateway stays
 * down until the value is valid.
 *
 * @module @allynv/dsh-sync-remote
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describeConfig, plainRow, provenance, resolveConfig, type Provenance, type ResolvedConfig, type ResolvedTarget, type RowConfig } from './config.ts'
import { Gateway, type PreflightResult } from './gateway.ts'
import { registerRoutes, type RouteRegistry, type RouteSource } from './routes.ts'
import { StateStore } from './state.ts'
import { buildStatus, sshEquivalent } from './status.ts'
import { TunnelManager } from './tunnel.ts'
import { PasskeyService } from './webauthn.ts'
import type { Logger, StateDocument } from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-sync-remote'

// The row's schema, re-exported so the Host validates and the settings UI
// renders the same declaration this module resolves.
export { Config } from './config.ts'

/** File beside the state file holding the current one-time enrollment URL. */
const ENROLL_FILE = 'enroll-url.txt'

/**
 * How many times an *indeterminate* fence answer is re-asked, and how long
 * between the asks.
 *
 * 403 and 401 are the fence's own answers and decide on the first probe. A
 * timeout, a 404 from an `/api` route that has not mounted yet, or a 5xx
 * describes the moment rather than the deployment, so this short burst keeps one
 * bad moment from closing the public entry until the row is loaded again.
 */
const FENCE_CONFIRM_ATTEMPTS = 3
const FENCE_CONFIRM_DELAY_MS = 500

/**
 * What DSH itself was launched with: the `trustedHosts` and `publicUrl` from
 * `dsh web --trusted-host … --public-url …`.
 */
export interface LaunchFacts {
  /** Authorities `--trusted-host` declared, in argument order. */
  trustedHosts: string[]
  /** The advertised public root from `--public-url`, or null when it was not given. */
  publicUrl: string | null
}

/**
 * Read what the GUI was launched with, when the Host can say.
 *
 * The fence probe answers the operative question — does the fence accept the
 * authority browsers use? — and stays the only thing the tunnel's gate consults.
 * This is context for the *message*: without it a 403 can only say "add
 * `--trusted-host`", while with it the plugin can name the authority it asked
 * about *and* the authorities the GUI actually trusts, which is the difference
 * between a hint and a diagnosis.
 *
 * Read structurally and treated as optional on purpose: this bundle ships no
 * dependency on the Harness packages, and a Host that does not expose the service
 * may only cost the sharper wording, never the gate.
 * @param ctx - Host plugin context.
 * @returns the launch facts, or null when the Host cannot report them.
 */
export function readLaunchFacts(ctx: PluginContext): LaunchFacts | null {
  const raw = ctx.get?.('webStartup')
  if (typeof raw !== 'object' || raw === null) return null
  const candidate = raw as { trustedHosts?: unknown, publicUrl?: unknown }
  if (!Array.isArray(candidate.trustedHosts)) return null
  return {
    trustedHosts: candidate.trustedHosts.filter((entry): entry is string => typeof entry === 'string'),
    publicUrl: typeof candidate.publicUrl === 'string' ? candidate.publicUrl : null,
  }
}

/**
 * The clause that turns "the fence refused this Host" into a diagnosis.
 *
 * `--trusted-host` must name the authority browsers actually send, so the two
 * ways to get it wrong are "a different host" and "the right host spelled with a
 * port the browser never sends" — and the launch facts also name the one case
 * this plugin cannot otherwise see: a fence that refuses an authority its own
 * launch arguments declare as trusted.
 * @param authority - the authority the fence was asked about.
 * @param launch - what the GUI was launched with, or null when unknown.
 * @returns one clause to append, or an empty string when there is nothing to add.
 */
function fenceDiagnosis(authority: string, launch: LaunchFacts | null): string {
  if (launch === null || launch.trustedHosts.length === 0) {
    return ' (dsh web was started without --trusted-host)'
  }
  const listed = launch.trustedHosts.map(entry => JSON.stringify(entry)).join(', ')
  if (launch.trustedHosts.some(entry => entry.toLowerCase() === authority.toLowerCase())) {
    return ` — dsh web declares --trusted-host ${listed}, which names this authority, so check the spelling and any extra port (a port in an entry has to match the browser's Host exactly), or whether another dsh web answers on this port`
  }
  return ` — dsh web trusts ${listed}, which is not the authority browsers use here; add ${JSON.stringify(authority)} to --trusted-host, or set this plugin's public origin to one of those`
}

/**
 * The one sentence that tells an operator how to make this deployment servable.
 * @param authority - the public authority browsers use.
 * @param origin - the configured public origin.
 * @param launch - what the GUI was launched with, or null when unknown.
 * @returns the fix, in the terms of the `dsh web` invocation.
 */
function fenceFix(authority: string, origin: string, launch: LaunchFacts | null): string {
  return `the DSH browser-trust fence refused Host ${JSON.stringify(authority)}; `
    + `start the GUI with --trusted-host ${JSON.stringify(authority)} (and --public-url ${origin}/), `
    + `or every request through this gateway will 403${fenceDiagnosis(authority, launch)}`
}

/**
 * The console channel this plugin reports on, and the line between what an
 * operator must see there and what only the settings page needs.
 *
 * Deliberately not `ctx.logger`: in the `dsh web` profile that logger's output
 * does not reach the console an operator is looking at (only `console.log`
 * lines such as `dsh web:` appear), and the messages this plugin must be able
 * to tell a human — the one-time enrollment link, a refused configuration — are
 * exactly the ones that would be lost. Writing to the console directly, the
 * same way the Web app prints its URL, is what makes them reachable.
 *
 * That console is a startup surface, not a log file. A healthy start prints
 * exactly one line of this plugin's own ({@link localEntryLine}); every other
 * line that reaches it is something a human has to act on: a refusal, a tunnel
 * that cannot come up, a device waiting to be enrolled. Routine detail — the
 * resolved settings, the state file, the ports, a working session's tunnel and
 * sign-in events — is `info`, and `info` is silent here on purpose: the
 * settings page ("远程访问 / Remote access") reports the same facts to whoever
 * goes looking because something *is* wrong.
 * @returns the log levels used throughout this bundle.
 */
function loggerFor(): Logger {
  return {
    info: () => {},
    warn: (message: string) => { console.warn(message) },
    error: (message: string) => { console.error(message) },
  }
}

/**
 * The one line a healthy start adds to the console: the local DSH Web URL,
 * carrying this process's launch token.
 *
 * `dsh web --public-url …` prints the *public* address, and that address is
 * useless to an operator sitting at this machine. The token is read from the
 * Host at the moment this line is printed rather than copied once at startup,
 * so a reload that hands the connection service a new token re-prints the
 * current one instead of a stale string. The line is exactly as sensitive as
 * the `dsh web: …?token=…` line beside it: it is the same process credential.
 * @param connection - the Host connection service that owns the launch token.
 * @param target - the local DSH Web server the gateway proxies to.
 * @returns the console line.
 */
function localEntryLine(connection: ConnectionContext['connection'], target: ResolvedTarget): string {
  return `dsh-sync-remote: ${connection.authenticatedUrl(`http://${target.host}:${String(target.port)}/`)}`
}

/** @returns one failure's message, whatever was thrown. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one callback after every Host row has mounted, or at once when the Host
 * cannot say.
 *
 * The fence probe asks the GUI a question whose answer *changes* while the tree
 * is still mounting: `/api` answers 404 before its route owner exists and 401
 * once it does, so a probe that wins that race reports a fault the deployment
 * does not have. The wait is registered, never awaited by this row — the row is
 * part of the tree that has to settle, and awaiting it from inside `apply` would
 * deadlock the boot. A hand-built context with no Loader is already the complete
 * tree.
 * @param ctx - Host plugin context.
 * @param body - what to run once asking makes sense.
 */
function onceLoaded(ctx: PluginContext, body: () => void): void {
  const loader = ctx.get?.('loader') as { await?: () => Promise<unknown> } | undefined
  const wait = loader?.await
  if (wait === undefined) {
    body()
    return
  }
  // A failed boot is the Host's diagnostic to print; this callback only wanted
  // to know *when* to ask, so both arms run the body.
  void wait.call(loader).then(body, body)
}

/**
 * The slice of the Cordis plugin context this bundle uses.
 *
 * Declared structurally rather than imported from `@deepseek-ai/cordis`: this
 * bundle ships no dependency on the Harness packages. `effect` is the only
 * capability serving needs; `inject` is optional and only mounts the settings
 * routes (and the GUI sign-in redirect) in a profile that has `connection`.
 */
export interface PluginContext {
  effect(body: () => () => void | Promise<void>, label?: string): void
  /** Run a callback once the named services exist; absent in a bare context. */
  inject?(names: string[], callback: (ctx: ConnectionContext) => void): unknown
  /**
   * Resolve another Host service by name. Present on the real Host context and
   * absent in a hand-built one; only `loader` is ever read here, and only to
   * learn when boot has finished.
   */
  get?(name: string): unknown
}

/** The Host services the settings routes and the sign-in redirect use. */
export interface ConnectionContext {
  connection: {
    readonly fetch: RouteRegistry
    /** Add DSH's own launch token to an application URL. */
    authenticatedUrl(baseUrl: string): string
  }
}

/**
 * Mount the tunnel, the passkey gateway, the reverse proxy, and the settings
 * routes.
 * @param ctx - Host plugin context.
 * @param config - the plugin row's config as the settings page wrote it.
 */
export async function apply(ctx: PluginContext, config?: RowConfig): Promise<void> {
  const log = loggerFor()
  const row = plainRow(config ?? {})
  /** Which layer supplied each field; filled as far as resolution gets. */
  const sources: Provenance = {}
  let resolved: ResolvedConfig | null = null
  let statusError: string | null = null
  try {
    resolved = resolveConfig(row, sources)
  } catch (error) {
    statusError = reason(error)
  }

  // Absent configuration means "not enabled on this machine", not "broken": a
  // deployment that installs the bundle but has not named its public origin yet
  // should get one explanatory line, not a failed row in the profile. It is a
  // `warn` rather than an `info` for the same reason — the console carries what
  // a human has to act on, and this row is waiting on exactly that.
  const configured = provenance(row).publicOrigin !== 'unset'
  // What the GUI was launched with, when it can say: context for the refusal
  // messages below, never an input to the decision (that is the probe's job).
  const launch = readLaunchFacts(ctx)
  if (!configured) {
    log.warn('dsh-sync-remote: no public origin configured yet; set it in Settings → Remote access; public access stays off')
  } else if (statusError !== null) {
    log.error(`dsh-sync-remote: refusing to serve until the configuration is fixed: ${statusError}`)
  } else if (resolved !== null) {
    log.info(`dsh-sync-remote: ${JSON.stringify(describeConfig(resolved))}`)
    // `--public-url` is advertising, not trust: it names the address DSH prints
    // and opens. When it differs from the origin this plugin publishes, the two
    // halves of one deployment disagree about the address browsers should use.
    const advertised = launch?.publicUrl?.replace(/\/+$/u, '')
    if (advertised !== undefined && advertised !== resolved.publicOrigin.replace(/\/+$/u, '')) {
      log.warn(`dsh-sync-remote: dsh web advertises ${advertised}, but this plugin publishes ${resolved.publicOrigin}; browsers have to use the plugin's origin, because that is the authority the tunnel's fence check asks about`)
    }
  }

  let store: StateStore | null = null
  let state: StateDocument | null = null
  let passkeys: PasskeyService | null = null
  let gateway: Gateway | null = null
  /**
   * Whether the gateway listener is actually bound.
   *
   * Deliberately not "the gateway object exists": the listener waits for the fence
   * when a tunnel is configured, so the object can stand with nothing behind it —
   * and the page has to say `off` then, not `listening`.
   */
  let gatewayListening = false
  let tunnel: TunnelManager | null = null
  let fence: { authority: string; status: number } | null = null
  /**
   * The one way this bundle opens the tunnel, once the gateway exists.
   *
   * Assigned where the gateway is built rather than called directly, so the
   * settings page's 「重新信任 / Trust again」 — which restarts the tunnel — goes
   * through the same fence check the boot path does. A second entry point that
   * skipped the check would be a way to expose a GUI that refuses to serve.
   */
  let startTunnel: (() => Promise<void>) | null = null
  /** Builds DSH's tokenized entry URL once the `connection` service is mounted. */
  let dshEntryFor: ((path: string) => string) | null = null
  const enrollFile = resolved === null ? null : join(dirname(resolved.stateFile), ENROLL_FILE)

  /**
   * Keep `enroll-url.txt` in step with the pending link, and announce it. The
   * file exists only while a link does: a stale file would advertise a token
   * that no longer works.
   * @param url - the pending link, or null when none is.
   */
  const onEnrollmentChange = async (url: string | null): Promise<void> => {
    if (enrollFile === null) return
    if (url === null) {
      await rm(enrollFile, { force: true })
      return
    }
    await mkdir(dirname(enrollFile), { recursive: true, mode: 0o700 })
    // `mode` only applies when the file is created, so an older 0644 copy would
    // stay world-readable while the docstring promises a private credential.
    // Removing first makes the mode real on every write.
    await rm(enrollFile, { force: true })
    await writeFile(enrollFile, `${url}\n`, { encoding: 'utf8', mode: 0o600 })
    log.warn('dsh-sync-remote: a one-time enrollment link is ready; it works for one registration, within ten minutes:')
    log.warn(`dsh-sync-remote:   ${url}`)
    log.warn(`dsh-sync-remote: it is also in ${enrollFile}, and that file disappears once the link is used, expires, or the process restarts`)
  }

  if (resolved !== null && statusError === null) {
    store = new StateStore(resolved.stateFile)
    state = await store.load()
    log.info(`dsh-sync-remote: state file ${resolved.stateFile} holds ${String(state.passkeys.length)} passkey(s)`)

    passkeys = new PasskeyService({
      rpID: resolved.rpID,
      rpName: resolved.rpName,
      origin: resolved.publicOrigin,
      state,
      store,
      log,
    })

    gateway = new Gateway({
      config: resolved,
      passkeys,
      store,
      log,
      // Late-bound: the `connection` service arrives in its own microtask, and a
      // browser can only reach this gateway once the listener is up anyway.
      dshEntry: (path) => dshEntryFor === null ? null : dshEntryFor(path),
      onEnrollmentChange,
    })
    // Own the listener from the moment it exists: `listen()` can fail, and
    // `tunnel.start()` can fail after it succeeded. Registering the disposer
    // here means neither failure can leave a socket bound to a dead row, and a
    // pending link never outlives the process that minted it.
    ctx.effect(() => () => {
      return Promise.all([tunnel?.stop(), gateway?.close(), onEnrollmentChange(null)]).then(() => undefined)
    }, 'dsh-sync-remote: gateway, tunnel, and the one-time link')

    if (resolved.tunnel.enabled) {
      // The listener waits for the fence, and the reason is the deployment's own
      // purpose: this gateway exists to hand the tunnel's connections to the GUI, so
      // with no tunnel there is nothing for it to serve. Its only other customer
      // would be a loopback browser, and the settings page that reports the refusal
      // is served by DSH itself (port 3080), never by this listener. Binding nothing
      // is therefore one fewer thing to find — and one fewer thing to explain.
    } else {
      try {
        await gateway.listen()
        gatewayListening = true
      } catch (error) {
        statusError = reason(error)
        log.error(`dsh-sync-remote: the gateway did not start: ${statusError}`)
        await gateway.close()
        gateway = null
      }
    }
  }

  if (resolved !== null && gateway !== null && statusError === null) {
    tunnel = new TunnelManager({
      config: resolved,
      local: { host: resolved.loopbackHost, port: resolved.serverPort },
      store: store as StateStore,
      log,
    })
    gateway.tunnel = tunnel

    const settings = resolved
    const live = tunnel

    /**
     * Bind the gateway listener, once.
     *
     * Called after the fence accepts and before the tunnel dials: a remote forward
     * in front of a closed port would be a lie, and the failure to bind is a
     * deployment fault the page has to report.
     * @returns whether the listener is up.
     */
    const listenGateway = async (): Promise<boolean> => {
      if (gatewayListening) return true
      try {
        await (gateway as Gateway).listen()
      } catch (error) {
        statusError = reason(error)
        log.error(`dsh-sync-remote: the gateway did not start: ${statusError}`)
        return false
      }
      gatewayListening = true
      return true
    }

    /**
     * Announce the enrollment state, minting the first-run link when nobody can get
     * in yet.
     *
     * Called only where there is a public entry to use it from: a link minted while
     * the fence refuses this Host would be a credential for a door nobody can reach,
     * and it would expire unused within ten minutes.
     */
    const announceEnrollment = async (): Promise<void> => {
      if (passkeys !== null && passkeys.enrolled) {
        log.info(`dsh-sync-remote: ${String(state?.passkeys.length ?? 0)} passkey(s) registered; sign in at ${settings.publicOrigin}/signin`)
        log.info('dsh-sync-remote: to add another device, mint a one-time link in Settings → Remote access')
        return
      }
      // The bootstrap case: nobody can get in yet, so hand the operator a link
      // without making them open the settings page first.
      log.warn('dsh-sync-remote: no passkey is registered yet; minting one one-time enrollment link:')
      await (gateway as Gateway).mintEnrollment()
    }

    /** Ask the fence once, and record the answer the settings page renders. */
    const askFence = async (): Promise<PreflightResult> => {
      const answer = await (gateway as Gateway).preflight()
      fence = { authority: answer.authority, status: answer.status }
      return answer
    }

    /**
     * Report one fence answer in the terms an operator can act on.
     *
     * A fence that accepts this authority is routine detail (and `info` is
     * silent on this console on purpose); everything else is a human's job.
     * @param answer - what the GUI answered for the public authority.
     */
    const reportFence = (answer: PreflightResult): void => {
      if (answer.status === 403) {
        log.error(`dsh-sync-remote: ${fenceFix(answer.authority, settings.publicOrigin, launch)}`)
      } else if (answer.status === 0) {
        log.warn(`dsh-sync-remote: the local DSH Web server at http://${settings.target.host}:${String(settings.target.port)} did not answer (${answer.error ?? 'no response'}); start it with dsh web`)
      } else if (answer.status === 401) {
        log.info(`dsh-sync-remote: the local GUI accepts Host ${JSON.stringify(answer.authority)}; the missing piece is only its own launch-token sign-in`)
      } else {
        log.warn(`dsh-sync-remote: the local GUI answered HTTP ${String(answer.status)} for Host ${JSON.stringify(answer.authority)}; expected 401 from an unauthenticated /api request`)
      }
    }

    /**
     * Open the tunnel only once the GUI's fence has accepted the public
     * authority, and open nothing at all when it has not.
     *
     * This is a precondition, not a diagnostic. A GUI whose browser-trust fence
     * refuses this authority answers 403 to every request that arrives through
     * the gateway, so a tunnel that opens anyway exposes a live, authenticated,
     * and completely unusable deployment: a login page with nothing behind it,
     * reachable by anyone who finds the port. Requesting no remote forward is
     * the only answer that leaves nothing to find.
     *
     * The condition is a `dsh web` launch parameter, so it cannot change while
     * this row is loaded — there is nothing to poll for. Every path that opens
     * the tunnel runs this same check, which is why `startTunnel` is the only
     * caller of `TunnelManager.start()`.
     */
    const startTunnelWhenTrusted = async (): Promise<void> => {
      let answer = await askFence()
      for (let attempt = 1; attempt < FENCE_CONFIRM_ATTEMPTS
        && answer.status !== 401 && answer.status !== 403; attempt += 1) {
        await delay(FENCE_CONFIRM_DELAY_MS)
        answer = await askFence()
      }
      if (answer.status === 401) {
        reportFence(answer)
        // Bind before dialing, and only here: the listener exists for the tunnel's
        // connections, so a refused fence leaves this process with no listener at
        // all rather than a loopback door nothing can walk through.
        if (!await listenGateway()) return
        try {
          await live.start()
        } catch (error) {
          // A refused tunnel is a status, not a reason to drop the gateway: the
          // gateway is still reachable on loopback and the settings page explains it.
          statusError = reason(error)
          log.error(`dsh-sync-remote: the reverse tunnel did not start: ${statusError}`)
        }
        await announceEnrollment()
        return
      }
      // 403 is the fence answering about the authority; anything else is the GUI
      // failing to answer the question at all. Both are refusals to open a tunnel,
      // and the sentence differs only in what it tells the operator to look at.
      const why = answer.status === 403
        ? `${fenceFix(answer.authority, settings.publicOrigin, launch)} — the reverse tunnel stays closed until then`
        : `the local GUI did not confirm it accepts Host ${JSON.stringify(answer.authority)}`
          + `${answer.status === 0 ? ` (${answer.error ?? 'no response'})` : ` (HTTP ${String(answer.status)})`}`
          + '; the reverse tunnel stays closed until its /api answers 401'
      live.block(why)
      log.error(`dsh-sync-remote: the reverse tunnel stays closed: ${why}`)
      if (passkeys === null || !passkeys.enrolled) {
        // The bootstrap case, where the difference is worth a line: no link was
        // minted, and that is deliberate — there is no door a scanner could reach.
        log.warn('dsh-sync-remote: no enrollment link was minted while the public entry is closed; fix the flag above and restart DSH')
      }
    }

    /**
     * The one way this bundle opens the tunnel: fence-checked when a tunnel is
     * configured, and the plain — already decided — start when the row turns the
     * tunnel off (which is a deliberate setting, not a condition to check).
     * @returns after the tunnel is listening, refused, blocked, or disabled.
     */
    startTunnel = async (): Promise<void> => {
      if (!settings.tunnel.enabled) {
        await live.start()
        return
      }
      await startTunnelWhenTrusted()
    }

    if (settings.tunnel.enabled) {
      // A wrong `--trusted-host` is the one misconfiguration that produces a live,
      // authenticated, and completely unusable deployment, so both the listener and
      // the tunnel wait for the answer — but only once boot has finished, because
      // `/api` answers 404 until its route owner mounts and that answer describes the
      // moment, not the deployment (see `onceLoaded`). Nothing is served meanwhile,
      // and the page that says so is DSH's settings page on 3080.
      onceLoaded(ctx, () => {
        void startTunnelWhenTrusted().catch((error: unknown) => {
          // Every classified outcome is handled above, so a rejection here is a
          // defect rather than a deployment state: say so instead of losing it.
          log.error(`dsh-sync-remote: the fence check failed unexpectedly: ${reason(error)}`)
        })
      })
    } else {
      // Unchanged: no tunnel to gate, so it settles inside `apply` and the console
      // gets its line before boot finishes. The fence question below is then pure
      // reporting — the settings page still shows what the GUI answers.
      await startTunnel()
      await announceEnrollment()
      onceLoaded(ctx, () => {
        void askFence().then(reportFence, () => {
          // The probe resolves on every outcome it classifies; a stray rejection
          // here must not become an unhandled one.
        })
      })
    }

    if (!resolved.tunnel.enabled) {
      // A deliberate setting, not a fault: the settings page shows the tunnel's
      // state, and an operator who turned it off does not need to be told on
      // every start.
      log.info(`dsh-sync-remote: the reverse tunnel is off; the gateway is reachable on http://${resolved.bindHost}:${String(resolved.serverPort)} only`)
    } else {
      // Detail, like the ports: the settings page shows the same command line,
      // and that is where an operator debugging a refused tunnel reads it.
      log.info(`dsh-sync-remote: the tunnel is equivalent to: ${sshEquivalent(resolved) ?? '(not configured)'}`)
    }
  }

  // The settings page's own data. Registered whenever the Host has a connection
  // service, including while the gateway is down: that page is what reports
  // *why* it is down, so it must not depend on the gateway existing.
  if (ctx.inject !== undefined) {
    const source: RouteSource = {
      status: () => {
        const now = gateway
        return buildStatus({
          configured,
          resolved,
          sources,
          // Only a configuration that was *attempted* can be refused; a row with
          // no origin yet is a state the page guides the operator out of.
          configError: configured ? statusError : null,
          enrolled: (state?.passkeys.length ?? 0) > 0,
          enrollmentPending: now !== null && now.hasPendingEnrollment(),
          enrollmentExpiresAt: now === null ? null : now.enrollmentExpiresAt(),
          hostKey: state?.sshHostKey ?? null,
          passkeys: passkeys === null ? [] : passkeys.list(),
          // The listener's own fact, not the object's existence: a gateway waiting
          // for the fence is not a running gateway.
          gatewayListening,
          tunnel: tunnel === null ? null : tunnel.snapshot(),
          fence,
          launch,
        })
      },
      mintEnrollment: async () => {
        if (gateway === null) return { ok: false, reason: 'the gateway is not running; fix the configuration first' }
        if (!gatewayListening) {
          // The link is a credential for the public entry, and that entry is closed
          // until the GUI trusts this Host: minting here would hand out a door key
          // for a wall, and it would expire unused.
          return { ok: false, reason: 'the public entry is closed (the GUI does not accept this Host), so an enrollment link could not be reached; fix that first' }
        }
        const minted = await gateway.mintEnrollment()
        return { url: minted.url, expiresAt: minted.expiresAt }
      },
      removePasskey: async (id) => {
        if (passkeys === null) return { ok: false, reason: 'no gateway is running yet' }
        if (state !== null && state.passkeys.length <= 1) {
          return { ok: false, reason: 'the last passkey cannot be removed; keep one device able to sign in' }
        }
        const removed = await passkeys.remove(id)
        return removed ? { ok: true } : { ok: false, reason: 'no such passkey' }
      },
      forgetHostKey: async () => {
        if (store === null || state === null) return { ok: false, reason: 'no gateway is running yet' }
        if (state.sshHostKey === null) return { ok: false, reason: 'no host key is pinned yet' }
        state.sshHostKey = null
        await store.persist()
        if (tunnel !== null) {
          // Reconnect so the next connection pins whatever the VPS presents now.
          await tunnel.stop()
          // Through the boot path's own starter: forgetting a key must not become
          // a second way to open a tunnel the GUI's fence refuses to serve.
          if (startTunnel !== null) await startTunnel()
        }
        return { ok: true }
      },
      retryTunnel: async () => {
        if (tunnel === null || startTunnel === null) {
          return { ok: false, reason: 'no tunnel is configured, so there is nothing to retry' }
        }
        // Deliberately the same path the boot uses: stop, then the fence-checked
        // starter. A retry button must never be a way around the gate.
        await tunnel.stop()
        await startTunnel()
        const after = tunnel.snapshot()
        if (after.state === 'blocked') {
          return { ok: false, reason: after.lastError ?? 'the GUI refuses this authority, so no tunnel was opened' }
        }
        if (after.state === 'failed') {
          return { ok: false, reason: after.lastError ?? 'the tunnel refused to start' }
        }
        return { ok: true }
      },
      releaseStaleForward: async () => {
        if (tunnel === null) {
          return { ok: false, reason: 'no tunnel is configured, so there is no remote listener to look for' }
        }
        if (resolved === null || !resolved.tunnel.releaseStaleForward) {
          return { ok: false, reason: 'this row does not allow releasing the VPS-side listener; turn on "tunnel.releaseStaleForward" first' }
        }
        const result = await tunnel.releaseStaleForward()
        // Only a proven holder that is now gone counts as done. Everything else is
        // the operator's next step, and reporting it as success would hide a port
        // that is still held.
        return result.outcome === 'released' || result.outcome === 'nothing-held'
          ? { ok: true, detail: result.detail }
          : { ok: false, reason: `${result.outcome}: ${result.detail}` }
      },
    }
    ctx.inject(['connection'], (connectionCtx) => {
      registerRoutes(connectionCtx.connection.fetch, source, log)
      if (resolved !== null) {
        const origin = resolved.publicOrigin
        dshEntryFor = (path) => connectionCtx.connection.authenticatedUrl(`${origin}${path}`)
        // The single line a healthy start adds. Printed here rather than in the
        // body above because the launch token lives on the connection service,
        // and built at print time so it is the token this process is using now.
        console.log(localEntryLine(connectionCtx.connection, resolved.target))
      }
    })
  }
}

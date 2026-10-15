/**
 * The reverse tunnel: one SSH connection to the VPS that asks it to listen on
 * `remoteHost:remotePort` and hands every accepted connection to the local
 * gateway.
 *
 * The tunnel deliberately owns its retry loop rather than delegating to ssh2's
 * own reconnect support: the remote forward must be re-requested on every new
 * session, and a half-open ssh2 client that has "reconnected" without a fresh
 * `forwardIn` looks healthy while carrying no traffic.
 *
 * Failure classification is the important part. A rejected key, a refused host
 * key, or a missing private-key file is a deployment error that retrying only
 * hides; a dropped socket, a DNS hiccup, or a remote port still held by the
 * previous session is transient and must be retried with backoff.
 *
 * The private key must be in a format ssh2 reads: the OpenSSH format
 * `ssh-keygen` writes by default, PKCS#1 (`BEGIN RSA PRIVATE KEY`), SEC1
 * (`BEGIN EC PRIVATE KEY`), or PuTTY's PPK. A PKCS#8 `BEGIN PRIVATE KEY` file —
 * what `openssl genpkey` and some exporters produce — is refused with a message
 * naming the file.
 *
 * @module @allynv/dsh-sync-remote/tunnel
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { connect as connectTcp, type Socket } from 'node:net'
import { Client, type ClientChannel } from 'ssh2'
import {
  fuserProbeCommand, killCommand, parseFuserHolders, parseSshdHolders, planRelease, ssProbeCommand,
  type ReleaseOutcome,
} from './remote-release.ts'
import type { ResolvedConfig } from './config.ts'
import type { StateStore } from './state.ts'
import type { Logger } from './types.ts'

/** First retry delay; doubles up to the configured cap. */
const BASE_RECONNECT_DELAY_MS = 1_000
/** Jitter fraction applied to each delay so restarts do not synchronize. */
const JITTER = 0.2
/**
 * Attempts without a single successful forward before the failure is called a
 * likely misconfiguration.
 *
 * A refused socket is a guess about the cause: the VPS may be down (wait), or
 * `tunnel.host`/`tunnel.port` may be wrong (fix). Five attempts is long enough
 * for a reboot to answer and short enough to stop dialing a typo every minute.
 */
const ESCALATE_AFTER_ATTEMPTS = 5
/**
 * Consecutive remote-forward refusals before an opt-in automatic release runs.
 *
 * A refusal on the first attempt is often a previous session that is still dying;
 * three in a row over a minute or so is a listener that is not going away.
 */
const AUTO_RELEASE_AFTER_REFUSALS = 3
/** How long one command run for the release action may take before it is abandoned. */
const COMMAND_TIMEOUT_MS = 10_000
/**
 * One console line per this many failed attempts, after the first.
 *
 * The console is a startup-and-attention surface, not a log file (see the module
 * doc of `index.ts`): forty identical "tunnel lost" lines hide the one line that
 * matters. The settings page keeps showing the live state meanwhile.
 */
const LOG_EVERY_ATTEMPTS = 10

/**
 * Why the tunnel is not up, as a closed set an operator can act on.
 *
 * `key`, `auth` and `host-key` are deployment mistakes that a retry can only
 * obscure, so the manager stops on them. The rest are conditions that can heal by
 * themselves (a VPS rebooting, a network path returning, a stale remote listener
 * dying) and are retried with backoff. `unknown` exists so that no failure has to
 * be mislabeled to fit the table: its raw text still rides in `lastError`.
 */
export type TunnelFailureKind =
  | 'key'
  | 'auth'
  | 'host-key'
  | 'dns'
  | 'unreachable'
  | 'handshake-timeout'
  | 'forward-refused'
  | 'local'
  | 'dropped'
  | 'unknown'

/**
 * Classify one ssh2 error into the kind an operator acts on.
 * @param level - ssh2's `error.level` (`client-authentication`, `client-dns`, `client-socket`, `client-timeout`, `agent`, or undefined).
 * @param message - the error's message, kept for the transport-level cases.
 * @returns the failure kind.
 */
export function classifySshFailure(level: string, message: string): TunnelFailureKind {
  if (level === 'client-authentication' || level === 'agent') return 'auth'
  if (level === 'client-dns') return 'dns'
  if (level === 'client-timeout') return 'handshake-timeout'
  if (level === 'client-socket') {
    return /ENOTFOUND|EAI_AGAIN/u.test(message) ? 'dns' : 'unreachable'
  }
  return 'unknown'
}

/**
 * The sentence for a refused remote forward: the one failure whose cause is on the
 * VPS rather than in this row's configuration.
 * @param bindPort - the VPS-side port that could not be bound.
 * @param message - ssh2's own wording.
 * @returns the explanation and the two ways to clear it.
 */
export function describeForwardFailure(bindPort: number, message: string): string {
  return `the VPS refused to listen on 127.0.0.1:${String(bindPort)} (${message}); `
    + 'the usual cause is a previous session that never released the port — on the VPS run '
    + `\`sudo ss -ltnp | grep ${String(bindPort)}\` and end the process holding it, `
    + 'or set ClientAliveInterval 30 and ClientAliveCountMax 3 in sshd_config so a dead session is reaped'
}

/**
 * The sentence for a private key ssh2 could not turn into a signing key.
 *
 * The distinction matters because the two cases point at different fields: an
 * encrypted key with no passphrase and a wrong passphrase are both the
 * passphrase's problem, while everything else — the PKCS#8 PEM openssl writes, a
 * truncated file — is the file's. ssh2 reports them through the same synchronous
 * throw, so this message is the only classification available, and the
 * connection test and the tunnel's own dial share it.
 * @param file - the configured key path.
 * @param error - what ssh2 threw while parsing the key.
 * @returns one actionable sentence.
 */
export function keyRejectedMessage(file: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  if (lower.includes('no passphrase given')) {
    return `dsh-sync-remote: the private key ${JSON.stringify(file)} is encrypted, but no passphrase is set (${message}); fill in 「私钥口令 / Key passphrase」 in Settings → Remote access`
  }
  if (lower.includes('bad passphrase')) {
    return `dsh-sync-remote: the passphrase for the private key ${JSON.stringify(file)} is wrong (${message}); correct 「私钥口令 / Key passphrase」 in Settings → Remote access`
  }
  return `dsh-sync-remote: the private key ${JSON.stringify(file)} was rejected (${message}); `
    + 'ssh2 reads the OpenSSH format ssh-keygen writes by default, plus PKCS#1 and SEC1 PEM, but not a PKCS#8 "BEGIN PRIVATE KEY" file — '
    + 're-export or regenerate this key, for example with: ssh-keygen -t ed25519 -f <file>'
}

/**
 * Lifecycle of the tunnel, as the status endpoint reports it.
 *
 * `blocked` is the one state this manager never reaches on its own: the
 * composition decides it is not allowed to open the tunnel at all (the local
 * GUI's browser-trust fence refuses the public authority), so no SSH session is
 * ever attempted and nothing is listening on the VPS. It is terminal until the
 * plugin row is loaded again — see `block()`.
 *
 * `untested` is the other deliberate refusal: the current configuration has
 * never passed a connection test, so the values may have been edited in the
 * profile by hand. Nothing is dialed and nothing is bound; the settings page's
 * 「测试连接」 is the way out. See `refuseUntested()`.
 */
export type TunnelState = 'disabled' | 'starting' | 'connecting' | 'reconnecting' | 'listening' | 'failed' | 'stopped' | 'blocked' | 'untested'

/** Both spellings of one host key's SHA-256 fingerprint. */
export interface HostKeyFingerprints {
  readonly base64: string
  readonly hex: string
}

/** The port sshd listens on unless a deployment moved it. */
const STANDARD_SSH_PORT = 22

/**
 * Whether one TCP port accepts a connection, within a short deadline.
 *
 * Used only to explain a refused SSH connection: when the configured port
 * refuses and the standard one answers, the operator has almost certainly put
 * the tunnel port where the SSH port belongs.
 * @param host - address to dial.
 * @param port - port to dial.
 * @param timeoutMs - how long to wait before giving up.
 * @returns true when the connection was established.
 */
export function portAccepts(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connectTcp({ host, port })
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => { finish(false) }, timeoutMs)
    socket.once('connect', () => { finish(true) })
    socket.once('error', () => { finish(false) })
  })
}

/** The tunnel's health, as the status endpoint reports it. */
export interface TunnelSnapshot {
  state: TunnelState
  /** Why it is not up, or null while it is healthy (and before any failure). */
  kind: TunnelFailureKind | null
  attempts: number
  channels: number
  since: number
  /**
   * Whether any session has ever reached `listening`.
   *
   * The difference between "this deployment has never worked, so the
   * configuration is the suspect" and "it worked a minute ago, so wait".
   */
  everListening: boolean
  /** When the next attempt is due, or null when none is scheduled. */
  nextRetryAt: number | null
  /**
   * `configuration` once repeated failures have never once succeeded: the page
   * says so instead of repeating "reconnecting" forever.
   */
  suspected: 'configuration' | null
  remote: string | null
  hostKey: string | null
  lastError: string | null
}

/** Everything the tunnel needs from its host. */
export interface TunnelManagerOptions {
  config: ResolvedConfig
  /**
   * Identity of the configuration, computed by the composition with
   * `tunnelFingerprint`.
   *
   * A configuration that does not appear in the state file's proven list is
   * never dialed: it may have been edited in the profile by hand, and the only
   * thing that makes those values trustworthy is a connection test that reached
   * the VPS with exactly them.
   */
  fingerprint: string
  /** Where accepted connections land: this plugin's own gateway listener. */
  local: { host: string; port: number }
  /**
   * Bring the local gateway listener up, once an SSH session is authenticated
   * and before the remote forward is requested.
   *
   * Called at that moment rather than before dialing on purpose: a listener that
   * exists while the SSH connection is failing serves nothing and reads as a
   * healthy deployment on the settings page. Failure is terminal — no forward is
   * ever requested, so the VPS never listens in front of a closed port.
   */
  ensureLocal?: (() => Promise<{ ok: true } | { ok: false; message: string }>) | undefined
  store: StateStore
  log: Logger
  onStatus?: (() => void) | undefined
}

/**
 * Render a host-key blob as both fingerprints a deployment might have written
 * down: the OpenSSH `SHA256:<base64>` text and its hex form.
 * @param key - the raw host-key blob ssh2 verified.
 * @returns both spellings.
 */
export function hostKeyFingerprints(key: Uint8Array): HostKeyFingerprints {
  const digest = createHash('sha256').update(key).digest()
  const base64 = digest.toString('base64').replace(/=+$/u, '')
  return { base64: `SHA256:${base64}`, hex: digest.toString('hex') }
}

/**
 * Compare a configured fingerprint against a presented host key, accepting the
 * OpenSSH base64 spelling, raw base64, or 64-character hex, in any case.
 * @param configured - the deployment's expected fingerprint.
 * @param presented - fingerprints of the key the server sent.
 * @returns true when they name the same digest.
 */
export function fingerprintMatches(configured: string, presented: HostKeyFingerprints): boolean {
  const wanted = configured.trim()
  if (wanted.toLowerCase() === presented.hex.toLowerCase()) return true
  const bare = wanted.startsWith('SHA256:') ? wanted.slice('SHA256:'.length) : wanted
  return bare === presented.base64.slice('SHA256:'.length)
    || bare.replace(/=+$/u, '') === presented.base64.slice('SHA256:'.length)
}

/**
 * Own the SSH client, its remote forward, and its retry loop.
 */
export class TunnelManager {
  private readonly config: ResolvedConfig['tunnel']
  private readonly fingerprint: string
  private readonly ensureLocal: (() => Promise<{ ok: true } | { ok: false; message: string }>) | undefined
  private readonly local: { host: string; port: number }
  private readonly log: Logger
  private readonly store: StateStore
  private readonly onStatus: (() => void) | undefined
  private state: TunnelState
  private attempts: number
  private lastError: string | null
  private channels: number
  private since: number
  private client: Client | null
  private privateKey: Buffer | null
  private timer: NodeJS.Timeout | null
  private stopped: boolean
  /**
   * Whether the session being closed has already been failed on purpose.
   *
   * The local-listener failure ends the session from inside `forward()`, and the
   * `close` that follows must not be mistaken for a dropped connection: without
   * this, the retry loop would dial the VPS again for a fault that only an
   * operator can clear.
   */
  private fatal: boolean
  /**
   * Bumped by every `connect()` and every `stop()`.
   *
   * Callbacks capture the value they were created under and return early when it
   * has moved on. Without this, a connection that `stop()` gave up waiting for
   * (it waits two seconds and then proceeds anyway) could deliver its late
   * `close` into the *new* session: it would null out the live client, tear down a
   * working tunnel, and let a zombie SSH session keep the VPS-side port bound.
   */
  private generation: number
  /** Whether the standard-SSH-port hint has already been offered once. */
  private portHinted: boolean
  private hostKeyRejected: string | null
  /** Why the last failure happened; the raw text stays in `lastError`. */
  private kind: TunnelFailureKind | null
  /** The kind the console was last told about, so a repeat is only worth one line. */
  private announcedKind: TunnelFailureKind | null
  private everListening: boolean
  private nextRetryAt: number | null
  /** Consecutive `forward-refused` failures, reset by any successful forward. */
  private forwardRefusals: number
  /** Whether a stale-listener release is running, so the retry loop cannot pile them up. */
  private releasing: boolean
  private readonly waiters: { resolve: (state: TunnelState) => void }[]

  /**
   * @param options - resolved settings, the state store, and the logger.
   */
  constructor(options: TunnelManagerOptions) {
    this.config = options.config.tunnel
    this.fingerprint = options.fingerprint
    this.ensureLocal = options.ensureLocal
    // Where the forwarded connections land: this plugin's own gateway listener.
    this.local = options.local
    this.log = options.log
    this.store = options.store
    this.onStatus = options.onStatus
    this.state = this.config.enabled ? 'starting' : 'disabled'
    this.attempts = 0
    this.lastError = null
    this.channels = 0
    this.since = Date.now()
    this.client = null
    this.privateKey = null
    this.timer = null
    this.stopped = false
    this.fatal = false
    this.portHinted = false
    this.generation = 0
    this.hostKeyRejected = null
    this.kind = null
    this.announcedKind = null
    this.everListening = false
    this.nextRetryAt = null
    this.forwardRefusals = 0
    this.releasing = false
    this.waiters = []
  }

  /** @returns a plain snapshot of the tunnel's health for the status endpoint. */
  snapshot(): TunnelSnapshot {
    return {
      state: this.state,
      kind: this.kind,
      attempts: this.attempts,
      channels: this.channels,
      since: this.since,
      everListening: this.everListening,
      nextRetryAt: this.nextRetryAt,
      // Derived, never stored: `start()` resets the attempt counter, so a manual
      // retry clears the suspicion without a second piece of state to keep in step.
      suspected: !this.everListening && this.attempts >= ESCALATE_AFTER_ATTEMPTS ? 'configuration' : null,
      remote: this.config.enabled
        ? `${this.config.host}:${String(this.config.port)} → ${this.config.remoteHost}:${String(this.config.remotePort)}`
        : null,
      hostKey: this.store.state.sshHostKey,
      lastError: this.lastError,
    }
  }

  /** @param state - the new lifecycle state. */
  setState(state: TunnelState): void {
    if (this.state === state) return
    this.state = state
    this.since = Date.now()
    for (const waiter of this.waiters.splice(0)) waiter.resolve(state)
    this.onStatus?.()
  }

  /**
   * Wait for the remote forward to be listening.
   * @param timeoutMs - how long to wait.
   * @returns the state observed, never rejects.
   */
  waitForListening(timeoutMs: number): Promise<TunnelState> {
    // `blocked` and `untested` join the terminal states: waiting cannot change
    // them, only a new plugin load (or a connection test) can, and a caller
    // parked here would otherwise sit out the whole timeout for an answer
    // already known.
    if (this.state === 'listening' || this.state === 'failed' || this.state === 'disabled'
      || this.state === 'blocked' || this.state === 'untested') {
      return Promise.resolve(this.state)
    }
    return new Promise<TunnelState>((resolve) => {
      const timer = setTimeout(() => resolve(this.state), timeoutMs)
      this.waiters.push({
        resolve: (state) => { clearTimeout(timer); resolve(state) },
      })
    })
  }

  /**
   * Declare that this tunnel must not open at all, and why.
   *
   * The composition calls this instead of `start()` when the deployment cannot
   * be served safely — today that means the local GUI's browser-trust fence
   * refuses the authority browsers use, so every request through the gateway
   * would 403. Opening the tunnel anyway would expose a live, authenticated,
   * and completely unusable deployment, so the safe answer is to open nothing:
   * no SSH session, no remote listener, no login page for anyone to reach.
   *
   * Deliberately not a retrying state: the condition is a `dsh web` launch
   * parameter, so it can only clear when this plugin row is loaded again, and a
   * manager that polled for it would only burn connects on a decided question.
   * @param reason - one actionable sentence for the console and the settings page.
   */
  block(reason: string): void {
    this.lastError = reason
    this.setState('blocked')
  }

  /** Load the private key and open the first connection; rejects on a configuration fault. */
  async start(): Promise<void> {
    // A start after a stop is a restart, and these lines are what make it one.
    // `stop()` leaves the stop flag set and the attempt counter where the previous
    // session left it; without clearing them, `stop()` followed by `start()` —
    // which is exactly what "trust the host key again" does — left the tunnel
    // permanently stopped while reporting no error at all. The failure kind and its
    // text go too: a fresh attempt must not present the previous attempt's reason.
    this.stopped = false
    this.fatal = false
    this.attempts = 0
    this.kind = null
    this.announcedKind = null
    this.lastError = null
    this.nextRetryAt = null
    if (!this.config.enabled) {
      this.setState('disabled')
      this.log.info('dsh-sync-remote: the reverse tunnel is disabled (set tunnel.host, tunnel.user, and tunnel.privateKeyFile to enable it)')
      return
    }
    // The gate sits before the key is even read: a configuration nobody has
    // proven must not dial, and it must not report a key fault either — the
    // values themselves are what is unverified. Only a connection test from the
    // settings page records the fingerprint that opens this door.
    if (!this.store.state.tunnelTests.some(entry => entry.fingerprint === this.fingerprint)) {
      this.refuseUntested()
      return
    }
    try {
      this.privateKey = await readFile(this.config.privateKeyFile as string)
    } catch (error) {
      // A key that cannot be read is not a transient failure: retrying cannot
      // create the file, so the state is terminal and the reason has to be visible
      // in the snapshot rather than only in the throw the caller logs.
      const message = `dsh-sync-remote: cannot read the SSH private key ${String(this.config.privateKeyFile)}: ${error instanceof Error ? error.message : String(error)}`
      this.fail('key', message)
      throw new Error(message)
    }
    try {
      this.connect()
    } catch (error) {
      // ssh2 parses the key synchronously, so a bad key is a throw here rather
      // than an event — including a key whose passphrase is missing or wrong.
      const message = keyRejectedMessage(this.config.privateKeyFile as string, error)
      this.fail('key', message)
      throw new Error(message)
    }
  }

  /**
   * Refuse to dial a configuration no connection test has proven.
   *
   * Terminal by design, and not a failure: the values may be perfectly good,
   * nobody has shown it yet. The state exists for the settings page, which is
   * the only surface that can run the test.
   */
  private refuseUntested(): void {
    const message = 'dsh-sync-remote: this tunnel configuration has not been verified with a test connection; open Settings → Remote access and press 「测试连接」 — the public entry stays closed'
    this.lastError = message
    this.setState('untested')
    this.log.warn(message)
  }

  /**
   * Record a terminal failure the manager must not retry.
   * @param kind - the failure kind.
   * @param message - the actionable sentence for the console and the page.
   */
  private fail(kind: TunnelFailureKind, message: string): void {
    this.kind = kind
    this.lastError = message
    this.setState('failed')
  }

  /** Close the client and stop retrying. */
  async stop(): Promise<void> {
    this.stopped = true
    // Retire every callback of the session being closed, so a late `close` cannot
    // act on the session that replaces it.
    this.generation += 1
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    const client = this.client
    this.client = null
    this.channels = 0
    this.setState('stopped')
    if (client !== null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          // No `close` arrived: make sure the socket is really gone instead of
          // letting it linger as a half-open session that still holds the remote
          // forward.
          client.destroy()
          resolve()
        }, 2_000)
        client.once('close', () => { clearTimeout(timer); resolve() })
        try {
          client.end()
        } catch {
          // A client that never reached `ready` can refuse end(); the socket is
          // already gone in that case, which is all stopping needs.
          clearTimeout(timer)
          resolve()
        }
      })
    }
  }

  /** Open one SSH session and request the remote forward once it is ready. */
  connect(): void {
    if (this.stopped) return
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting')
    const client = new Client()
    this.client = client
    // Every callback below belongs to this session and to no other.
    const generation = this.generation += 1
    this.hostKeyRejected = null

    client.on('ready', () => {
      if (generation !== this.generation) return
      this.log.info(`dsh-sync-remote: SSH session to ${this.config.user}@${this.config.host}:${String(this.config.port)} is up`)
      void this.forward(client)
    })

    client.on('tcp connection', (info, accept, reject) => {
      if (generation !== this.generation) {
        reject()
        return
      }
      if (info.destPort !== this.config.remotePort) {
        this.log.warn(`dsh-sync-remote: refusing forwarded connection for unexpected port ${String(info.destPort)}`)
        reject()
        return
      }
      if (this.channels >= this.config.maxChannels) {
        this.log.warn(`dsh-sync-remote: refusing forwarded connection beyond ${String(this.config.maxChannels)} open channels`)
        reject()
        return
      }
      this.bridge(accept())
    })

    client.on('error', (error) => {
      if (generation !== this.generation) return
      const level = (error as Error & { level?: string }).level ?? 'error'
      this.kind = classifySshFailure(level, error.message)
      // The raw text stays, prefixed with the level ssh2 classified it under: the
      // settings page shows the kind, this shows the evidence.
      this.lastError = `${level}: ${error.message}`
      // A rejected identity or a foreign host key is a deployment mistake that
      // retrying would only obscure; the close handler reads both markers.
      if ((error as Error & { level?: string }).level === 'client-authentication') this.hostKeyRejected = this.hostKeyRejected ?? 'authentication'
      // The most expensive mistake this plugin can present an operator with is
      // putting the tunnel port where the SSH port belongs: it produces an
      // endless `ECONNREFUSED` against a port nobody meant to dial. Ask the
      // standard SSH port once and say so, instead of letting the log repeat.
      if (!this.portHinted && level === 'client-socket' && /ECONNREFUSED/u.test(error.message)
        && this.config.port !== STANDARD_SSH_PORT && this.config.host !== null) {
        this.portHinted = true
        const host = this.config.host
        const wrongPort = this.config.port
        void portAccepts(host, STANDARD_SSH_PORT).then((reachable) => {
          if (!reachable) return
          this.log.error(
            `dsh-sync-remote: SSH to ${host}:${String(wrongPort)} was refused, but ${host}:${String(STANDARD_SSH_PORT)} accepts connections — `
            + `"VPS 的 SSH 端口" (tunnel.port) is probably ${String(STANDARD_SSH_PORT)}, and ${String(wrongPort)} belongs in "VPS 穿透监听端口" (port)`,
          )
        })
      }
    })

    client.on('close', () => {
      // A close from a session this manager already retired must change nothing.
      if (generation !== this.generation) return
      if (this.stopped) return
      this.client = null
      if (this.fatal) {
        // The failure was decided in `forward()`: this close is its consequence,
        // not a dropped connection to reconnect to.
        this.fatal = false
        return
      }
      const fatal = this.hostKeyRejected
      if (fatal !== null) {
        // Two very different deployment mistakes used to share one sentence. A
        // rejected identity is about the key and the user; a mismatched host key is
        // about the server, and the fix is the page's 「重新信任」, not a new key.
        const kind = this.kind === 'host-key' || /does not match the trusted/u.test(fatal) ? 'host-key' : 'auth'
        this.kind = kind
        this.lastError = fatal
        this.setState('failed')
        this.log.error(kind === 'host-key'
          ? `dsh-sync-remote: the server's host key does not match the pinned one (${fatal}); the tunnel is stopped until you trust it again in Settings → Remote access`
          : `dsh-sync-remote: SSH authentication was rejected (${fatal}); check the SSH user, the private key, and its passphrase — the tunnel is stopped until the plugin reloads`)
        return
      }
      // A session that ended without an ssh2 error of its own was simply dropped
      // (the VPS rebooted, the path went away), which is a wait-and-retry cause.
      this.kind = this.kind ?? 'dropped'
      this.scheduleReconnect()
    })

    try {
      client.connect({
        host: this.config.host as string,
        port: this.config.port,
        username: this.config.user as string,
        privateKey: this.privateKey as Buffer,
        passphrase: this.config.passphrase,
        keepaliveInterval: this.config.keepaliveIntervalMs,
        keepaliveCountMax: this.config.keepaliveCountMax,
        readyTimeout: this.config.readyTimeoutMs,
        hostVerifier: (key: Buffer) => this.verifyHostKey(key),
      })
    } catch (error) {
      // ssh2 parses the key synchronously: an unsupported format, a truncated
      // file, a missing passphrase and a wrong passphrase all land here, and
      // `keyRejectedMessage` says which field to look at.
      throw new Error(keyRejectedMessage(this.config.privateKeyFile as string, error))
    }
  }

  /**
   * Trust the server's host key: against the configured fingerprint when the
   * deployment pinned one, otherwise against the one recorded on first use.
   * @param key - the host-key blob ssh2 presented.
   * @returns whether the connection may continue.
   */
  verifyHostKey(key: Buffer): boolean {
    const presented = hostKeyFingerprints(key)
    // The pin lives only in the state file: it is whatever the first connection
    // recorded, and the settings page's 「重新信任」 is the way to forget it.
    const pinned = this.store.state.sshHostKey
    if (pinned !== null && pinned !== undefined) {
      if (fingerprintMatches(pinned, presented)) return true
      this.kind = 'host-key'
      this.hostKeyRejected = `host key ${presented.base64} does not match the trusted ${pinned}`
      this.log.error(`dsh-sync-remote: ${this.hostKeyRejected}`)
      return false
    }
    this.store.state.sshHostKey = presented.base64
    // ssh2 decides from this method's return value, so the pin cannot be awaited
    // here — but a failed write must not vanish into an unhandled rejection: the
    // pin is a security boundary, and a silent failure would re-trust the host on
    // the next start.
    this.store.persist().catch((error: unknown) => {
      this.lastError = `pinning the host key failed: ${error instanceof Error ? error.message : String(error)}`
      this.log.error(`dsh-sync-remote: ${this.lastError}`)
    })
    this.log.warn(`dsh-sync-remote: trusting ${String(this.config.host)} on first use with host key ${presented.base64}; it is pinned in the state file from now on (use 「重新信任 / Trust again」 in Settings → Remote access to forget it)`)
    return true
  }

  /**
   * Ask the remote server to listen and route its connections here.
   *
   * The local listener is brought up first, at this moment rather than before
   * dialing: a listener that exists while the SSH connection is still failing
   * serves nothing, and the settings page would report a healthy gateway in
   * front of a dead tunnel. Binding here keeps the promise that matters — the
   * remote forward never points at a closed port — while letting a session that
   * cannot authenticate leave no listener behind at all.
   * @param client - the ready SSH client.
   */
  async forward(client: Client): Promise<void> {
    const { remoteHost, remotePort } = this.config
    if (this.ensureLocal !== undefined) {
      const generation = this.generation
      const ready = await this.ensureLocal()
      if (generation !== this.generation) return
      if (!ready.ok) {
        // Terminal on purpose: a port that cannot be bound needs an operator
        // (change the port, or free it), and retrying would only dial the VPS
        // again for a forward that is never requested.
        this.kind = 'local'
        this.lastError = ready.message
        this.fatal = true
        this.fail('local', ready.message)
        this.log.error(`dsh-sync-remote: the local gateway listener did not start, so no remote forward was requested: ${ready.message}`)
        client.end()
        return
      }
    }
    client.forwardIn(remoteHost, remotePort, (error, boundPort) => {
      if (error !== undefined && error !== null) {
        // The one failure whose cause is on the VPS: a port a previous session
        // never released. It has an exact remedy, so it gets an exact sentence
        // instead of ssh2's "Unable to bind".
        this.kind = 'forward-refused'
        this.lastError = describeForwardFailure(remotePort, error.message)
        this.log.warn(`dsh-sync-remote: ${this.lastError}; retrying`)
        client.end()
        this.forwardRefusals += 1
        // Opt-in, and only after the retry loop has proved the port stays held: the
        // whole capability is ending one sshd on the VPS, so it never runs on the
        // first refusal (which a dying previous session clears by itself).
        if (this.config.releaseStaleForward && this.forwardRefusals >= AUTO_RELEASE_AFTER_REFUSALS && !this.releasing) {
          void this.releaseStaleForward().then((result) => {
            this.log.warn(`dsh-sync-remote: releasing the VPS-side listener: ${result.outcome} — ${result.detail}`)
          }).catch((releaseError: unknown) => {
            this.log.error(`dsh-sync-remote: releasing the VPS-side listener failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`)
          })
        }
        return
      }
      this.attempts = 0
      this.everListening = true
      this.forwardRefusals = 0
      this.kind = null
      this.announcedKind = null
      this.nextRetryAt = null
      this.setState('listening')
      this.log.info(`dsh-sync-remote: ${String(this.config.host)} is listening on ${remoteHost}:${String(boundPort ?? remotePort)} and forwarding to the local gateway`)
    })
  }

  /**
   * Connect one accepted remote channel to the local gateway and pipe both
   * directions. Either end closing tears down the other, so neither an idle
   * browser nor a vanished remote leaves a socket behind.
   * @param channel - the SSH channel ssh2 accepted.
   */
  bridge(channel: ClientChannel): void {
    const host = this.local.host
    const port = this.local.port
    const socket: Socket = connectTcp({ host, port })
    this.channels += 1
    let closed = false
    const finish = (): void => {
      if (closed) return
      closed = true
      this.channels -= 1
      channel.destroy()
      socket.destroy()
    }
    channel.on('error', finish)
    socket.on('error', (error) => {
      this.log.warn(`dsh-sync-remote: cannot reach the local gateway at ${host}:${String(port)}: ${error.message}`)
      finish()
    })
    channel.on('close', finish)
    socket.on('close', finish)
    socket.setNoDelay(true)
    channel.pipe(socket)
    socket.pipe(channel)
  }

  /**
   * End an sshd on the VPS that still holds the tunnel port, when this row allows it.
   *
   * The alternative is the operator doing it by hand, which is why the failure
   * message carries the command; this action exists so a deployment can recover
   * from a stale listener without one. It is off unless the row turns it on, and
   * even then it only ever ends a process the probe proved to be an `sshd` on this
   * exact loopback authority.
   *
   * The session is deliberately separate from the tunnel's own connection: the
   * retry loop must keep running whatever this concludes, and a session opened for
   * one command closes with it.
   * @returns what happened, in the terms the settings page reports.
   */
  async releaseStaleForward(): Promise<{ outcome: ReleaseOutcome; detail: string }> {
    const port = this.config.remotePort
    if (!this.config.releaseStaleForward) {
      return { outcome: 'unavailable', detail: 'this row does not allow releasing the VPS-side listener (turn on "release the VPS port" first)' }
    }
    if (!this.config.enabled || this.config.host === null || this.config.user === null) {
      return { outcome: 'unavailable', detail: 'the tunnel is not configured, so there is no remote listener to look for' }
    }
    if (this.releasing) {
      return { outcome: 'unavailable', detail: 'a release is already running' }
    }
    let privateKey = this.privateKey
    if (privateKey === null) {
      try {
        privateKey = await readFile(this.config.privateKeyFile as string)
      } catch (error) {
        return { outcome: 'unavailable', detail: `cannot read the SSH private key ${String(this.config.privateKeyFile)}: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    this.releasing = true
    const session = await this.openReleaseSession(privateKey)
    if (session === null) {
      this.releasing = false
      return { outcome: 'unreachable', detail: `cannot open an SSH session to ${this.config.host}:${String(this.config.port)} for this action` }
    }
    try {
      const planned = planRelease(await session.run(ssProbeCommand(port)), port)
      if (planned.kind === 'nothing') {
        return { outcome: 'nothing-held', detail: `nothing is listening on 127.0.0.1:${String(port)} any more — the next attempt can bind it` }
      }
      if (planned.kind === 'unavailable') {
        return { outcome: 'unavailable', detail: `the VPS did not run \`${ssProbeCommand(port)}\`; run it (and then \`kill <pid>\`) by hand as root` }
      }
      if (planned.kind === 'cannot-see') {
        const pids = parseFuserHolders(await session.run(fuserProbeCommand(port)) ?? '')
        return {
          outcome: 'cannot-see',
          detail: pids.length === 0
            ? `127.0.0.1:${String(port)} is held by a process whose pid this SSH user cannot see; run \`sudo ss -ltnp | grep ${String(port)}\` as root`
            : `127.0.0.1:${String(port)} is held by pid(s) ${pids.join(', ')}, but not by a visible sshd; check them as root before ending any`,
        }
      }
      for (const pid of planned.pids) await session.run(killCommand(pid))
      const remaining = parseSshdHolders(await session.run(ssProbeCommand(port)) ?? '', port)
      if (remaining.length > 0) {
        return { outcome: 'still-held', detail: `sshd pid(s) ${remaining.join(', ')} still hold 127.0.0.1:${String(port)} after SIGTERM; end them by hand as root` }
      }
      return { outcome: 'released', detail: `ended sshd pid(s) ${planned.pids.join(', ')}; 127.0.0.1:${String(port)} is free again` }
    } finally {
      this.releasing = false
      session.close()
    }
  }

  /**
   * Open one short-lived SSH session for a fixed command.
   * @param privateKey - the key this row already loaded, or a fresh read of it.
   * @returns the session, or null when the connection could not be established.
   */
  private openReleaseSession(privateKey: Buffer): Promise<{ run(command: string): Promise<string | null>; close(): void } | null> {
    return new Promise((resolve) => {
      const client = new Client()
      let settled = false
      /** @param session - what to resolve with; null means "could not connect". */
      const finish = (session: { run(command: string): Promise<string | null>; close(): void } | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(session)
      }
      const timer = setTimeout(() => {
        client.destroy()
        finish(null)
      }, this.config.readyTimeoutMs)
      client.on('ready', () => {
        finish({
          run: (command) => this.runOnSession(client, command),
          close: () => { client.end() },
        })
      })
      client.on('error', () => { finish(null) })
      client.on('close', () => { finish(null) })
      try {
        client.connect({
          host: this.config.host as string,
          port: this.config.port,
          username: this.config.user as string,
          privateKey,
          passphrase: this.config.passphrase,
          readyTimeout: this.config.readyTimeoutMs,
        })
      } catch {
        finish(null)
      }
    })
  }

  /**
   * Run one fixed command over an open session and collect its stdout.
   * @param client - the connected client.
   * @param command - the exact command; never built from untrusted text.
   * @returns stdout, or null when the command produced no result in time.
   */
  private runOnSession(client: Client, command: string): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => { finish(null) }, COMMAND_TIMEOUT_MS)
      try {
        client.exec(command, (error, stream) => {
          if (error !== undefined && error !== null) {
            finish(null)
            return
          }
          let stdout = ''
          stream.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
          stream.on('close', () => { finish(stdout) })
          stream.on('error', () => { finish(null) })
        })
      } catch {
        finish(null)
      }
    })
  }

  /** Arm the next connection attempt with capped, jittered exponential backoff. */
  scheduleReconnect(): void {
    this.attempts += 1
    // Past the threshold on a deployment that has never once come up, the
    // ceiling rises so a slow recovery does not hammer the VPS every minute.
    // This used to be phrased as "probably a typo", which is no longer the right
    // reading: a configuration only ever dials after a connection test proved it,
    // so a prolonged failure means the VPS or the network, not the values.
    // `everListening` keeps a tunnel that worked a minute ago on the fast cadence
    // — that one is a reboot, and waiting five minutes for it would be wrong.
    const suspected = !this.everListening && this.attempts >= ESCALATE_AFTER_ATTEMPTS
    const ceiling = Math.min(
      suspected ? this.config.suspectedReconnectMaxDelayMs : this.config.reconnectMaxDelayMs,
      BASE_RECONNECT_DELAY_MS * 2 ** Math.min(this.attempts - 1, 16),
    )
    const delay = Math.round(ceiling * (1 - JITTER + Math.random() * JITTER * 2))
    this.nextRetryAt = Date.now() + delay
    this.setState('reconnecting')
    // One full line the first time a reason appears, then only when the reason
    // changes or every tenth attempt: the console is for what a human must act on,
    // and forty identical lines are not that. The settings page carries the rest.
    if (this.attempts === 1 || this.kind !== this.announcedKind || this.attempts % LOG_EVERY_ATTEMPTS === 0) {
      const progress = this.attempts === 1 ? '' : ` (attempt ${String(this.attempts)}${suspected ? ', retrying as a network/VPS condition' : ''})`
      this.log.warn(`dsh-sync-remote: tunnel lost (${this.lastError ?? 'no error reported'}); reconnecting in ${String(delay)} ms${progress}`)
      this.announcedKind = this.kind
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, delay)
    this.timer.unref?.()
  }
}

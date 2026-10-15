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
import type { ResolvedConfig } from './config.ts'
import type { StateStore } from './state.ts'
import type { Logger } from './types.ts'

/** First retry delay; doubles up to the configured cap. */
const BASE_RECONNECT_DELAY_MS = 1_000
/** Jitter fraction applied to each delay so restarts do not synchronize. */
const JITTER = 0.2

/**
 * Lifecycle of the tunnel, as the status endpoint reports it.
 *
 * `blocked` is the one state this manager never reaches on its own: the
 * composition decides it is not allowed to open the tunnel at all (the local
 * GUI's browser-trust fence refuses the public authority), so no SSH session is
 * ever attempted and nothing is listening on the VPS. It is terminal until the
 * plugin row is loaded again — see `block()`.
 */
export type TunnelState = 'disabled' | 'starting' | 'connecting' | 'reconnecting' | 'listening' | 'failed' | 'stopped' | 'blocked'

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
  attempts: number
  channels: number
  since: number
  remote: string | null
  hostKey: string | null
  lastError: string | null
}

/** Everything the tunnel needs from its host. */
export interface TunnelManagerOptions {
  config: ResolvedConfig
  /** Where accepted connections land: this plugin's own gateway listener. */
  local: { host: string; port: number }
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
  private readonly waiters: { resolve: (state: TunnelState) => void }[]

  /**
   * @param options - resolved settings, the state store, and the logger.
   */
  constructor(options: TunnelManagerOptions) {
    this.config = options.config.tunnel
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
    this.portHinted = false
    this.generation = 0
    this.hostKeyRejected = null
    this.waiters = []
  }

  /** @returns a plain snapshot of the tunnel's health for the status endpoint. */
  snapshot(): TunnelSnapshot {
    return {
      state: this.state,
      attempts: this.attempts,
      channels: this.channels,
      since: this.since,
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
    // `blocked` joins the terminal states: waiting cannot change it, only a new
    // plugin load can, and a caller parked here would otherwise sit out the whole
    // timeout for an answer already known.
    if (this.state === 'listening' || this.state === 'failed' || this.state === 'disabled' || this.state === 'blocked') {
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
    // A start after a stop is a restart, and these two lines are what make it
    // one. `stop()` leaves the stop flag set and the attempt counter where the
    // previous session left it; without clearing them, `stop()` followed by
    // `start()` — which is exactly what "trust the host key again" does — left
    // the tunnel permanently stopped while reporting no error at all.
    this.stopped = false
    this.attempts = 0
    if (!this.config.enabled) {
      this.setState('disabled')
      this.log.info('dsh-sync-remote: the reverse tunnel is disabled (set tunnel.host, tunnel.user, and tunnel.privateKeyFile to enable it)')
      return
    }
    try {
      this.privateKey = await readFile(this.config.privateKeyFile as string)
    } catch (error) {
      throw new Error(`dsh-sync-remote: cannot read the SSH private key ${String(this.config.privateKeyFile)}: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.connect()
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
      this.forward(client)
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
      const fatal = this.hostKeyRejected
      if (fatal !== null) {
        this.setState('failed')
        this.log.error(`dsh-sync-remote: SSH authentication failed; the tunnel is stopped until the plugin reloads (${fatal})`)
        return
      }
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
      // ssh2 parses the key synchronously and reads the OpenSSH format
      // `ssh-keygen` writes, PKCS#1 (`BEGIN RSA PRIVATE KEY`), SEC1
      // (`BEGIN EC PRIVATE KEY`), and PuTTY's PPK — but not the PKCS#8
      // `BEGIN PRIVATE KEY` PEM that openssl and some exporters emit. Name the
      // file and the fix instead of surfacing ssh2's own wording.
      throw new Error(
        `dsh-sync-remote: the private key ${String(this.config.privateKeyFile)} was rejected (${error instanceof Error ? error.message : String(error)}); `
        + 'ssh2 reads the OpenSSH format ssh-keygen writes by default, plus PKCS#1 and SEC1 PEM, but not a PKCS#8 "BEGIN PRIVATE KEY" file — '
        + 're-export or regenerate this key, for example with: ssh-keygen -t ed25519 -f <file>',
      )
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
   * @param client - the ready SSH client.
   */
  forward(client: Client): void {
    const { remoteHost, remotePort } = this.config
    client.forwardIn(remoteHost, remotePort, (error, boundPort) => {
      if (error !== undefined && error !== null) {
        this.lastError = `forwardIn: ${error.message}`
        this.log.warn(`dsh-sync-remote: ${String(this.config.host)} refused ${remoteHost}:${String(remotePort)} (${error.message}); retrying`)
        client.end()
        return
      }
      this.attempts = 0
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

  /** Arm the next connection attempt with capped, jittered exponential backoff. */
  scheduleReconnect(): void {
    this.attempts += 1
    const ceiling = Math.min(this.config.reconnectMaxDelayMs, BASE_RECONNECT_DELAY_MS * 2 ** Math.min(this.attempts - 1, 16))
    const delay = Math.round(ceiling * (1 - JITTER + Math.random() * JITTER * 2))
    this.setState('reconnecting')
    this.log.warn(`dsh-sync-remote: tunnel lost (${this.lastError ?? 'no error reported'}); reconnecting in ${String(delay)} ms`)
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, delay)
    this.timer.unref?.()
  }
}

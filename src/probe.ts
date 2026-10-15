/**
 * The connection test behind the settings page's 「测试连接 / Test connection」.
 *
 * Its job is to answer one question — **would this deployment actually be reachable
 * at the public address?** — so the page can refuse to persist a configuration
 * nobody has proven, and the running plugin can refuse to dial one. That question
 * is bigger than "can this machine SSH to that VPS": a tunnel that authenticates
 * against the wrong remote port is a deployment nobody can reach, and an SSH test
 * alone cannot tell the difference.
 *
 * So the test walks the whole publish path, in six stages, and reports the stage it
 * died at:
 *
 * 1. **syntax** — offline: a value that can never be a host never costs a dial.
 * 2. **local-gui** — something that answers like DSH on `clientPort`, because the
 *    gateway has to be able to reach it.
 * 3. **key** — the private key is read and parsed.
 * 4. **ssh** — the address resolves, the socket connects, the host key is accepted,
 *    ssh2 authenticates the identity.
 * 5. **forward** — the VPS binds `127.0.0.1:<serverPort>` for us, which proves the
 *    port is free and sshd allows the forward.
 * 6. **public** — a request to the configured public origin comes back to *this*
 *    process, carrying a nonce only this test knows. That is the stage that proves
 *    Nginx's `proxy_pass` names the same port the tunnel binds.
 *
 * Stage 6 uses one of two proofs. Normally it binds the forward itself and answers
 * the public request from a throwaway loopback server, so the round trip is
 * end-to-end without touching the running deployment. When the running tunnel
 * already holds that remote port (the operator changed something else), the port
 * cannot be bound twice, so the test instead asks the *live* chain for a signature
 * only this gateway can produce (the read-only status endpoint, or the sign-in
 * page's policy header).
 *
 * The pin is compared but never written. Trust-on-first-use stays where it was — on
 * the tunnel's own first connection — because a test pointed at the wrong machine
 * must not be the thing that pins it.
 *
 * @module @allynv/dsh-sync-remote/probe
 */

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as connectTcp, type Socket } from 'node:net'
import { Client, type ClientChannel } from 'ssh2'
import { tunnelHostProblem, type ResolvedConfig } from './config.ts'
import {
  classifySshFailure, describeForwardFailure, fingerprintMatches, hostKeyFingerprints, keyRejectedMessage,
  type TunnelFailureKind,
} from './tunnel.ts'
import type { Logger } from './types.ts'

/** The stage a test result belongs to. */
export type ProbeStage = 'syntax' | 'local-gui' | 'key' | 'ssh' | 'forward' | 'public'

/**
 * Why a test failed, as a stable name the settings page turns into its own
 * language. The ssh stage reuses the tunnel's own classification rather than
 * inventing a second vocabulary for the same failures.
 */
export type ProbeCode =
  | 'incomplete'
  | 'host-syntax'
  | 'local-gui-missing'
  | 'key-read'
  | 'key-rejected'
  | TunnelFailureKind
  | 'forward-refused'
  | 'public-unreachable'
  | 'public-port-mismatch'
  | 'public-wrong-service'
  | 'public-no-answer'

/** What one test proved, or where it stopped. */
export interface ProbeResult {
  ok: boolean
  /** The stage that failed, or null on success. */
  stage: ProbeStage | null
  /** The stable failure name, or null on success. */
  code: ProbeCode | null
  /** Evidence in the words of whoever produced it (ssh2, HTTP, this module). */
  evidence: string | null
  /** `SHA256:<base64>` of the key the server presented, when it got that far. */
  hostKey: string | null
  /** Which proof the public stage used: a transient forward, or the live chain. */
  publicCheck: 'forward' | 'live' | null
  elapsedMs: number
}

/** What one test tries to prove. */
export interface ProbeCandidate {
  /**
   * The candidate deployment settings — the whole row, not just the tunnel half:
   * the test proves the local GUI port and the public origin too.
   */
  config: ResolvedConfig
  /** The host key pinned by earlier connections, or null before the first one. */
  pin: string | null
  /**
   * The remote port the *running* tunnel already holds while it is listening.
   *
   * A port can only be bound once, so this is what lets the test tell "the port is
   * taken by the deployment itself" from "the port is taken by something else".
   */
  liveRemotePort: number | null
  /** The state file's read-only status token, used to sign the live-chain proof. */
  statusToken: string | null
  log: Logger
}

/** How long past ssh2's own ready timeout before the probe gives up on its own. */
const PROBE_GRACE_MS = 1_000
/** How long the local DSH GUI gets to answer. */
const LOCAL_GUI_TIMEOUT_MS = 3_000
/** How long one public round trip gets. */
const PUBLIC_TIMEOUT_MS = 8_000
/** Redirects followed before a public answer is treated as "not our deployment". */
const MAX_REDIRECTS = 2
/** The path the nonce round trip asks for; any path works, this one is greppable. */
const PROBE_PATH = '/__dsh-sync-remote-probe/'
/** `default-src 'none'` is the gateway's own login page policy: a signature when no status token is available. */
const GATEWAY_CSP = 'default-src \'none\''

/** One direction of a public answer, or the reason there was none. */
type PublicAnswer =
  | { kind: 'answer'; status: number; headers: Record<string, string | string[] | undefined>; body: string }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' }

/**
 * A throwaway loopback HTTP server whose whole answer is one nonce.
 *
 * Any path answers: an operator's Nginx may rewrite paths, and the proof is that
 * *this* process received the request at all, not which path it arrived on.
 */
interface ProofTarget {
  port: number
  nonce: string
  close(): Promise<void>
}

/**
 * Dial the candidate deployment once and report the first stage it fails.
 *
 * Every stage before the public one is cheap, so the order is also the order of
 * cheapest-first: a typo costs nothing, a wrong local port costs one loopback
 * request, and only a deployment that could plausibly work touches the VPS.
 * @param candidate - the settings to prove, the pinned host key, the live state, and the logger.
 * @returns the outcome; never rejects.
 */
export async function probeTunnel(candidate: ProbeCandidate): Promise<ProbeResult> {
  const started = Date.now()
  const { config, pin, liveRemotePort, statusToken, log } = candidate
  const tunnel = config.tunnel
  /** @returns the failed result for one stage. */
  const failed = (
    stage: ProbeStage,
    code: ProbeCode,
    evidence: string,
    hostKey: string | null = null,
    publicCheck: 'forward' | 'live' | null = null,
  ): ProbeResult => ({ ok: false, stage, code, evidence, hostKey, publicCheck, elapsedMs: Date.now() - started })
  /** @returns the passing result. */
  const passed = (hostKey: string | null, publicCheck: 'forward' | 'live'): ProbeResult =>
    ({ ok: true, stage: null, code: null, evidence: null, hostKey, publicCheck, elapsedMs: Date.now() - started })

  // 1. syntax, offline.
  const file = tunnel.privateKeyFile
  if (tunnel.host === null || tunnel.user === null || file === null) {
    return failed('syntax', 'incomplete', 'the tunnel needs a VPS address, an SSH user, and a private key file before it can be tested')
  }
  const hostProblem = tunnelHostProblem(tunnel.host)
  if (hostProblem !== null) {
    return failed('syntax', 'host-syntax', `the VPS address ${JSON.stringify(tunnel.host)} ${hostProblem}`)
  }

  // 2. the local DSH the gateway would proxy to.
  const gui = await checkLocalGui(config.target.port)
  if (!gui.ok) return failed('local-gui', 'local-gui-missing', gui.evidence)

  // 3. the private key.
  let privateKey: Buffer
  try {
    privateKey = await readFile(file)
  } catch (error) {
    return failed('key', 'key-read', `dsh-sync-remote: cannot read the SSH private key ${JSON.stringify(file)}: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 4. the SSH session.
  const session = await openSession({ config, pin, privateKey })
  if (!session.ok) return failed('ssh', session.code, session.evidence)
  const client = session.client
  log.info(`dsh-sync-remote: connection test to ${tunnel.user as string}@${tunnel.host as string}:${String(tunnel.port)} authenticated; the server presented host key ${session.hostKey ?? '(not reported)'}`)

  // 5 + 6. the remote port, and the public round trip through it.
  const remotePort = tunnel.remotePort
  const liveHoldsIt = liveRemotePort !== null && liveRemotePort === remotePort
  let target: ProofTarget | null = null
  let bound = false
  try {
    if (liveHoldsIt) {
      // The running tunnel already owns that port, so this test must use the live
      // chain for its proof instead of binding a second time.
      const live = await checkPublicLive(config, statusToken)
      return live.ok ? passed(session.hostKey, 'live') : failed('public', live.code, live.evidence, session.hostKey, 'live')
    }
    target = await listenProofTarget()
    bridgeToProof(client, remotePort, target.port)
    const forwarded = await forwardRemote(client, remotePort)
    if (!forwarded.ok) return failed('forward', 'forward-refused', forwarded.evidence, session.hostKey, 'forward')
    bound = true
    const publicResult = await checkPublicNonce(config, target)
    return publicResult.ok ? passed(session.hostKey, 'forward') : failed('public', publicResult.code, publicResult.evidence, session.hostKey, 'forward')
  } finally {
    if (bound) releaseForward(client, remotePort)
    if (target !== null) await target.close()
    try {
      client.end()
    } catch {
      // A client that never reached `ready` can refuse end(); the socket is already
      // gone in that case, which is all a test needs.
    }
  }
}

/** What the SSH stage produced: a ready client, or the classified failure. */
type SessionOutcome =
  | { ok: true; client: Client; hostKey: string | null }
  | { ok: false; code: ProbeCode; evidence: string }

/**
 * Open one SSH session and stop at `ready`.
 *
 * `ready` is the whole proof of this stage: the address resolved, the socket
 * connected, the host key was accepted, and ssh2 authenticated the identity.
 * @param input - the candidate, the pin, and the key material.
 * @returns the session, or the classified failure.
 */
function openSession(input: { config: ResolvedConfig; pin: string | null; privateKey: Buffer }): Promise<SessionOutcome> {
  const { config, pin, privateKey } = input
  const tunnel = config.tunnel
  return new Promise<SessionOutcome>((resolve) => {
    const client = new Client()
    let settled = false
    let presented: string | null = null
    let pinProblem: string | null = null
    /** @param outcome - what to answer; ends the session when it failed. */
    const finish = (outcome: SessionOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!outcome.ok) {
        try {
          client.end()
        } catch {
          // Already gone: nothing to close.
        }
      }
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      finish({ ok: false, code: 'handshake-timeout', evidence: `no SSH answer from ${tunnel.host as string}:${String(tunnel.port)} within ${String(tunnel.readyTimeoutMs)} ms` })
    }, tunnel.readyTimeoutMs + PROBE_GRACE_MS)
    client.on('ready', () => {
      if (settled) {
        client.end()
        return
      }
      settled = true
      clearTimeout(timer)
      resolve({ ok: true, client, hostKey: presented })
    })
    client.on('error', (error) => {
      const level = (error as Error & { level?: string }).level ?? 'error'
      finish(pinProblem === null
        ? { ok: false, code: classifySshFailure(level, error.message), evidence: `${level}: ${error.message}` }
        : { ok: false, code: 'host-key', evidence: pinProblem })
    })
    client.on('close', () => {
      if (settled) return
      finish(pinProblem === null
        ? { ok: false, code: 'dropped', evidence: 'the SSH session closed before it was ready' }
        : { ok: false, code: 'host-key', evidence: pinProblem })
    })
    try {
      client.connect({
        host: tunnel.host as string,
        port: tunnel.port,
        username: tunnel.user as string,
        privateKey,
        passphrase: tunnel.passphrase,
        readyTimeout: tunnel.readyTimeoutMs,
        hostVerifier: (key: Buffer) => {
          const prints = hostKeyFingerprints(key)
          presented = prints.base64
          if (pin === null || fingerprintMatches(pin, prints)) return true
          pinProblem = `the server presented host key ${prints.base64}, which does not match the trusted ${pin}`
          return false
        },
      })
    } catch (error) {
      finish({ ok: false, code: 'key-rejected', evidence: keyRejectedMessage(tunnel.privateKeyFile as string, error) })
    }
  })
}

/**
 * Ask the local DSH whether it is where the gateway would dial it.
 *
 * A DSH answers its own root with 401 (its sign-in page) or 200 (a signed-in
 * browser's session); anything else — or nothing at all — means the gateway would
 * proxy `clientPort` into a void, which is a 502 for every visitor.
 * @param port - the resolved client port.
 * @returns whether something answers like DSH there.
 */
function checkLocalGui(port: number): Promise<{ ok: true } | { ok: false; evidence: string }> {
  return new Promise((resolve) => {
    const request = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: '/', headers: { accept: 'text/html' } }, (response) => {
      response.resume()
      const status = response.statusCode ?? 0
      resolve(status === 401 || status === 200
        ? { ok: true }
        : { ok: false, evidence: `http://127.0.0.1:${String(port)}/ answered HTTP ${String(status)}; DSH answers 401 (its sign-in page) or 200 there` })
    })
    request.setTimeout(LOCAL_GUI_TIMEOUT_MS, () => { request.destroy(new Error(`no answer within ${String(LOCAL_GUI_TIMEOUT_MS)} ms`)) })
    request.on('error', (error) => {
      resolve({ ok: false, evidence: `nothing answers http://127.0.0.1:${String(port)}/ (${error.message}); is 客户端端口 the port dsh web listens on?` })
    })
    request.end()
  })
}

/** One throwaway nonce server, and the port the VPS-side forward will be bridged to. */
function listenProofTarget(): Promise<ProofTarget> {
  const nonce = randomBytes(16).toString('hex')
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    response.end(nonce)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('the probe server did not report a port'))
        return
      }
      resolve({
        port: address.port,
        nonce,
        close: () => new Promise<void>((done) => {
          server.closeAllConnections()
          server.close(() => { done() })
        }),
      })
    })
  })
}

/**
 * Hand the forward's accepted connections to the nonce server.
 * @param client - the ready SSH client.
 * @param remotePort - the remote port that was requested.
 * @param localPort - where the nonce server listens.
 */
function bridgeToProof(client: Client, remotePort: number, localPort: number): void {
  client.on('tcp connection', (info, accept, reject) => {
    // A connection for another port is not this test's business.
    if (info.destPort !== remotePort) {
      reject()
      return
    }
    const channel: ClientChannel = accept()
    const socket: Socket = connectTcp({ host: '127.0.0.1', port: localPort })
    let closed = false
    const finish = (): void => {
      if (closed) return
      closed = true
      channel.destroy()
      socket.destroy()
    }
    channel.on('error', finish)
    socket.on('error', finish)
    channel.on('close', finish)
    socket.on('close', finish)
    channel.pipe(socket)
    socket.pipe(channel)
  })
}

/**
 * Ask the VPS to bind the port the tunnel would use.
 *
 * This is the stage that catches "the port is already held" — usually by a previous
 * session that never released it — before a real deployment is saved on top of it.
 * @param client - the ready SSH client.
 * @param port - the remote port to bind.
 * @returns whether the server bound it.
 */
function forwardRemote(client: Client, port: number): Promise<{ ok: true } | { ok: false; evidence: string }> {
  return new Promise((resolve) => {
    try {
      client.forwardIn('127.0.0.1', port, (error) => {
        resolve(error === undefined || error === null
          ? { ok: true }
          : { ok: false, evidence: describeForwardFailure(port, error.message) })
      })
    } catch (error) {
      resolve({ ok: false, evidence: `the SSH session could not ask for 127.0.0.1:${String(port)} (${error instanceof Error ? error.message : String(error)})` })
    }
  })
}

/**
 * Release the test's forward.
 * @param client - the SSH client that requested it.
 * @param port - the remote port to release.
 */
function releaseForward(client: Client, port: number): void {
  try {
    client.unforwardIn('127.0.0.1', port, () => {
      // The answer does not change what the test reports, and the session is about
      // to end: this call exists so the port is free for the real tunnel.
    })
  } catch {
    // Same: the session is ending, which releases the forward anyway.
  }
}

/**
 * The public round trip that proves the whole chain, through the test's own forward.
 * @param config - the candidate settings.
 * @param target - the nonce server the forward is bridged to.
 * @returns whether the answer carried this test's nonce.
 */
async function checkPublicNonce(config: ResolvedConfig, target: ProofTarget): Promise<{ ok: true } | { ok: false; code: ProbeCode; evidence: string }> {
  const url = `${config.publicOrigin}${PROBE_PATH}${target.nonce}`
  const answer = await requestPublic(url)
  const described = `${url} → ${describeAnswer(answer)}`
  if (answer.kind === 'timeout') {
    return { ok: false, code: 'public-no-answer', evidence: `${described}: the public address did not answer within ${String(PUBLIC_TIMEOUT_MS)} ms` }
  }
  if (answer.kind === 'error') {
    return { ok: false, code: 'public-unreachable', evidence: `${described}: this machine cannot reach its own public address (DNS, TLS, or network)` }
  }
  if (answer.status === 502 || answer.status === 504) {
    return {
      ok: false,
      code: 'public-port-mismatch',
      evidence: `${described}: the front door reached the VPS but nothing was listening on 127.0.0.1:${String(config.tunnel.remotePort)} — `
        + 'make sure Nginx proxy_pass names the same port as 服务端端口 / serverPort (the test was listening on it right now)',
    }
  }
  if (answer.status !== 200 || !answer.body.includes(target.nonce)) {
    return {
      ok: false,
      code: 'public-wrong-service',
      evidence: `${described}: the public address answered, but not with this test's nonce — the domain does not lead to this deployment`,
    }
  }
  return { ok: true }
}

/**
 * The public proof when the running tunnel already holds the remote port.
 *
 * A second bind is impossible, so the test asks the live chain for something only
 * this gateway can produce: the read-only status endpoint (signed by the state
 * file's token), or — when no token is available — the sign-in page's policy
 * header.
 * @param config - the candidate settings.
 * @param statusToken - the state file's read-only status token, when there is one.
 * @returns whether the live chain answered as this deployment.
 */
async function checkPublicLive(config: ResolvedConfig, statusToken: string | null): Promise<{ ok: true } | { ok: false; code: ProbeCode; evidence: string }> {
  const useStatus = statusToken !== null && statusToken !== ''
  const url = useStatus ? `${config.publicOrigin}/status` : `${config.publicOrigin}/signin`
  const answer = await requestPublic(url, useStatus ? { 'x-dsh-gw-status': statusToken as string } : {})
  const described = `${url} → ${describeAnswer(answer)}`
  if (answer.kind === 'timeout') {
    return { ok: false, code: 'public-no-answer', evidence: `${described}: the public address did not answer within ${String(PUBLIC_TIMEOUT_MS)} ms` }
  }
  if (answer.kind === 'error') {
    return { ok: false, code: 'public-unreachable', evidence: `${described}: this machine cannot reach its own public address (DNS, TLS, or network)` }
  }
  if (answer.status === 502 || answer.status === 504) {
    return {
      ok: false,
      code: 'public-port-mismatch',
      evidence: `${described}: the front door reached the VPS but the tunnel on 127.0.0.1:${String(config.tunnel.remotePort)} did not answer — `
        + 'check that Nginx proxy_pass names the same port as 服务端端口 / serverPort',
    }
  }
  if (answer.status !== 200) {
    return { ok: false, code: 'public-wrong-service', evidence: `${described}: the domain does not lead to this deployment's gateway` }
  }
  const policy = headerOf(answer.headers, 'content-security-policy')
  const looksLikeGateway = useStatus
    ? isStatusJson(answer.body)
    : typeof policy === 'string' && policy.includes(GATEWAY_CSP)
  return looksLikeGateway
    ? { ok: true }
    : { ok: false, code: 'public-wrong-service', evidence: `${described}: the answer was not this gateway's (expected ${useStatus ? 'the status JSON' : 'the sign-in page policy'})` }
}

/**
 * One request to the public origin, following a couple of redirects.
 * @param url - the absolute URL to ask for.
 * @param headers - extra request headers.
 * @returns the answer, the error, or the timeout.
 */
function requestPublic(url: string, headers: Record<string, string> = {}, redirects = 0): Promise<PublicAnswer> {
  return new Promise((resolve) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      resolve({ kind: 'error', message: `the public origin is not an absolute URL: ${url}` })
      return
    }
    const secure = parsed.protocol === 'https:'
    const request = (secure ? httpsRequest : httpRequest)({
      hostname: parsed.hostname,
      port: parsed.port === '' ? (secure ? 443 : 80) : Number(parsed.port),
      method: 'GET',
      path: `${parsed.pathname}${parsed.search}`,
      headers: { host: parsed.host, accept: 'text/plain, application/json', ...headers },
    }, (response: IncomingMessage) => {
      const location = headerOf(response.headers, 'location')
      if (typeof location === 'string' && response.statusCode !== undefined
        && [301, 302, 303, 307, 308].includes(response.statusCode) && redirects < MAX_REDIRECTS) {
        response.resume()
        let next: string
        try {
          next = new URL(location, url).toString()
        } catch {
          resolve({ kind: 'error', message: `the front door redirected to an unusable location: ${location}` })
          return
        }
        void requestPublic(next, headers, redirects + 1).then(resolve)
        return
      }
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('end', () => {
        resolve({ kind: 'answer', status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') })
      })
      response.on('error', (error) => { resolve({ kind: 'error', message: error.message }) })
    })
    request.setTimeout(PUBLIC_TIMEOUT_MS, () => {
      request.destroy()
      resolve({ kind: 'timeout' })
    })
    request.on('error', (error) => { resolve({ kind: 'error', message: error.message }) })
    request.end()
  })
}

/** @param answer - a public answer. @returns one phrase for the evidence line. */
function describeAnswer(answer: PublicAnswer): string {
  if (answer.kind === 'timeout') return 'no answer'
  if (answer.kind === 'error') return answer.message
  return `HTTP ${String(answer.status)}`
}

/** @returns whether the body parses as the gateway's status JSON. */
function isStatusJson(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) return false
    const origin = (parsed as { origin?: unknown }).origin
    return typeof origin === 'string' && origin !== ''
  } catch {
    return false
  }
}

/** @returns one response header, however the platform handed it over. */
function headerOf(headers: Record<string, string | string[] | undefined>, name: string): string | string[] | undefined {
  return headers[name.toLowerCase()]
}

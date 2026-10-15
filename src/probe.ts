/**
 * The connection test behind the settings page's 「测试连接 / Test connection」.
 *
 * Its whole job is to answer one question — do these values reach that VPS as
 * that user with that key? — so the page can refuse to persist a configuration
 * nobody has proven, and the running plugin can refuse to dial one. Reaching
 * `ready` *is* the proof: the address resolved, the socket connected, the host
 * key was accepted, and ssh2 authenticated the identity. Nothing else is
 * needed, and nothing else is attempted: the test requests no remote forward,
 * binds nothing on the VPS, and hangs up immediately.
 *
 * The pin is compared but never written. Trust-on-first-use stays where it was —
 * on the tunnel's own first connection — because a test pointed at the wrong
 * machine must not be the thing that pins it.
 *
 * @module @allynv/dsh-sync-remote/probe
 */

import { readFile } from 'node:fs/promises'
import { Client } from 'ssh2'
import { tunnelHostProblem, type ResolvedTunnelConfig } from './config.ts'
import {
  classifySshFailure, fingerprintMatches, hostKeyFingerprints, keyRejectedMessage,
  type TunnelFailureKind,
} from './tunnel.ts'
import type { Logger } from './types.ts'

/** What one test tries to prove. */
export interface ProbeCandidate {
  /** The candidate tunnel settings, already resolved (never raw form text). */
  config: ResolvedTunnelConfig
  /** The host key pinned by earlier connections, or null before the first one. */
  pin: string | null
  log: Logger
}

/** What one test found. */
export interface ProbeResult {
  ok: boolean
  /** Why it failed, classified the same way the tunnel classifies its own dials. */
  kind: TunnelFailureKind | null
  /** One actionable sentence, or null on success. */
  reason: string | null
  /** `SHA256:<base64>` of the key the server presented, when it got that far. */
  hostKey: string | null
  elapsedMs: number
}

/** How long past ssh2's own ready timeout before the probe gives up on its own. */
const PROBE_GRACE_MS = 1_000

/**
 * Dial the candidate configuration once and hang up.
 * @param candidate - the settings to prove, the pinned host key, and the logger.
 * @returns the outcome; never rejects.
 */
export function probeTunnel(candidate: ProbeCandidate): Promise<ProbeResult> {
  const started = Date.now()
  const { config, pin, log } = candidate
  /**
   * @param kind - the classified failure.
   * @param reason - one actionable sentence.
   * @param hostKey - the presented fingerprint, when the handshake got that far.
   * @returns the failed result.
   */
  const failed = (kind: TunnelFailureKind | null, reason: string, hostKey: string | null = null): ProbeResult =>
    ({ ok: false, kind, reason, hostKey, elapsedMs: Date.now() - started })

  const file = config.privateKeyFile
  if (config.host === null || config.user === null || file === null) {
    return Promise.resolve(failed('key', 'the tunnel needs a VPS address, an SSH user, and a private key file before it can be tested'))
  }
  // Offline first: a value that can never be a host must not cost a dial, and
  // the sentence names the field rather than repeating getaddrinfo's confusion.
  const problem = tunnelHostProblem(config.host)
  if (problem !== null) {
    return Promise.resolve(failed('key', `the VPS address ${JSON.stringify(config.host)} ${problem}`))
  }
  return readFile(file).then(
    privateKey => new Promise<ProbeResult>((resolve) => {
      const client = new Client()
      let settled = false
      let presented: string | null = null
      let pinProblem: string | null = null
      /** @param result - what to answer; ends the session whatever it is. */
      const finish = (result: ProbeResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          client.end()
        } catch {
          // A client that never reached `ready` can refuse end(); the socket is
          // already gone in that case, which is all a test needs.
        }
        resolve(result)
      }
      const timer = setTimeout(() => {
        finish(failed('handshake-timeout', `no SSH answer from ${config.host as string}:${String(config.port)} within ${String(config.readyTimeoutMs)} ms`))
      }, config.readyTimeoutMs + PROBE_GRACE_MS)
      client.on('ready', () => {
        log.info(`dsh-sync-remote: connection test to ${config.user as string}@${config.host as string}:${String(config.port)} authenticated; the server presented host key ${presented ?? '(not reported)'}`)
        finish({ ok: true, kind: null, reason: null, hostKey: presented, elapsedMs: Date.now() - started })
      })
      client.on('error', (error) => {
        const level = (error as Error & { level?: string }).level ?? 'error'
        finish(pinProblem === null
          ? failed(classifySshFailure(level, error.message), `${level}: ${error.message}`)
          : failed('host-key', pinProblem, presented))
      })
      client.on('close', () => {
        finish(pinProblem === null
          ? failed('dropped', 'the SSH session closed before it was ready')
          : failed('host-key', pinProblem, presented))
      })
      try {
        client.connect({
          host: config.host as string,
          port: config.port,
          username: config.user as string,
          privateKey,
          passphrase: config.passphrase,
          readyTimeout: config.readyTimeoutMs,
          hostVerifier: (key: Buffer) => {
            const prints = hostKeyFingerprints(key)
            presented = prints.base64
            if (pin === null || fingerprintMatches(pin, prints)) return true
            pinProblem = `the server presented host key ${prints.base64}, which does not match the trusted ${pin}`
            return false
          },
        })
      } catch (error) {
        finish(failed('key', keyRejectedMessage(file, error)))
      }
    }),
    (error: unknown) => failed('key', `dsh-sync-remote: cannot read the SSH private key ${JSON.stringify(file)}: ${error instanceof Error ? error.message : String(error)}`),
  )
}

/**
 * The settings page's payload: what this plugin is actually running with, where
 * each editable value came from, the values the operator cannot change, and the
 * state of the one thing a human needs from the page — a one-time enrollment
 * link.
 *
 * The token itself is deliberately absent here. It is returned by an explicit
 * mint request and by nothing else, so a payload that gets logged, cached, or
 * polled never carries a credential.
 *
 * The builder is pure so the payload can be asserted without a live gateway;
 * `index.ts` supplies the live objects and `routes.ts` only moves the JSON.
 *
 * @module @allynv/dsh-sync-remote/status
 */

import { LOOPBACK, RP_NAME, defaultStateFile, type Provenance, type ResolvedConfig } from './config.ts'
import type { TunnelSnapshot } from './tunnel.ts'
import type { PasskeySummary } from './types.ts'

/** One effective value, keyed by its dotted form path. */
export type EffectiveValue = string | number | boolean | null

/**
 * The OpenSSH command line this deployment's tunnel is equivalent to.
 *
 * The mapping is not obvious from the field names — `-p` is the SSH port, `-R`
 * carries the tunnel port and the local forward, and the SSH port has no field
 * of its own in the command because it defaults to 22. Printing the command
 * makes a mis-filled port visible at a glance instead of only as
 * `ECONNREFUSED` on a port nobody expected to be dialed.
 * @param config - resolved settings.
 * @returns one `ssh` invocation, or null when there is no tunnel to describe.
 */
export function sshEquivalent(config: ResolvedConfig): string | null {
  if (!config.tunnel.enabled || config.tunnel.host === null || config.tunnel.user === null) return null
  const parts = ['ssh']
  if (config.tunnel.privateKeyFile !== null) parts.push('-i', config.tunnel.privateKeyFile)
  parts.push('-p', String(config.tunnel.port))
  parts.push('-N', '-R', `${String(config.tunnel.remotePort)}:${config.tunnel.remoteHost}:${String(config.serverPort)}`)
  parts.push(`${config.tunnel.user}@${config.tunnel.host}`)
  return parts.join(' ')
}

/** Everything the settings page renders. */
export interface SyncRemoteStatus {
  /** Whether a public origin is configured at all. */
  configured: boolean
  /**
   * Why the plugin is not serving, when it *is* configured but refused. Null
   * while the row is merely unconfigured: "no origin yet" is a state to guide the
   * operator out of, not a failure to report at them.
   */
  configError: string | null
  /** Effective value per editable form path, as this process resolved it. */
  effective: Record<string, EffectiveValue>
  /** Which layer supplied each editable form path. */
  sources: Provenance
  /** Values the operator cannot set; the page shows them read-only. */
  info: {
    /** Gateway listener, always loopback. */
    bind: string | null
    /** Local DSH Web origin the gateway dials. */
    web: string | null
    /** WebAuthn Relying Party ID, always the public origin's hostname. */
    rpID: string | null
    /** Name the authenticator shows; fixed. */
    rpName: string
    /** The state file holding the signing secret and the passkeys. */
    stateFile: string
    /** VPS-side listener for the tunnel, when the tunnel is on. */
    remoteBind: string | null
    /** Host key pinned on the first connection, or null before that. */
    hostKey: string | null
    /** Whether session cookies carry `Secure`; follows the public origin. */
    secureCookies: boolean
    /** Whether an SSH key passphrase is set; the value itself never rides. */
    passphraseSet: boolean
    /** The equivalent `ssh -R …` command line, or null when the tunnel is off. */
    sshEquivalent: string | null
  }
  /** The one-time enrollment link's state. The link itself never rides here. */
  enrollment: {
    /** Whether any passkey is registered. */
    enrolled: boolean
    /** Whether a usable one-time link exists right now. */
    pending: boolean
    /** When it stops working, or null. */
    expiresAt: number | null
  }
  /** Registered devices, without any key material. */
  passkeys: PasskeySummary[]
  runtime: {
    gateway: 'listening' | 'off'
    /**
     * The tunnel's state, including the two deliberate refusals: `blocked` (the
     * gateway is up and the tunnel is not started because the local GUI's
     * browser-trust fence refuses the authority browsers use) and `untested`
     * (this configuration has never passed a connection test, so nothing is
     * dialed and nothing is bound). Both are served-nothing states, not
     * transient ones.
     */
    tunnel: TunnelSnapshot | null
    /** What the local GUI answered for the authority browsers use. */
    fence: { authority: string; status: number; ok: boolean } | null
    /**
     * What DSH itself was launched with, when the Host can report it.
     *
     * The settings page needs it to *explain* a refusal in the operator's own
     * language: the Host's `lastError` is an English console sentence, and the one
     * fact that turns "the fence refused this Host" into "you passed a different
     * --trusted-host" is this list.
     */
    launch: { trustedHosts: string[]; publicUrl: string | null } | null
  }
}

/** The live facts one payload is built from. */
export interface StatusInput {
  /** Whether the row names a public origin at all. */
  configured: boolean
  /** Resolved settings, or null when nothing is configured or resolution failed. */
  resolved: ResolvedConfig | null
  /** Which layer supplied each field. */
  sources: Provenance
  /** Refusal text when resolution failed; the caller nulls it when unconfigured. */
  configError: string | null
  /** Whether any passkey is registered. */
  enrolled: boolean
  /** Whether a one-time enrollment link is pending. */
  enrollmentPending: boolean
  /** When that link stops working. */
  enrollmentExpiresAt: number | null
  /** The host key pinned on the first connection. */
  hostKey: string | null
  passkeys: PasskeySummary[]
  /** Whether the gateway listener is up. */
  gatewayListening: boolean
  tunnel: TunnelSnapshot | null
  fence: { authority: string; status: number } | null
  /** `dsh web` launch facts, or null when the Host does not expose them. */
  launch: { trustedHosts: string[]; publicUrl: string | null } | null
}

/**
 * Project the live facts into the settings page payload.
 * @param input - the live facts.
 * @returns the payload; no credential is ever part of it.
 */
export function buildStatus(input: StatusInput): SyncRemoteStatus {
  const { resolved } = input
  const effective: Record<string, EffectiveValue> = {}
  const sources: Record<string, unknown> = { ...input.sources }
  if (resolved !== null) {
    effective.publicOrigin = resolved.publicOrigin
    effective.serverPort = resolved.serverPort
    effective.clientPort = resolved.target.port
    effective.sessionTtlHours = resolved.sessionTtlHours
    effective['tunnel.enabled'] = resolved.tunnel.enabled
    effective['tunnel.host'] = resolved.tunnel.host
    // Only a live tunnel has an SSH port: a disabled one carries a placeholder
    // that means nothing. Publishing it would pre-fill the page with `22` and
    // invite a save that turns a placeholder into a configured value.
    if (resolved.tunnel.enabled) {
      effective['tunnel.port'] = resolved.tunnel.port
    } else {
      delete sources['tunnel.port']
    }
    effective['tunnel.user'] = resolved.tunnel.user
    effective['tunnel.privateKeyFile'] = resolved.tunnel.privateKeyFile
    // The page needs this one to decide whether to offer the release action at all:
    // it is the row's own opt-in, never a capability the page may assume.
    effective['tunnel.releaseStaleForward'] = resolved.tunnel.releaseStaleForward
  }
  return {
    configured: input.configured,
    configError: input.configError,
    effective,
    sources: sources as SyncRemoteStatus['sources'],
    info: {
      bind: resolved === null ? null : `${LOOPBACK}:${String(resolved.serverPort)}`,
      web: resolved === null ? null : `http://${LOOPBACK}:${String(resolved.target.port)}`,
      rpID: resolved === null ? null : resolved.rpID,
      rpName: RP_NAME,
      stateFile: resolved === null ? defaultStateFile() : resolved.stateFile,
      remoteBind: resolved === null || !resolved.tunnel.enabled ? null : `${LOOPBACK}:${String(resolved.tunnel.remotePort)}`,
      hostKey: input.hostKey,
      secureCookies: resolved !== null && resolved.secureCookies,
      // `text()` trims and turns an empty value into undefined, so "set" is
      // exactly "not undefined" and the extra empty-string arm was dead code.
      passphraseSet: resolved !== null && resolved.tunnel.passphrase !== undefined,
      sshEquivalent: resolved === null ? null : sshEquivalent(resolved),
    },
    enrollment: {
      enrolled: input.enrolled,
      pending: input.enrollmentPending,
      expiresAt: input.enrollmentPending ? input.enrollmentExpiresAt : null,
    },
    passkeys: input.passkeys,
    runtime: {
      gateway: input.gatewayListening ? 'listening' : 'off',
      tunnel: input.tunnel,
      fence: input.fence === null ? null : { ...input.fence, ok: input.fence.status !== 403 },
      launch: input.launch,
    },
  }
}

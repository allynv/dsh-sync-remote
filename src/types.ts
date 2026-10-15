/**
 * Shapes shared by more than one module of this bundle.
 *
 * They live in one leaf module so `state.ts`, `webauthn.ts`, `tunnel.ts`, and
 * `gateway.ts` cannot drift into three spellings of the same record.
 *
 * @module @allynv/dsh-sync-remote/types
 */

/**
 * The three console levels this bundle reports at.
 *
 * `info` is routine detail and stays off the operator's console by default (see
 * `loggerFor()` in `index.ts`); `warn` and `error` are the levels a human has
 * to see.
 */
export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** One registered authenticator, as stored in the state file. */
export interface PasskeyRecord {
  /** WebAuthn credential ID, base64url. */
  id: string
  /** COSE public key, base64url. */
  publicKey: string
  /** Signature counter reported by the authenticator. */
  counter: number
  /** Transports the authenticator advertised, possibly empty. */
  transports: string[]
  /** Operator-visible name chosen at enrollment. */
  label: string
  /** Epoch milliseconds of registration. */
  createdAt: number
  /** Epoch milliseconds of the last successful assertion, or null. */
  lastUsedAt: number | null
  /** `singleDevice` or `multiDevice`, as reported at registration. */
  deviceType: string | null
  /** Whether the credential is known to be backed up. */
  backedUp: boolean | null
}

/** A passkey without its key material, for status output and lists. */
export interface PasskeySummary {
  id: string
  label: string
  createdAt: number
  lastUsedAt: number | null
  deviceType: string | null
  backedUp: boolean | null
}

/** One tunnel configuration a connection test has proven. */
export interface TunnelTestRecord {
  /** Identity of the configuration; see `tunnelFingerprint`. */
  fingerprint: string
  /** Epoch milliseconds of the successful test. */
  at: number
  /** The host key the server presented then, for display only. */
  hostKey: string | null
}

/** The whole durable state document. */
export interface StateDocument {
  version: number
  /** HMAC key for the gateway's own cookies, base64url. */
  secret: string
  /**
   * Bearer token for the read-only `/status` endpoint, base64url.
   *
   * Deliberately a different value from {@link secret}: `/status` is reachable
   * from the internet and its token travels in a URL, so a leak there must grant
   * reconnaissance only — never the ability to forge a session cookie. Added
   * after the first releases, so a state file without it gets one on load.
   */
  statusToken: string
  /** Stable WebAuthn user handle, base64url. */
  userID: string
  /** Trusted SSH host key: `SHA256:<base64>` after the first connection. */
  sshHostKey: string | null
  passkeys: PasskeyRecord[]
  /**
   * Tunnel configurations a connection test has proven, newest first.
   *
   * A configuration missing from this list is never dialed: the values may have
   * been edited in the profile by hand, and the only thing that makes them
   * trustworthy is a test that reached the VPS with exactly those values. A
   * short list rather than one entry, because testing new values and then not
   * saving (or having the save refused) must not un-verify the configuration
   * that is actually running. Added after the first releases; an older file
   * simply has none.
   */
  tunnelTests: TunnelTestRecord[]
}

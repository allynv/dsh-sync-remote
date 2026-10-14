/**
 * Passkey ceremonies for the gateway: registration behind an enrollment grant
 * and authentication on the login page.
 *
 * A ceremony's challenge lives in memory with a short expiry and is consumed
 * exactly once, keyed by a random identifier the browser echoes back. Keeping
 * it out of the cookie jar means an attacker who can read cookies still cannot
 * replay a challenge, and the one-shot rule stops a captured response from
 * being replayed at all.
 *
 * @module @allynv/dsh-sync-remote/webauthn
 */

import { randomUUID } from 'node:crypto'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  UserVerificationRequirement,
} from '@simplewebauthn/server'
import { fromBase64Url, toBase64Url } from './encoding.ts'
import type { StateStore } from './state.ts'
import type { Logger, PasskeyRecord, PasskeySummary, StateDocument } from './types.ts'

/** How long a browser may take to answer a challenge before it is dropped. */
const CEREMONY_TTL_MS = 5 * 60 * 1000

/** A ceremony that answered too late, was never started, or was already used. */
export class CeremonyError extends Error {
  /** @param message - one actionable sentence. */
  constructor(message: string) {
    super(message)
    this.name = 'CeremonyError'
  }
}

/** One in-flight ceremony, consumed exactly once. */
interface Ceremony {
  kind: 'registration' | 'authentication'
  challenge: string
  label: string
  expiresAt: number
}

/** Everything the passkey service needs from its host. */
export interface PasskeyServiceOptions {
  rpID: string
  rpName: string
  origin: string
  state: StateDocument
  store: StateStore
  log: Logger
  userVerification?: UserVerificationRequirement
}

/**
 * Own the registered credentials and the in-flight ceremonies.
 *
 * Every method that changes the credential list persists the state file before
 * returning, so a crash cannot acknowledge a registration the next start would
 * not know about.
 */
export class PasskeyService {
  private readonly rpID: string
  private readonly rpName: string
  private readonly origin: string
  private readonly state: StateDocument
  private readonly store: StateStore
  private readonly log: Logger
  private readonly userVerification: UserVerificationRequirement
  private readonly ceremonies = new Map<string, Ceremony>()

  /**
   * @param options - relying-party identity, the mutable state, and its store.
   */
  constructor(options: PasskeyServiceOptions) {
    this.rpID = options.rpID
    this.rpName = options.rpName
    this.origin = options.origin
    this.state = options.state
    this.store = options.store
    this.log = options.log
    this.userVerification = options.userVerification ?? 'required'
    this.ceremonies = new Map()
  }

  /** @returns whether at least one passkey is registered. */
  get enrolled(): boolean {
    return this.state.passkeys.length > 0
  }

  /**
   * Credentials without their public key material, for the login page and the
   * status endpoint.
   * @returns one summary per registered passkey.
   */
  list(): PasskeySummary[] {
    return this.state.passkeys.map(entry => ({
      id: entry.id,
      label: entry.label,
      createdAt: entry.createdAt,
      lastUsedAt: entry.lastUsedAt ?? null,
      deviceType: entry.deviceType ?? null,
      backedUp: entry.backedUp ?? null,
    }))
  }

  /** @param ceremonyId - identifier returned by a begin method. @returns the live ceremony. */
  take(ceremonyId: string): Ceremony {
    const ceremony = this.ceremonies.get(ceremonyId)
    if (ceremony === undefined) {
      throw new CeremonyError('this passkey ceremony is unknown or was already used; start again')
    }
    this.ceremonies.delete(ceremonyId)
    if (ceremony.expiresAt <= Date.now()) {
      throw new CeremonyError('this passkey ceremony expired; start again')
    }
    return ceremony
  }

  /** Drop expired ceremonies; they are tiny, but an unbounded map is still a leak. */
  sweep(): void {
    const now = Date.now()
    for (const [id, ceremony] of this.ceremonies) {
      if (ceremony.expiresAt <= now) this.ceremonies.delete(id)
    }
  }

  /**
   * Start a registration ceremony.
   * @param options - display label for the new credential.
   * @returns the ceremony identifier and the browser options.
   */
  async beginRegistration(options: { label?: unknown } = {}): Promise<{ ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
    if (this.state.passkeys.length >= 16) {
      throw new CeremonyError('this gateway already holds 16 passkeys; remove one before adding another')
    }
    this.sweep()
    const browserOptions = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userName: 'operator',
      userDisplayName: this.rpName,
      userID: new Uint8Array(fromBase64Url(this.state.userID)),
      attestationType: 'none',
      excludeCredentials: this.state.passkeys.map(entry => ({
        id: entry.id,
        transports: entry.transports.length > 0 ? entry.transports : undefined,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: this.userVerification,
      },
      timeout: 60_000,
    })
    const ceremonyId = randomUUID()
    this.ceremonies.set(ceremonyId, {
      kind: 'registration',
      challenge: browserOptions.challenge,
      label: typeof options.label === 'string' && options.label.trim() !== '' ? options.label.trim().slice(0, 64) : 'passkey',
      expiresAt: Date.now() + CEREMONY_TTL_MS,
    })
    return { ceremonyId, options: browserOptions }
  }

  /**
   * Finish a registration ceremony and store the credential.
   * @param input - the ceremony identifier and the browser's response.
   * @returns the stored credential summary.
   */
  async finishRegistration(input: { ceremonyId: string; response: RegistrationResponseJSON }): Promise<{ id: string; label: string }> {
    const ceremony = this.take(input.ceremonyId)
    if (ceremony.kind !== 'registration') {
      throw new CeremonyError('this ceremony is not a registration')
    }
    const verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      requireUserPresence: true,
      requireUserVerification: this.userVerification === 'required',
    })
    if (!verification.verified) {
      throw new CeremonyError('the authenticator response was not verified')
    }
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo
    if (this.state.passkeys.some(entry => entry.id === credential.id)) {
      throw new CeremonyError('this authenticator is already registered')
    }
    const record: PasskeyRecord = {
      id: credential.id,
      publicKey: toBase64Url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
      label: ceremony.label,
      createdAt: Date.now(),
      lastUsedAt: null,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
    }
    this.state.passkeys.push(record)
    await this.store.persist()
    this.log.info(`dsh-sync-remote: registered passkey ${JSON.stringify(record.label)} (${credentialDeviceType}, ${String(this.state.passkeys.length)} total)`)
    return { id: record.id, label: record.label }
  }

  /**
   * Start an authentication ceremony.
   * @returns the ceremony identifier and the browser options.
   */
  async beginAuthentication(): Promise<{ ceremonyId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
    if (!this.enrolled) {
      throw new CeremonyError('no passkey is registered on this gateway yet')
    }
    this.sweep()
    const browserOptions = await generateAuthenticationOptions({
      rpID: this.rpID,
      allowCredentials: this.state.passkeys.map(entry => ({
        id: entry.id,
        transports: entry.transports.length > 0 ? entry.transports : undefined,
      })),
      userVerification: this.userVerification,
      timeout: 60_000,
    })
    const ceremonyId = randomUUID()
    this.ceremonies.set(ceremonyId, {
      kind: 'authentication',
      challenge: browserOptions.challenge,
      label: 'passkey',
      expiresAt: Date.now() + CEREMONY_TTL_MS,
    })
    return { ceremonyId, options: browserOptions }
  }

  /**
   * Finish an authentication ceremony.
   * @param input - the ceremony identifier and the browser's response.
   * @returns the authenticating credential's identifier.
   */
  async finishAuthentication(input: { ceremonyId: string; response: AuthenticationResponseJSON }): Promise<string> {
    const ceremony = this.take(input.ceremonyId)
    if (ceremony.kind !== 'authentication') {
      throw new CeremonyError('this ceremony is not an authentication')
    }
    const id = typeof input.response?.id === 'string' ? input.response.id : ''
    const stored = this.state.passkeys.find(entry => entry.id === id)
    if (stored === undefined) {
      throw new CeremonyError('this authenticator is not registered on this gateway')
    }
    let publicKey: Uint8Array<ArrayBuffer>
    try {
      // `Uint8Array.from` copies into a plain ArrayBuffer-backed view, which is
      // the shape @simplewebauthn/server's credential type requires; a Buffer's
      // backing store is typed as possibly shared.
      publicKey = Uint8Array.from(fromBase64Url(stored.publicKey))
    } catch {
      throw new CeremonyError('the stored credential is unreadable; re-enroll this authenticator')
    }
    const verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      credential: {
        id: stored.id,
        publicKey,
        counter: stored.counter,
        transports: stored.transports.length > 0 ? stored.transports : undefined,
      },
      requireUserVerification: this.userVerification === 'required',
    })
    if (!verification.verified) {
      throw new CeremonyError('the authenticator response was not verified')
    }
    stored.counter = verification.authenticationInfo.newCounter
    stored.lastUsedAt = Date.now()
    await this.store.persist()
    return stored.id
  }

  /**
   * Forget one registered passkey. The caller decides who may ask; this method
   * only refuses to empty the list, because a gateway with no credential and a
   * live enrollment secret is one `curl` away from a stranger's passkey.
   * @param id - credential identifier.
   * @returns whether a credential was removed.
   */
  async remove(id: string): Promise<boolean> {
    const at = this.state.passkeys.findIndex(entry => entry.id === id)
    if (at === -1) return false
    if (this.state.passkeys.length === 1) {
      throw new CeremonyError('refusing to remove the last passkey; register another authenticator first')
    }
    this.state.passkeys.splice(at, 1)
    await this.store.persist()
    return true
  }
}

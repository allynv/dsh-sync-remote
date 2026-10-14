/**
 * The gateway's own signed values, and the cookie names that carry them.
 *
 * One HMAC scheme covers three capabilities, and the capability is part of the
 * signed payload: an authenticated `session` (an expiry and the passkey that
 * minted it), the `next` path an unauthenticated visitor was heading for, and a
 * short-lived `enrollment` grant. The audience check on every read is the
 * security boundary — without it the `next` cookie, which anyone can obtain with
 * one anonymous request, would satisfy a session lookup and the passkey gate
 * could be skipped by renaming a cookie.
 *
 * The cookie is the *only* thing the gateway trusts on a proxied request, so the
 * format mirrors what a signed session needs: a version tag, the payload as JSON,
 * and a signature over the encoded payload, compared in constant time and
 * re-checked against the clock on every read. Every cookie name this plugin sets
 * is declared here, beside the vocabulary that gives them meaning.
 *
 * @module @allynv/dsh-sync-remote/session-cookie
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { fromBase64Url, randomText, toBase64Url } from './encoding.ts'

/** Cookie name carrying an authenticated gateway session. */
export const SESSION_COOKIE = 'dsh-gw-session'
/** Cookie name carrying a short-lived enrollment grant. */
export const ENROLL_COOKIE = 'dsh-gw-enroll'
/** Cookie carrying the page to return to after a ceremony (audience `next`). */
export const NEXT_COOKIE = 'dsh-gw-next'
/**
 * Marker cookie that keeps the DSH sign-in redirect from looping.
 *
 * Not a signed value: it carries no capability, only the fact that a browser was
 * already sent through the GUI's launch URL once.
 */
export const AUTOLOGIN_COOKIE = 'dsh-gw-autologin'
/**
 * Payload version of both signed values.
 *
 * Bumped to 2 when `audience` was added: every cookie minted before that field
 * existed fails verification, which is the point — those values could be
 * replayed in a role they were never issued for.
 */
const PAYLOAD_VERSION = 2

/**
 * What a signed value is allowed to be used for.
 *
 * The same signing secret covers three very different capabilities, so the
 * purpose has to be part of the signed payload and checked on every read:
 * without it, the `dsh-gw-next` cookie handed to any unauthenticated navigation
 * verified as a full session and the passkey gate could be skipped entirely by
 * replaying it under the session cookie's name.
 */
export type SessionAudience = 'session' | 'next' | 'enrollment'

/** The verified contents of a signed cookie. */
export interface SignedPayload {
  readonly version: number
  readonly issuedAt: number
  readonly expiresAt: number
  readonly credentialId: string
  readonly audience: SessionAudience
  readonly nonce: string
}

/** Expiry and scope flags one Set-Cookie carries. */
export interface CookieAttributes {
  maxAgeSeconds?: number
  expiresAt?: number
  sameSite?: 'Strict' | 'Lax' | 'None'
  secure?: boolean
}

/** Inputs for minting a session cookie. */
export interface SessionOptions {
  ttlMs: number
  credentialId: string
  /** The capability this value grants; checked again on every read. */
  audience: SessionAudience
  now?: number
}

/** @returns whether a parsed JSON value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a Cookie header into pairs. Generated names and values are cookie-safe,
 * so a minimal parser is enough and no general Cookie decoding is implied.
 * @param header - the request's Cookie header, when present.
 * @returns name to value; a repeated name keeps its first occurrence.
 */
export function parseCookieHeader(header: unknown): Map<string, string> {
  const jar = new Map()
  if (typeof header !== 'string' || header === '') return jar
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    const name = segment.slice(0, at).trim()
    if (name === '' || jar.has(name)) continue
    jar.set(name, segment.slice(at + 1).trim())
  }
  return jar
}

/**
 * Serialize one Set-Cookie value. `Secure` follows the public origin, not the
 * local listener: the browser leg is HTTPS even though the gateway itself
 * speaks plain HTTP to the tunnel.
 * @param name - cookie name.
 * @param value - cookie value.
 * @param attributes - expiry and flags.
 * @returns the Set-Cookie header value.
 */
export function serializeCookie(name: string, value: string, attributes: CookieAttributes): string {
  const parts = [`${name}=${value}`]
  if (attributes.maxAgeSeconds !== undefined) parts.push(`Max-Age=${String(Math.max(0, Math.floor(attributes.maxAgeSeconds)))}`)
  parts.push('Path=/', 'HttpOnly')
  if (attributes.expiresAt !== undefined) parts.push(`Expires=${new Date(attributes.expiresAt).toUTCString()}`)
  parts.push(`SameSite=${attributes.sameSite ?? 'Strict'}`)
  if (attributes.secure === true) parts.push('Secure')
  return parts.join('; ')
}

/**
 * Sign a JSON payload as `v1.<body>.<signature>`.
 * @param payload - JSON-serializable payload.
 * @param secret - signing secret as base64url text.
 * @returns the signed value.
 */
export function signValue(payload: unknown, secret: string): string {
  const body = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = createHmac('sha256', fromBase64Url(secret)).update(body).digest()
  return `v${String(PAYLOAD_VERSION)}.${body}.${toBase64Url(signature)}`
}

/**
 * Verify and decode a signed value.
 * @param value - the cookie value as received.
 * @param secret - signing secret as base64url text.
 * @returns the payload, or undefined for a malformed or mis-signed value.
 */
export function verifyValue(value: unknown, secret: string): SignedPayload | undefined {
  if (typeof value !== 'string') return undefined
  const parts = value.split('.')
  if (parts.length !== 3) return undefined
  const [version, body, encoded] = parts
  if (version !== `v${String(PAYLOAD_VERSION)}` || body === undefined || encoded === undefined) return undefined
  let presented: Buffer
  try {
    presented = fromBase64Url(encoded)
  } catch {
    return undefined
  }
  const expected = createHmac('sha256', fromBase64Url(secret)).update(body).digest()
  if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) return undefined
  let decoded: unknown
  try {
    decoded = JSON.parse(fromBase64Url(body).toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(decoded)) return undefined
  const { issuedAt, expiresAt, credentialId, audience, nonce } = decoded
  if (decoded.version !== PAYLOAD_VERSION
    || !Number.isSafeInteger(issuedAt)
    || !Number.isSafeInteger(expiresAt)
    || typeof credentialId !== 'string'
    || (audience !== 'session' && audience !== 'next' && audience !== 'enrollment')
    || typeof nonce !== 'string') return undefined
  return {
    version: PAYLOAD_VERSION,
    issuedAt: issuedAt as number,
    expiresAt: expiresAt as number,
    credentialId,
    audience,
    nonce,
  }
}

/**
 * Mint a session payload for one passkey.
 * @param secret - signing secret as base64url text.
 * @param options - credential identity, capability, and lifetime.
 * @returns the signed cookie value and its expiry.
 */
export function createSession(secret: string, options: SessionOptions): { value: string; issuedAt: number; expiresAt: number } {
  const issuedAt = options.now ?? Date.now()
  const expiresAt = issuedAt + options.ttlMs
  const value = signValue({
    version: PAYLOAD_VERSION,
    issuedAt,
    expiresAt,
    credentialId: options.credentialId,
    audience: options.audience,
    nonce: randomText(12),
  }, secret)
  return { value, issuedAt, expiresAt }
}

/**
 * Verify a signed value against the current clock AND the capability it claims.
 *
 * The audience check is the security boundary: the same secret signs session
 * cookies, the `dsh-gw-next` return-path cookie handed to any unauthenticated
 * navigation, and enrollment grants. Without this check, the next-cookie (which
 * anyone can obtain with one anonymous request) satisfied `session()` and the
 * passkey gate could be skipped by renaming the cookie.
 * @param value - the cookie value as received.
 * @param secret - signing secret as base64url text.
 * @param now - current epoch milliseconds.
 * @param audience - the capability the caller is willing to accept.
 * @returns the payload only while it is unexpired, self-consistent, and of that audience.
 */
export function verifySession(
  value: unknown,
  secret: string,
  now = Date.now(),
  audience: SessionAudience = 'session',
): SignedPayload | undefined {
  const payload = verifyValue(value, secret)
  if (payload === undefined) return undefined
  if (payload.audience !== audience) return undefined
  if (payload.issuedAt > now || payload.expiresAt <= now || payload.expiresAt <= payload.issuedAt) return undefined
  return payload
}

/**
 * Verify an enrollment grant.
 * @param value - the cookie value as received.
 * @param secret - signing secret as base64url text.
 * @param now - current epoch milliseconds.
 * @returns the payload only while it is unexpired and marked as an enrollment.
 */
export function verifyEnrollment(value: unknown, secret: string, now = Date.now()): SignedPayload | undefined {
  return verifySession(value, secret, now, 'enrollment')
}

/**
 * Base64url text conversion shared by the passkey store, the signed session
 * cookie, and the browser ceremony payloads. One leaf module so every other
 * file converts bytes the same way — WebAuthn's wire format is base64url
 * everywhere, and a second implementation is a second chance to differ.
 *
 * @module @allynv/dsh-sync-remote/encoding
 */

import { randomBytes } from 'node:crypto'

/** Canonical base64url alphabet; padding is never part of the encoding we emit. */
const BASE64URL = /^[A-Za-z0-9_-]*$/u

/**
 * Encode bytes as unpadded base64url text.
 * @param value - bytes to encode.
 * @returns unpadded base64url text.
 */
export function toBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

/**
 * Decode base64url text, refusing anything that is not exactly canonical: a
 * stray character, illegal padding, or a length `% 4 === 1` would otherwise
 * decode to different bytes than the text claims, and a signature compared over
 * those bytes would be comparing the wrong thing.
 * @param text - unpadded base64url text.
 * @returns the decoded bytes.
 * @throws when the text is not canonical base64url.
 */
export function fromBase64Url(text: string): Buffer {
  if (!BASE64URL.test(text) || text.length % 4 === 1) {
    throw new Error('encoding: value is not canonical base64url text')
  }
  const padding = '='.repeat((4 - text.length % 4) % 4)
  const decoded = Buffer.from(text.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  if (toBase64Url(decoded) !== text) {
    throw new Error('encoding: value is not canonical base64url text')
  }
  return decoded
}

/**
 * Generate random bytes as base64url text, the form every secret in this plugin
 * is stored in.
 * @param bytes - number of random bytes.
 * @returns unpadded base64url text.
 */
export function randomText(bytes = 32): string {
  return toBase64Url(randomBytes(bytes))
}

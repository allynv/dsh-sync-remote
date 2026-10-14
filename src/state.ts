/**
 * Durable plugin state: the cookie-signing secret, the stable WebAuthn user
 * handle, the registered passkeys, and the trusted SSH host-key fingerprint.
 *
 * The file is the only thing standing between a stranger and a passkey
 * enrollment, so a corrupt or unreadable state file fails the plugin load
 * instead of starting with an empty credential list — quietly forgetting every
 * passkey would turn the next enrollment into an open registration.
 *
 * @module @allynv/dsh-sync-remote/state
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomText, fromBase64Url } from './encoding.ts'
import type { StateDocument } from './types.ts'

/** State-file layout version; a bump means an incompatible on-disk shape. */
const STATE_VERSION = 1

/** @returns a fresh, unpersisted state for a deployment that has none yet. */
export function createState(): StateDocument {
  return {
    version: STATE_VERSION,
    secret: randomText(32),
    statusToken: randomText(24),
    userID: randomText(32),
    sshHostKey: null,
    passkeys: [],
  }
}

/** @returns whether a value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @returns the message of an unknown thrown value, for a diagnostic. */
function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Accept one stored passkey record. Every field the verification path reads is
 * checked here, so a hand-edited file fails loudly rather than producing a
 * credential that can never authenticate.
 * @param value - one entry of the stored `passkeys` array.
 * @param index - its position, for the diagnostic.
 */
function assertPasskey(value: unknown, index: number): void {
  const at = `passkeys[${String(index)}]`
  if (!isRecord(value)) throw new Error(`state: ${at} is not an object`)
  for (const field of ['id', 'publicKey']) {
    if (typeof value[field] !== 'string' || value[field] === '') {
      throw new Error(`state: ${at}.${field} must be a non-empty string`)
    }
  }
  if (typeof value.counter !== 'number' || !Number.isSafeInteger(value.counter) || value.counter < 0) {
    throw new Error(`state: ${at}.counter must be a non-negative integer`)
  }
  if (value.transports !== undefined
    && (!Array.isArray(value.transports) || value.transports.some(entry => typeof entry !== 'string'))) {
    throw new Error(`state: ${at}.transports must be an array of strings`)
  }
}

/**
 * Load the state file, creating a fresh state object when it does not exist.
 * @param file - absolute path of the state file.
 * @returns the loaded state.
 * @throws when the file exists but is not a state document this version reads.
 */
export async function loadState(file: string): Promise<StateDocument> {
  return (await loadStateOrCreate(file)).state
}

/**
 * Load the state file and say whether a new document had to be invented.
 *
 * The caller needs that answer to know it must write the file: probing with
 * `access()` first leaves a window where the file disappears between the probe
 * and the read, and the freshly generated signing secret would then never reach
 * disk — every session invalidated at the next restart, silently.
 * @param file - absolute path of the state file.
 * @returns the loaded state and whether it was created here.
 * @throws when the file exists but is not a state document this version reads.
 */
export async function loadStateOrCreate(file: string): Promise<{ state: StateDocument, created: boolean }> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: createState(), created: true }
    throw new Error(`dsh-sync-remote: cannot read state file ${file}: ${reasonFor(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`dsh-sync-remote: state file ${file} is not valid JSON: ${reasonFor(error)}`)
  }
  if (!isRecord(parsed)) throw new Error(`dsh-sync-remote: state file ${file} is not an object`)
  if (parsed.version !== STATE_VERSION) {
    throw new Error(
      `dsh-sync-remote: state file ${file} has version ${JSON.stringify(parsed.version)}; this plugin writes version ${String(STATE_VERSION)}`,
    )
  }
  for (const field of ['secret', 'userID']) {
    if (typeof parsed[field] !== 'string' || parsed[field] === '') {
      throw new Error(`dsh-sync-remote: state file ${file} has no usable ${field}`)
    }
  }
  // The secret is an HMAC key, not opaque text: `signValue`/`verifyValue` decode
  // it on every request, and a hand-edited value that is not canonical base64url
  // would throw inside the request path — answering 500 to everything instead of
  // naming the broken file once, here.
  try {
    fromBase64Url(parsed.secret as string)
  } catch {
    throw new Error(`dsh-sync-remote: state file ${file} has a secret that is not canonical base64url text; restore the file from a backup or delete it to re-enroll every device`)
  }
  // `statusToken` arrived after the first releases: an older file simply has
  // none, and `StateStore.load` mints one. Anything present must still be a
  // usable bearer token.
  if (parsed.statusToken !== undefined && (typeof parsed.statusToken !== 'string' || parsed.statusToken === '')) {
    throw new Error(`dsh-sync-remote: state file ${file} has a malformed statusToken`)
  }
  if (parsed.sshHostKey !== null && typeof parsed.sshHostKey !== 'string') {
    throw new Error(`dsh-sync-remote: state file ${file} has a malformed sshHostKey`)
  }
  if (!Array.isArray(parsed.passkeys)) {
    throw new Error(`dsh-sync-remote: state file ${file} has no passkeys array`)
  }
  parsed.passkeys.forEach(assertPasskey)
  return { state: parsed as unknown as StateDocument, created: false }
}

/**
 * Own one state object and serialize its writes. Both the passkey store and the
 * tunnel's trust-on-first-use note mutate the same document, and an interleaved
 * write would drop whichever change lost the race.
 */
export class StateStore {
  /** Absolute path of the state file. */
  readonly file: string
  /** The state document; assigned by {@link StateStore.load}. */
  state!: StateDocument
  private pending: Promise<void> = Promise.resolve()

  /** @param file - absolute path of the state file. */
  constructor(file: string) {
    this.file = file
  }

  /**
   * Read the state file, creating and persisting one when this deployment has
   * none yet.
   *
   * Writing the fresh file immediately is deliberate: it fixes the cookie-
   * signing secret from the first start instead of rotating it on every restart
   * until some other change happens to write the file, and it surfaces an
   * unwritable state directory at startup rather than in the middle of a
   * passkey enrollment.
   * @returns the loaded state.
   */
  async load(): Promise<StateDocument> {
    const { state, created } = await loadStateOrCreate(this.file)
    this.state = state
    // A file written before `statusToken` existed gets one now, so the read-only
    // endpoint works after an upgrade without anyone editing the file.
    const mintedStatusToken = typeof state.statusToken !== 'string' || state.statusToken === ''
    if (mintedStatusToken) state.statusToken = randomText(24)
    if (created || mintedStatusToken) await this.persist()
    return this.state
  }

  /**
   * Persist the current state through a same-directory temporary file, so a
   * crash mid-write cannot leave a half-written credential list. Writes are
   * chained, and a failing write still releases the next one.
   * @returns a promise settling when this write finished.
   */
  persist(): Promise<void> {
    // Snapshot at call time: a queued write must persist the state as it was when
    // it was asked for, not whatever a later `await` left behind.
    const body = `${JSON.stringify(this.state, undefined, 2)}\n`
    const run = this.pending.then(async () => {
      const temporary = `${this.file}.${String(process.pid)}.${randomText(4)}.tmp`
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
      try {
        await renameWithRetry(temporary, this.file)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        const code = (error as NodeJS.ErrnoException).code ?? ''
        // Somebody held the destination for the whole retry budget — a scanner or
        // a backup agent that keeps the file open. A partial file after a crash
        // is bad; a write that never lands is worse, so rewrite in place.
        if (!RETRYABLE_RENAME.has(code)) throw error
        await writeFile(this.file, body, { encoding: 'utf8', mode: 0o600 })
      }
    })
    this.pending = run.catch(() => undefined)
    return run
  }
}

/** Errors that mean "another handle has it right now", not "this cannot work". */
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * Rename, retrying briefly while another handle holds the destination.
 *
 * Windows refuses to replace a file that is open elsewhere instead of deferring
 * the operation, so `writeFile` + `rename` fails with EPERM whenever anything is
 * reading the state file at that instant — this project's own acceptance script,
 * a backup agent, an antivirus scanner, a second `dsh`. Without a retry a passkey
 * registration could be acknowledged here and never become durable.
 * @param from - the temporary file.
 * @param to - the state file.
 * @param attempts - how many times to try before giving up.
 */
async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (attempt >= attempts || !RETRYABLE_RENAME.has(code)) throw error
      await new Promise<void>((resolve) => { setTimeout(resolve, 20 * attempt) })
    }
  }
}

/**
 * The browser script for the gateway's own pages: sign in, or enroll a device.
 *
 * Built by `tsconfig.client.json` into `lib/app.js`, which `pages.ts` reads and
 * the gateway serves at `/app.js`. It is a real TypeScript module — hence the
 * `export {}` at the end, because it uses top-level `await` and a plain script
 * may not — and it has **no imports**: WebAuthn's JSON ↔ ArrayBuffer conversion
 * is the same handful of base64url calls either way, and a script with nothing to
 * resolve cannot fail to load over a CSP of `script-src 'self'`.
 *
 * The page it drives is deliberately dumb: it says what the server told it, and
 * the token that enrolls a device is never in this file (anyone on the internet
 * can fetch it), only the path to ask for one.
 *
 * @module @allynv/dsh-sync-remote/app
 */

/** What the login page needs before it can offer its button. */
interface Bootstrap {
  origin?: string
  rpName?: string
  enrolled?: boolean
}

/** One base64url string, as JSON carries a binary field. */
type Base64Url = string

/** Extra fields cross this boundary untouched; the server owns their shape. */
type Json = Record<string, unknown>

/** `authenticatorSelection`-style passthrough the Host may set. */
interface CreationOptionsJson extends Json {
  challenge: Base64Url
  user: { id: Base64Url } & Json
  excludeCredentials?: { id: Base64Url }[] & Json[]
}

/** The allow-list form of the same idea. */
interface RequestOptionsJson extends Json {
  challenge: Base64Url
  allowCredentials?: { id: Base64Url }[] & Json[]
}

/** The four fields the Host reads back out of a registration response. */
interface RegistrationJson {
  id: string
  rawId: Base64Url
  type: string
  authenticatorAttachment?: string
  clientExtensionResults: AuthenticationExtensionsClientOutputs
  response: {
    clientDataJSON: Base64Url
    attestationObject: Base64Url
    transports: string[]
  }
}

/** The assertion form the Host verifies. */
interface AuthenticationJson {
  id: string
  rawId: Base64Url
  type: string
  authenticatorAttachment?: string
  clientExtensionResults: AuthenticationExtensionsClientOutputs
  response: {
    clientDataJSON: Base64Url
    authenticatorData: Base64Url
    signature: Base64Url
    userHandle?: Base64Url
  }
}

const status = document.getElementById('status')
const button = document.getElementById('action') as HTMLButtonElement | null
const mode = document.body.dataset.mode

/**
 * Show one line under the button.
 * @param message - what to say.
 * @param kind - omit for neutral, or colour it.
 */
function say(message: string, kind?: 'ok' | 'error'): void {
  if (status === null) return
  status.textContent = message
  if (kind === undefined) status.removeAttribute('data-kind')
  else status.dataset.kind = kind
}

/**
 * The message of an unknown thrown value, for a line a human reads.
 * @param error - whatever the browser threw.
 * @returns its message, or the value itself.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * @param error - whatever the browser threw.
 * @returns its DOMException name, when it has one.
 */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : ''
}

const base64url = {
  /**
   * @param text - base64url text, padded or not.
   * @returns the bytes it names.
   */
  toBytes(text: string): Uint8Array {
    const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)
    return bytes
  },
  /**
   * @param buffer - bytes from a WebAuthn response.
   * @returns base64url text without padding.
   */
  fromBytes(buffer: ArrayBuffer | Uint8Array): string {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  },
}

/**
 * Turn the server's JSON registration options into what `credentials.create` takes.
 * @param options - the Host's options, base64url-encoded.
 * @returns the same options with binary fields decoded.
 */
function creationOptionsFromJson(options: CreationOptionsJson): PublicKeyCredentialCreationOptions {
  // The Host owns the rest of the shape (`rp`, `pubKeyCredParams`,
  // `authenticatorSelection`, …) and it arrives as JSON this page passes through
  // untouched; only the binary fields are converted here, which is why the cast
  // has to go through `unknown`.
  return {
    ...options,
    challenge: base64url.toBytes(options.challenge),
    user: { ...options.user, id: base64url.toBytes(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map(entry => ({ ...entry, id: base64url.toBytes(entry.id) })),
  } as unknown as PublicKeyCredentialCreationOptions
}

/**
 * The same for `credentials.get`.
 * @param options - the Host's options, base64url-encoded.
 * @returns the same options with binary fields decoded.
 */
function requestOptionsFromJson(options: RequestOptionsJson): PublicKeyCredentialRequestOptions {
  // Same passthrough contract as {@link creationOptionsFromJson}: the Host owns
  // the non-binary fields, this page only decodes what JSON cannot carry.
  return {
    ...options,
    challenge: base64url.toBytes(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map(entry => ({ ...entry, id: base64url.toBytes(entry.id) })),
  } as unknown as PublicKeyCredentialRequestOptions
}

/**
 * @param credential - the credential the authenticator created.
 * @returns the JSON the Host's verifier expects.
 */
function registrationResponseToJson(credential: PublicKeyCredential): RegistrationJson {
  const response = credential.response as AuthenticatorAttestationResponse
  return {
    id: credential.id,
    rawId: base64url.fromBytes(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: base64url.fromBytes(response.clientDataJSON),
      attestationObject: base64url.fromBytes(response.attestationObject),
      transports: response.getTransports ? response.getTransports() : [],
    },
  }
}

/**
 * @param credential - the assertion the authenticator produced.
 * @returns the JSON the Host's verifier expects.
 */
function authenticationResponseToJson(credential: PublicKeyCredential): AuthenticationJson {
  const response = credential.response as AuthenticatorAssertionResponse
  return {
    id: credential.id,
    rawId: base64url.fromBytes(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: base64url.fromBytes(response.clientDataJSON),
      authenticatorData: base64url.fromBytes(response.authenticatorData),
      signature: base64url.fromBytes(response.signature),
      userHandle: response.userHandle ? base64url.fromBytes(response.userHandle) : undefined,
    },
  }
}

/**
 * POST one ceremony step and unwrap its answer.
 * @param path - the gateway path for this step.
 * @param body - the JSON body, when the step takes one.
 * @returns the parsed payload.
 */
async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${String(response.status)}`)
  return payload as T
}

let bootstrap: Bootstrap | undefined
try {
  bootstrap = await (await fetch('/bootstrap', { headers: { accept: 'application/json' } })).json() as Bootstrap
} catch {
  say('无法连接到网关。', 'error')
}

if (bootstrap && !window.isSecureContext) {
  say('当前上下文不是安全上下文，浏览器不会提供 Passkey 接口。', 'error')
}

// Nothing registered yet: say so here instead of letting the button fail with a
// server error. What this page must NOT do is name the enrollment entrance, its path,
// or where the link comes from: anyone on the internet can open this page, and the
// one-time link is a credential for taking the gateway over. The three places that
// carry it are all operator-side — the `dsh` console line, `enroll-url.txt` (0600),
// and Settings → Remote access on the machine running DSH — and the README's
// 「开始使用」 section names them. A stranger learns only that this gateway is not
// open yet, which is visible from the disabled button anyway.
const needsEnrollment = bootstrap !== undefined && bootstrap.enrolled !== true && mode !== 'enroll'
if (needsEnrollment) {
  if (button) button.disabled = true
  say('这台网关还没有注册任何设备，暂时无法登录。首次注册要在运行 DSH 的那台机器上完成（见 README 的「开始使用」）。', 'error')
}

/** Run the sign-in ceremony. */
async function signIn(): Promise<void> {
  if (needsEnrollment || button === null) return
  button.disabled = true
  say('等待设备验证…')
  try {
    const { ceremonyId, options } = await post<{ ceremonyId: string, options: RequestOptionsJson }>('/auth/options')
    const credential = await navigator.credentials.get({ publicKey: requestOptionsFromJson(options) }) as PublicKeyCredential | null
    if (credential === null) throw new Error('设备没有返回凭证。')
    const result = await post<{ redirect?: string }>('/auth/verify', { ceremonyId, response: authenticationResponseToJson(credential) })
    say('验证通过，正在进入 DSH…', 'ok')
    location.replace(result.redirect ?? '/')
  } catch (error) {
    button.disabled = false
    say(nameOf(error) === 'NotAllowedError' ? '已取消，或设备上没有可用的 Passkey。' : messageOf(error), 'error')
  }
}

/** Run the registration ceremony. */
async function enroll(): Promise<void> {
  if (button === null) return
  button.disabled = true
  say('等待设备创建…')
  try {
    const label = (document.getElementById('label') as HTMLInputElement | null)?.value ?? ''
    const { ceremonyId, options } = await post<{ ceremonyId: string, options: CreationOptionsJson }>('/enroll/options', { label })
    const credential = await navigator.credentials.create({ publicKey: creationOptionsFromJson(options) }) as PublicKeyCredential | null
    if (credential === null) throw new Error('设备没有返回凭证。')
    const result = await post<{ redirect?: string }>('/enroll/verify', { ceremonyId, response: registrationResponseToJson(credential) })
    say('注册成功，正在进入 DSH…', 'ok')
    location.replace(result.redirect ?? '/')
  } catch (error) {
    button.disabled = false
    say(nameOf(error) === 'NotAllowedError' ? '已取消，或该设备已被注册。' : messageOf(error), 'error')
  }
}

if (button) button.addEventListener('click', mode === 'enroll' ? enroll : signIn)

export {}

/**
 * Settings resolution for this bundle.
 *
 * Every value comes from the plugin row's `config` — the layer the settings
 * page writes into the profile patch. **No environment variable is read**: an
 * operator configures this plugin in one place, and a deployment cannot end up
 * with half its values in the environment and half in the patch.
 *
 * What the operator *cannot* reasonably choose is not a field at all. The bind
 * address, the state file, the WebAuthn RP ID and RP name, the local DSH
 * address, the VPS-side bind address, and the pinned SSH host key are derived or
 * fixed here, and the settings page shows them read-only. That is deliberate:
 * each one either has exactly one correct value for this design (a public
 * gateway must bind loopback; the tunnel terminus on the VPS is the loopback
 * Nginx already talks to) or is discovered at runtime (the host key).
 *
 * @module @allynv/dsh-sync-remote/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { isVolatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'

/** A configuration value the operator must fix; the message says which. */
export class ConfigError extends Error {
  /** @param message - one actionable sentence. */
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** The only address this gateway ever binds, and the only one the tunnel forwards to. */
export const LOOPBACK = '127.0.0.1'

/** Name the authenticator shows beside a new passkey. Cosmetic; not a setting. */
export const RP_NAME = 'DeepSeek Harness'

/**
 * The port a *disabled* tunnel reports.
 *
 * Not a default: the server port, client port, session lifetime, and SSH port
 * are all required in the config, because none of them can be guessed from
 * inside this process. The settings form shows suggestions as placeholders; the
 * operator's answer is what gets written. This constant exists only because a
 * disabled tunnel never dials, so its port has no meaning to resolve.
 */
const DISABLED_TUNNEL_PORT = 22

const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000
const DEFAULT_KEEPALIVE_COUNT_MAX = 3
const DEFAULT_READY_TIMEOUT_MS = 20_000
const DEFAULT_RECONNECT_MAX_DELAY_MS = 60_000
const MAX_CHANNELS = 64

/**
 * The plugin row's configuration as the settings UI reads and writes it.
 *
 * Every field is optional and `volatile`: optional so an empty row still
 * activates — the semantic rules stay in {@link resolveConfig}, where a refusal
 * is reported instead of unloading the plugin — and volatile because only
 * volatile fields appear in a settings form, and the Host restarts this plugin
 * (dispose, then `apply` again) when one changes. The marker goes on the leaves
 * only: schemastery refuses a volatile field under a volatile container, since
 * that has no fixed path to address.
 *
 * No field carries a `.default()`: a default written into the schema would
 * arrive as if the operator had chosen it, so a form could not tell a deliberate
 * value from an untouched field.
 */
export const Config = z.object({
  publicOrigin: z.string()
    .description('Public origin browsers use, for example https://dsh.example.com. Required to serve anything.')
    .volatile(),
  // Bounds deliberately live in `count()` below, not in the schema: Cordis
  // validates the raw row against this schema before `apply()` runs, and a
  // rejection there unloads the plugin row — taking the settings page that could
  // repair the value with it. `z.number()` stays so the form still renders a
  // number field; everything semantic is reported as a ConfigError instead.
  serverPort: z.number()
    .description('Server-side port (the mapped port): the VPS sshd binds 127.0.0.1:<this>, Nginx proxies to it, and this gateway listens on the same port.')
    .volatile(),
  clientPort: z.number()
    .description('Client-side port: where the local DSH Web server (dsh web) listens. Always dialed on 127.0.0.1.')
    .volatile(),
  sessionTtlHours: z.number()
    .description('How long a passkey session cookie stays valid.')
    .volatile(),
  tunnel: z.object({
    enabled: z.boolean()
      .description('Whether to open the SSH reverse tunnel. Defaults to on when host, user, and key are all set.')
      .volatile(),
    host: z.string()
      .description('VPS hostname or IP to SSH into.')
      .volatile(),
    port: z.number()
      .description('VPS SSH port — usually 22. This is not the server port above.')
      .volatile(),
    user: z.string()
      .description('SSH user on the VPS.')
      .volatile(),
    privateKeyFile: z.string()
      .description('Absolute path of the SSH private key (OpenSSH, PKCS#1, or SEC1; not PKCS#8).')
      .volatile(),
    passphrase: z.string().role('secret')
      .description('Passphrase for the private key, when it has one. Never sent back to the browser.')
      .volatile(),
  }).description('SSH reverse tunnel from the VPS to this gateway.'),
})

/** The plugin row's config as a patch file may write it. */
export type RowConfig = Record<string, unknown>

/** Where one setting's effective value came from. */
export type FieldSource = 'patch' | 'default' | 'unset'

/** One setting path to the layer that supplied it. */
export type Provenance = Record<string, FieldSource>

/** The upstream DSH Web origin the gateway proxies to. */
export interface ResolvedTarget {
  readonly host: string
  readonly port: number
}

/** The reverse tunnel's resolved settings. */
export interface ResolvedTunnelConfig {
  readonly enabled: boolean
  readonly host: string | null
  readonly port: number
  readonly user: string | null
  readonly privateKeyFile: string | null
  readonly passphrase: string | undefined
  /** VPS-side bind address; always loopback, because Nginx runs on that host. */
  readonly remoteHost: string
  /** VPS-side port; the same number the gateway binds, so Nginx has one port to name. */
  readonly remotePort: number
  readonly keepaliveIntervalMs: number
  readonly keepaliveCountMax: number
  readonly readyTimeoutMs: number
  readonly reconnectMaxDelayMs: number
  readonly maxChannels: number
}

/** One resolved deployment setting; `publicOrigin` and `target` are already normalized. */
export interface ResolvedConfig {
  readonly publicOrigin: string
  /** Derived from the public origin's hostname; WebAuthn requires the two to agree. */
  readonly rpID: string
  readonly rpName: string
  readonly bindHost: string
  /** The same bind address in a form a TCP client can dial. */
  readonly loopbackHost: string
  /**
   * Server-side port: what the VPS sshd listens on, what Nginx proxies to, and
   * what this gateway binds — one number for all three, so the reverse forward
   * is `-R <serverPort>:127.0.0.1:<serverPort>`.
   */
  readonly serverPort: number
  /** The local DSH Web server this gateway proxies to (`clientPort` on loopback). */
  readonly target: ResolvedTarget
  readonly sessionTtlHours: number
  readonly stateFile: string
  readonly secureCookies: boolean
  readonly tunnel: ResolvedTunnelConfig
}

/**
 * Where this plugin keeps its state.
 *
 * Fixed rather than configurable: the file holds the signing secret, so a wrong
 * path would silently create a fresh identity instead of reaching the existing
 * passkeys. `DSH_HOME` is not consulted either — this is the directory DSH
 * itself uses by default.
 * @returns the absolute state file path.
 */
export function defaultStateFile(): string {
  return join(homedir(), '.dsh', 'dsh-sync-remote', 'state.json')
}

/**
 * Strip the live reference wrappers a validated `volatile` field arrives as.
 * The Host hands this plugin the parsed Config, where every volatile field is a
 * `Volatile` wrapper with `get()`; the readers below want the plain values the
 * same field holds in a patch file.
 * @param value - one validated config node.
 * @returns the same shape with every wrapper replaced by its current value.
 */
function plain(value: unknown): unknown {
  if (isVolatile(value)) return plain(value.get())
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as RowConfig).map(([key, child]) => [key, plain(child)]))
  }
  return value
}

/**
 * Unwrap a validated row config into the plain shape the readers take.
 *
 * The Host validates the row against {@link Config} before calling `apply`, and
 * a validated `volatile` field arrives as a live reference rather than a value.
 * Callers that need to *inspect* the row (to decide whether anything is
 * configured, or to report where a value came from) start here.
 * @param raw - the row config as the Host parsed it.
 * @returns the same config with plain values.
 */
export function plainRow(raw: RowConfig = {}): RowConfig {
  return plain(raw) as RowConfig
}

/**
 * Read one dotted path out of the row config.
 * @param row - plain row config.
 * @param path - dotted path such as `publicOrigin` or `tunnel.host`.
 * @returns the value, or undefined.
 */
function lookup(row: RowConfig, path: string): unknown {
  let node: unknown = row
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as RowConfig)[key]
  }
  return node
}

/**
 * Record one resolved setting's source.
 * @param sources - accumulator, when the caller wants one.
 * @param path - dotted setting path.
 * @param source - layer that answered.
 */
function note(sources: Provenance | undefined, path: string, source: FieldSource): void {
  if (sources !== undefined) sources[path] = source
}

/**
 * Read one string setting: the row's own value, then the caller's default. An
 * empty string counts as unset, so clearing a field in the settings form really
 * removes the override.
 * @param row - plain row config.
 * @param path - dotted setting path.
 * @param sources - optional accumulator recording which layer answered.
 * @param fallback - value used when the row names none.
 * @returns the resolved string, or undefined when neither source supplied one.
 */
function text(row: RowConfig, path: string, sources?: Provenance, fallback?: string): string | undefined {
  const own = lookup(row, path)
  if (typeof own === 'string' && own.trim() !== '') {
    note(sources, path, 'patch')
    return own.trim()
  }
  if (own !== undefined && own !== null && typeof own !== 'string') {
    throw new ConfigError(`dsh-sync-remote: ${path} must be a string`)
  }
  note(sources, path, fallback === undefined ? 'unset' : 'default')
  return fallback
}

/**
 * Read one numeric setting from the row.
 *
 * A `fallback` of undefined makes the setting required: some numbers are
 * coordination values with no safe guess — a wrong server port looks healthy
 * here (the tunnel does bind it) while Nginx answers 502 to the world, so
 * silently defaulting it would hide a broken deployment behind a green page.
 * @param row - plain row config.
 * @param path - dotted setting path.
 * @param fallback - value used when the row names none, or undefined to require it.
 * @param bounds - inclusive limits and the field's unit for the diagnostic.
 * @param sources - optional accumulator recording which layer answered.
 * @returns the resolved number.
 */
function count(
  row: RowConfig,
  path: string,
  fallback: number | undefined,
  bounds: { min: number; max: number; unit: string },
  sources?: Provenance,
  requiredHint?: string,
): number {
  const own = lookup(row, path)
  if (own === undefined || own === null || own === '') {
    if (fallback === undefined) {
      note(sources, path, 'unset')
      throw new ConfigError(
        `dsh-sync-remote: ${path} is required — ${requiredHint ?? 'it cannot be guessed'} (set it in Settings → Remote access)`,
      )
    }
    note(sources, path, 'default')
    return fallback
  }
  note(sources, path, 'patch')
  const value = typeof own === 'number' ? own : Number(String(own).trim())
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new ConfigError(
      `dsh-sync-remote: ${path} must be a whole number of ${bounds.unit} from ${String(bounds.min)} through ${String(bounds.max)}, got ${JSON.stringify(own)}`,
    )
  }
  return value
}

/**
 * Read the boolean tunnel switch. Only the literal `true`/`false` and the usual
 * `1/0`, `yes/no`, `on/off` spellings are accepted; anything else is a typo the
 * operator must see rather than a silently enabled tunnel.
 * @param row - plain row config.
 * @param sources - optional accumulator recording which layer answered.
 * @returns the resolved boolean, or undefined when the row names none.
 */
function flag(row: RowConfig, sources?: Provenance): boolean | undefined {
  const own = lookup(row, 'tunnel.enabled')
  if (own === undefined || own === null || own === '') {
    note(sources, 'tunnel.enabled', 'unset')
    return undefined
  }
  note(sources, 'tunnel.enabled', 'patch')
  if (typeof own === 'boolean') return own
  const normalized = String(own).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  throw new ConfigError(
    `dsh-sync-remote: tunnel.enabled must be a boolean, got ${JSON.stringify(own)}`,
  )
}

/**
 * Parse the advertised public origin. The value decides the WebAuthn RP ID and
 * whether session cookies carry `Secure`, so a path, query, or credentials in
 * it are refused rather than ignored.
 * @param value - the configured origin text.
 * @returns the normalized origin, without a trailing slash.
 */
function parseOrigin(value: string): string {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`dsh-sync-remote: publicOrigin ${JSON.stringify(value)} is not an absolute URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError('dsh-sync-remote: publicOrigin must be an http(s) origin')
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigError('dsh-sync-remote: publicOrigin must not carry credentials')
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new ConfigError('dsh-sync-remote: publicOrigin must be an origin, without a path, query, or fragment')
  }
  return url.origin
}

/**
 * Resolve the row config into the settings this plugin runs on.
 * @param raw - the plugin row's config object (absent for an empty row).
 * @param sources - optional accumulator filled with each setting's source layer.
 * @returns the normalized settings.
 * @throws {ConfigError} for a missing or malformed required value.
 */
export function resolveConfig(raw: RowConfig = {}, sources?: Provenance): ResolvedConfig {
  const row = plainRow(raw)
  const publicOriginText = text(row, 'publicOrigin', sources)
  if (publicOriginText === undefined) {
    throw new ConfigError(
      'dsh-sync-remote: publicOrigin is required: set the public origin in Settings → Remote access (for example https://dsh.example.com)',
    )
  }
  const publicOrigin = parseOrigin(publicOriginText)
  // The RP ID is the origin's hostname, always: WebAuthn refuses an RP ID that
  // does not match the origin the browser is on, so a field for it could only
  // produce a configuration that cannot work.
  note(sources, 'rpID', 'default')
  const rpID = new URL(publicOrigin).hostname
  // Every value with a box in the settings form is required here: none of them
  // can be guessed from inside this process, and a wrong guess is either fatal
  // (Nginx 502 while the page looks healthy) or invisible (a session that lasts
  // ten times longer than intended). The form suggests values as placeholders;
  // the operator's answer is what gets written to the config.
  const serverPort = count(row, 'serverPort', undefined, { min: 1, max: 65535, unit: 'port numbers' }, sources,
    'it must be the port the VPS listens on AND the one Nginx proxies to, so guessing it wrong shows up as a public 502 while this page still looks healthy')
  const clientPort = count(row, 'clientPort', undefined, { min: 1, max: 65535, unit: 'port numbers' }, sources,
    'it is the port your local dsh web listens on')
  const sessionTtlHours = count(row, 'sessionTtlHours', undefined, { min: 1, max: 8760, unit: 'hours' }, sources,
    'it decides how long a signed-in session stays valid')

  const vpsHost = text(row, 'tunnel.host', sources)
  const vpsUser = text(row, 'tunnel.user', sources)
  const vpsKey = text(row, 'tunnel.privateKeyFile', sources)
  const tunnelEnabled = flag(row, sources) ?? (vpsHost !== undefined && vpsUser !== undefined && vpsKey !== undefined)
  if (sources !== undefined && sources['tunnel.enabled'] === 'unset') {
    note(sources, 'tunnel.enabled', 'default')
  }
  if (tunnelEnabled) {
    const required: [string, string | undefined][] = [
      ['tunnel.host', vpsHost],
      ['tunnel.user', vpsUser],
      ['tunnel.privateKeyFile', vpsKey],
    ]
    for (const [path, value] of required) {
      if (value === undefined) {
        throw new ConfigError(
          `dsh-sync-remote: ${path} is required — an enabled tunnel needs it (set tunnel.enabled to false to run the gateway alone)`,
        )
      }
    }
  }

  return {
    publicOrigin,
    rpID,
    rpName: RP_NAME,
    bindHost: LOOPBACK,
    loopbackHost: LOOPBACK,
    serverPort,
    target: { host: LOOPBACK, port: clientPort },
    sessionTtlHours,
    stateFile: defaultStateFile(),
    secureCookies: publicOrigin.startsWith('https:'),
    tunnel: {
      enabled: tunnelEnabled,
      host: vpsHost ?? null,
      // A disabled tunnel never dials, so its port may stay unset; once the
      // tunnel is enabled the port is required, because "22" is a guess that
      // only ever shows up as a refused connection.
      port: tunnelEnabled
        ? count(row, 'tunnel.port', undefined, { min: 1, max: 65535, unit: 'port numbers' }, sources,
          'the SSH port has no safe guess — 22 only happens to be the usual one, and a wrong value is an endless ECONNREFUSED')
        : count(row, 'tunnel.port', DISABLED_TUNNEL_PORT, { min: 1, max: 65535, unit: 'port numbers' }, sources),
      user: vpsUser ?? null,
      privateKeyFile: vpsKey ?? null,
      passphrase: text(row, 'tunnel.passphrase', sources),
      remoteHost: LOOPBACK,
      remotePort: serverPort,
      keepaliveIntervalMs: DEFAULT_KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: DEFAULT_KEEPALIVE_COUNT_MAX,
      readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
      reconnectMaxDelayMs: DEFAULT_RECONNECT_MAX_DELAY_MS,
      maxChannels: MAX_CHANNELS,
    },
  }
}

/**
 * Report which layer supplied each setting, using the same readers (and
 * therefore the same rules) the plugin itself resolves with.
 * @param raw - the plugin row's config object.
 * @returns dotted form path to source layer.
 */
export function provenance(raw: RowConfig = {}): Provenance {
  const sources: Provenance = {}
  try {
    resolveConfig(raw, sources)
  } catch {
    // A refused configuration still reports how far resolution got, so a
    // settings page can show the values that are already valid.
  }
  return sources
}

/**
 * Render the resolved settings for a log line, including the values the operator
 * cannot set.
 * @param config - resolved settings.
 * @returns a plain, loggable object.
 */
export function describeConfig(config: ResolvedConfig): Record<string, unknown> {
  return {
    publicOrigin: config.publicOrigin,
    rpID: config.rpID,
    bind: `${config.bindHost}:${String(config.serverPort)}`,
    web: `http://${config.target.host}:${String(config.target.port)}`,
    stateFile: config.stateFile,
    secureCookies: config.secureCookies,
    tunnel: {
      enabled: config.tunnel.enabled,
      remote: config.tunnel.enabled
        ? `${config.tunnel.user ?? ''}@${config.tunnel.host ?? ''}:${String(config.tunnel.port)}`
        : null,
      remoteBind: `${config.tunnel.remoteHost}:${String(config.tunnel.remotePort)}`,
      privateKeyFile: config.tunnel.privateKeyFile,
    },
  }
}

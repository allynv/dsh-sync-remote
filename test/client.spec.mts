/**
 * The client half's smoke test.
 *
 * `src/client.ts` is a classic script the browser loads as a plain `<script>`,
 * not a module, so `selfcheck.mts` never touches it: every client
 * bug so far (a tristate that wrote `false` for "auto", a banner key missing
 * from the Chinese dictionary, a page that stopped polling, field paths that
 * drift from the Host's) was invisible to the suite. This file drives the real
 * module through a minimal React stand-in: it renders the settings section,
 * clicks the real handlers, and asserts what the form would have written.
 *
 * @module @allynv/dsh-sync-remote/test/client
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { provenance } from '../src/config.ts'

let failures = 0

/** Run one named check, reporting a failure instead of aborting the file. */
async function check(name: string, body: () => Promise<void> | void): Promise<void> {
  try {
    await body()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// A React stand-in: elements, hooks, effects, and a synchronous render loop.
// ---------------------------------------------------------------------------

interface AnyElement {
  type: unknown
  props: Record<string, any>
}

type Cleanup = (() => void) | undefined

interface EffectSlot {
  deps: readonly unknown[] | undefined
  run: () => unknown
  cleanup: Cleanup
}

/** React.createElement, close enough: children live in props.children. */
function createElement(type: unknown, props: Record<string, any> | null, ...children: unknown[]): AnyElement {
  const merged: Record<string, any> = { ...(props ?? {}) }
  if (children.length === 1) merged.children = children[0]
  else if (children.length > 1) merged.children = children
  return { type, props: merged }
}

const hookState: unknown[] = []
const effectSlots: EffectSlot[] = []
const intervalCalls: { ms: number, handle: number }[] = []
const clearedIntervals: number[] = []
let hookCursor = 0
let renderCount = 0

/**
 * The stand-in is typed as the client's own `ReactApi` (declared in
 * `src/client.ts`, which is a script, so the interface is global here): if the
 * page ever calls a hook this object does not carry, the check project stops
 * compiling.
 */
const React: ReactApi = {
  createElement,
  useState<S>(initial: S | (() => S)): [S, (next: S | ((previous: S) => S)) => void] {
    const index = hookCursor
    hookCursor += 1
    if (hookState.length <= index) hookState[index] = initial
    const set = (next: S | ((previous: S) => S)): void => {
      const current = hookState[index]
      hookState[index] = typeof next === 'function' ? (next as (value: unknown) => unknown)(current) : next
      render()
    }
    return [hookState[index] as S, set]
  },
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
    const index = hookCursor
    hookCursor += 1
    const previous = effectSlots[index]
    const changed = previous === undefined || deps === undefined || previous.deps === undefined
      || deps.length !== previous.deps.length
      || deps.some((entry, at) => !Object.is(entry, (previous.deps as readonly unknown[])[at]))
    if (!changed) { pendingRuns.push(null); return }
    previous?.cleanup?.()
    effectSlots[index] = { deps, run: effect, cleanup: undefined }
    pendingRuns.push(effectSlots[index])
  },
}

let pendingRuns: (EffectSlot | null)[] = []

// The client schedules its countdown and its status poll through these globals.
let handleSeq = 1
;(globalThis as any).setInterval = (fn: () => void, ms: number): number => {
  const handle = handleSeq
  handleSeq += 1
  intervalCalls.push({ ms, handle, fn } as never)
  return handle
}
;(globalThis as any).clearInterval = (handle: number): void => { clearedIntervals.push(handle) }

// ---------------------------------------------------------------------------
// The Host services the client asks for.
// ---------------------------------------------------------------------------

interface RecordedOp { op: string, path: string[], value?: unknown }

const dictionaries: Record<string, Record<string, string>> = {}
const requestedKeys = new Set<string>()
const missingKeys = new Set<string>()
const mutations: RecordedOp[][] = []
const disposers: (() => void)[] = []

/**
 * The configuration-form snapshot, in the exact shape DSH's `ConfigFormSnapshot`
 * has: `{ status, value, base, user, revision, writable }`.
 *
 * It deliberately carries NO `mode`: an earlier version of this stub invented
 * that field, and the product's write rule was written against the invention — so
 * every input stayed disabled on every page (the loopback one included) while
 * these checks kept passing. A stub that is not the real shape cannot catch that.
 */
const snapshotBase: {
  revision: number | undefined
  writable: boolean
  status: 'loading' | 'ready' | 'unavailable'
  user: Record<string, unknown>
} = {
  revision: 1,
  writable: true,
  status: 'ready',
  user: {},
}
let snapshot = { ...snapshotBase }

const form = {
  getSnapshot: () => snapshot,
  subscribe: (callback: () => void) => { formListeners.push(callback); return () => {} },
  mutate: async (ops: RecordedOp[]) => { mutations.push(ops); return true },
  set: async () => true,
  unset: async () => true,
}
const formListeners: (() => void)[] = []

let section: (() => AnyElement) | null = null
let statusPayload: Record<string, any> = {}
/** Every path the page fetched, so an action can be proven to have called its route. */
const fetchedPaths: string[] = []

const ctx = {
  effect(factory: () => unknown, label?: string) {
    const dispose = factory()
    if (typeof dispose === 'function') disposers.push(dispose as () => void)
    void label
  },
  locale: {
    bind: (ns: string) => (key: string): string => {
      requestedKeys.add(key)
      const dictionary = dictionaries[ns] ?? {}
      if (!(key in dictionary)) missingKeys.add(key)
      return dictionary[key] ?? key
    },
    register: (ns: string, dicts: Record<string, Record<string, string>>) => {
      dictionaries[ns] = dicts.zh
      dictionaries[`${ns}#en`] = dicts.en
    },
  },
  slots: {
    inject: (_name: string, factory: () => unknown) => factory(),
    register: (_spec: unknown, component: () => AnyElement) => { section = component; return () => {} },
  },
  configForms: { get: () => form },
}

/** One synchronous render of the captured section component. */
function render(): AnyElement {
  assert.ok(section !== null, 'the client never registered a settings section')
  hookCursor = 0
  pendingRuns = []
  const tree = section()
  renderCount += 1
  for (const slot of pendingRuns) {
    if (slot === null) continue
    const result = slot.run()
    slot.cleanup = typeof result === 'function' ? (result as Cleanup) : undefined
  }
  return tree
}

/** Every element in the tree, depth first. */
function flatten(element: unknown, found: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(element)) {
    for (const child of element) flatten(child, found)
    return found
  }
  if (element === null || typeof element !== 'object') return found
  const candidate = element as AnyElement
  if (!('type' in candidate) || !('props' in candidate)) return found
  found.push(candidate)
  flatten(candidate.props.children, found)
  return found
}

/** The control whose aria-label matches one field, as the real page renders it. */
function control(tree: AnyElement, label: string): AnyElement {
  const match = flatten(tree).find((element) => element.props['aria-label'] === label && typeof element.props.onChange === 'function')
  assert.ok(match !== undefined, `no control labelled ${JSON.stringify(label)} is rendered`)
  return match as AnyElement
}

/** A button by its visible text. */
function button(tree: AnyElement, text: string): AnyElement {
  const match = flatten(tree).find((element) => element.type === 'button' && element.props.children === text)
  assert.ok(match !== undefined, `no button labelled ${JSON.stringify(text)} is rendered`)
  return match as AnyElement
}

/** Every string the tree renders, joined: for copy assertions. */
function renderedText(tree: AnyElement): string {
  return flatten(tree).map((element) => JSON.stringify(element.props.children ?? '')).join('\n')
}

/** The configuration controls the page's write rule gates (text boxes and the tristate). */
function configControls(tree: AnyElement): AnyElement[] {
  return flatten(tree).filter((element) =>
    (element.props.className === 'sr-input' || element.props.className === 'sr-select')
    && typeof element.props.onChange === 'function')
}

/** Let the client's promises settle and re-render. */
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

/**
 * Change the form snapshot the way the Host does: replace the value and notify
 * the subscribers. The component reads the snapshot into hook state once, so a
 * bare reassignment of `snapshot` would never reach it.
 */
function setSnapshot(next: typeof snapshot): void {
  snapshot = next
  for (const listener of formListeners) listener()
}

/** Tear the section down the way unmounting it does. */
function unmount(): void {
  for (const slot of effectSlots) slot?.cleanup?.()
  for (const dispose of disposers) dispose()
}

// ---------------------------------------------------------------------------
// Load the real module with the stubs already installed.
// ---------------------------------------------------------------------------

statusPayload = {
  configured: true,
  configError: null,
  // Every required box has a value, which is what a working deployment looks
  // like: the page now refuses to save while a required field is empty, so a
  // fixture missing these would (correctly) write nothing at all.
  effective: {
    publicOrigin: 'https://dsh.example.test', serverPort: 3090, clientPort: 3080, sessionTtlHours: 720,
    'tunnel.enabled': true, 'tunnel.host': '203.0.113.10', 'tunnel.port': 22, 'tunnel.user': 'root',
    'tunnel.privateKeyFile': '/home/me/.ssh/id_ed25519',
  },
  sources: {
    publicOrigin: 'patch', serverPort: 'patch', clientPort: 'patch', sessionTtlHours: 'patch',
    'tunnel.enabled': 'patch', 'tunnel.host': 'patch', 'tunnel.port': 'patch', 'tunnel.user': 'patch',
    'tunnel.privateKeyFile': 'patch',
  },
  info: {
    bind: '127.0.0.1:3090', web: 'http://127.0.0.1:3080', rpID: 'dsh.example.test', rpName: 'DeepSeek Harness',
    stateFile: '/home/me/.dsh/dsh-sync-remote/state.json', remoteBind: '127.0.0.1:3090', hostKey: null,
    secureCookies: true, passphraseSet: false, sshEquivalent: 'ssh -p 22 -N -R 3090:127.0.0.1:3090 root@203.0.113.10',
  },
  enrollment: { enrolled: true, pending: false, expiresAt: null },
  passkeys: [],
  runtime: { gateway: 'listening', tunnel: { state: 'listening', attempts: 0, channels: 0, remote: 'vps:22', hostKey: null, lastError: null }, fence: { authority: 'dsh.example.test', status: 401, ok: true } },
}

;(globalThis as any).fetch = async (path: string): Promise<any> => {
  fetchedPaths.push(String(path))
  if (String(path).includes('enroll.mint')) return { ok: true, status: 200, json: async () => ({ url: 'https://dsh.example.test/auth?token=x', qr: 'data:image/svg+xml;base64,AA', expiresAt: Date.now() + 600_000 }) }
  return { ok: true, status: 200, json: async () => statusPayload }
}
;(globalThis as any).styles = { insert: () => () => {} }
;(globalThis as any).document = undefined

/**
 * The page authority the client's write rule reads (`window.location.hostname`).
 *
 * A mutable holder, because "may this page edit?" is exactly what the checks
 * below are about: every one of them says which machine it is pretending to be
 * rather than inheriting one. The starting value is the loopback page, the only
 * page allowed to write.
 */
const pageLocation = { hostname: '127.0.0.1', host: '127.0.0.1:3080' }

const entry = await new Promise<{ id: string, factory: (require: (name: string) => unknown) => any }>((resolve) => {
  ;(globalThis as any).window = { __ModuleLoader__: { load: (value: unknown) => resolve(value as never) }, location: pageLocation }
  // src/client.ts is deliberately a classic script, not a module: DSH loads a
  // client bundle through a same-origin `<script src>` with no type="module", so
  // an export statement in it would be a browser syntax error. A dynamic import
  // is how this test executes it, and TypeScript will not treat a file with no
  // import/export as an import target — hence the directive.
  // @ts-expect-error -- src/client.ts is a script, not a module (see above)
  void import('../src/client.ts')
})

const plugin = entry.factory((name: string) => {
  if (name === 'react') return React
  throw new Error(`the client asked for an unexpected module: ${name}`)
})
assert.deepEqual(plugin.inject, ['slots', 'locale', 'configForms'])
;(plugin.apply as (ctx: unknown) => void)(ctx)

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

await check('the dictionaries carry identical key sets', () => {
  const zh = dictionaries['dsh-sync-remote'] ?? {}
  const en = dictionaries['dsh-sync-remote#en'] ?? {}
  const onlyZh = Object.keys(zh).filter((key) => !(key in en))
  const onlyEn = Object.keys(en).filter((key) => !(key in zh))
  assert.deepEqual(onlyZh, [], `keys missing from en: ${onlyZh.join(', ')}`)
  assert.deepEqual(onlyEn, [], `keys missing from zh: ${onlyEn.join(', ')}`)
})

await check('every key the page asks for exists in the active dictionary', async () => {
  render()
  await settle()
  // An unconfigured deployment renders the amber guidance banner, which is the
  // state that once asked for a key only English had. Restore the configured
  // payload afterwards: the later checks save the form, and an empty `effective`
  // legitimately blocks that now that required fields are validated.
  const saved = statusPayload
  statusPayload = { ...saved, configured: false, configError: null, effective: {}, sources: {} }
  button(render(), '刷新状态').props.onClick()
  await settle()
  assert.deepEqual([...missingKeys], [], `keys with no Chinese text: ${[...missingKeys].join(', ')}`)
  statusPayload = saved
  button(render(), '刷新状态').props.onClick()
  await settle()
})

await check('the field paths the page renders all exist on the host', () => {
  const source = readFileSync('src/client.ts', 'utf8')
  const paths = [...source.matchAll(/path:\s*'([^']+)'/gu)].map((match) => match[1])
  const hostPaths = new Set(Object.keys(provenance({
    publicOrigin: 'https://dsh.example.test', serverPort: 3090, clientPort: 3080, sessionTtlHours: 720,
    tunnel: { enabled: true, host: '203.0.113.10', port: 22, user: 'root', privateKeyFile: '/k/id_ed25519' },
  })))
  const unknown = paths.filter((path) => !hostPaths.has(path))
  assert.deepEqual(unknown, [], `fields the host does not resolve: ${unknown.join(', ')}`)
})

await check('choosing “auto” clears the tunnel switch instead of writing false', async () => {
  mutations.length = 0
  setSnapshot({ ...snapshotBase, user: { tunnel: { enabled: true } } })
  const tree = render()
  const select = control(tree, '启用隧道')
  assert.equal(select.props.value, 'true', 'the control should start from the row value')
  select.props.onChange({ target: { value: 'inherit' } })
  button(render(), '保存并应用').props.onClick()
  assert.deepEqual(mutations, [[{ op: 'unset', path: ['tunnel', 'enabled'] }]],
    `choosing auto must remove the override, not write a value: ${JSON.stringify(mutations)}`)
  // Let the write settle, or the button is still labelled "saving" for the next
  // check and nothing can be found by its text.
  await settle()
})

await check('a required field with no value blocks the save', async () => {
  // The state that leaves a deployment unconfigured: an empty box that nothing
  // ever filled in. It used to show no error at all until someone typed in it.
  const saved = statusPayload
  statusPayload = { ...saved, effective: { ...saved.effective, 'tunnel.user': '' } }
  button(render(), '刷新状态').props.onClick()
  await settle()
  const tree = render()
  const flagged = flatten(tree).filter((element) => element.props.className === 'sr-error')
  assert.ok(flagged.length > 0, 'an empty required field must be marked')
  mutations.length = 0
  button(tree, '保存并应用').props.onClick()
  assert.deepEqual(mutations, [], 'a save must write nothing while a required field is empty')
  statusPayload = saved
  button(render(), '刷新状态').props.onClick()
  await settle()
})

await check('a stored passphrase reads as set and can be cleared', async () => {
  // `role('secret')` values never ride back to the browser, so the row's own copy
  // is invisible here and the provenance layer is what knows it is set; the reset
  // control is the only way to clear one from this page.
  const saved = statusPayload
  statusPayload = {
    ...saved,
    sources: { ...saved.sources, 'tunnel.passphrase': 'patch' },
    info: { ...saved.info, passphraseSet: true },
  }
  button(render(), '刷新状态').props.onClick()
  await settle()
  const tree = render()
  const badges = flatten(tree).filter((element) => element.props.className === 'sr-badge').map((element) => element.props.children)
  assert.ok(badges.includes('来自插件配置'), `a set passphrase must not read as unset: ${JSON.stringify(badges)}`)
  assert.ok(
    flatten(tree).some((element) => element.type === 'button' && element.props.children === '恢复默认'),
    'a stored passphrase needs a control that clears it',
  )
  statusPayload = saved
  button(render(), '刷新状态').props.onClick()
  await settle()
})

await check('a loopback page can really edit the configuration', async () => {
  // The regression this check exists for: the page decided writability with
  // `snapshot.mode === 'host'`, and DSH's form snapshot has no `mode` field — so
  // the condition was false everywhere and every input, the save control, and the
  // reset control were disabled on every page, 127.0.0.1 included. Editing the
  // configuration is the entire purpose of this settings page.
  pageLocation.hostname = '127.0.0.1'
  setSnapshot({ ...snapshotBase })
  const tree = render()
  const controls = configControls(tree)
  assert.ok(controls.length > 0, 'the page must render configuration controls')
  assert.ok(
    controls.every((element) => element.props.disabled !== true),
    'every configuration control must be editable on a loopback page',
  )
  assert.equal(button(tree, '保存并应用').props.disabled, false, 'the save control must be usable on a loopback page')
  assert.equal(renderedText(tree).includes('本页只读'), false, 'a loopback page must not carry the read-only banner')
})

await check('every other page authority stays read-only, with its reason on screen', async () => {
  // The rule the loopback case above must not weaken: this page is edited on the
  // machine running DSH, never through the public address.
  for (const hostname of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]']) {
    pageLocation.hostname = hostname
    setSnapshot({ ...snapshotBase })
    const controls = configControls(render())
    assert.ok(controls.length > 0, `${hostname}: the page must render configuration controls`)
    assert.ok(
      controls.every((element) => element.props.disabled !== true),
      `${hostname} is a loopback authority and must be editable`,
    )
  }
  for (const hostname of ['127.999.1.1', '192.168.1.5', 'evil.example']) {
    pageLocation.hostname = hostname
    setSnapshot({ ...snapshotBase })
    const tree = render()
    const controls = configControls(tree)
    assert.ok(controls.length > 0, `${hostname}: the page must render configuration controls`)
    assert.ok(
      controls.every((element) => element.props.disabled === true),
      `${hostname} is not loopback and must be read-only`,
    )
    assert.ok(renderedText(tree).includes('本页只读'), `${hostname} must say why it cannot be edited`)
  }
  pageLocation.hostname = '127.0.0.1'
  setSnapshot({ ...snapshotBase })
  render()
})

await check('a configuration the client has not accepted is locked with its own reason', async () => {
  // "Greyed out" has four different causes and the page has to name the right one:
  // a read-only page authority, a Host document that refuses writes, a value still
  // in flight, and a value the Host sent that this client cannot accept.
  pageLocation.hostname = '127.0.0.1'
  setSnapshot({ revision: undefined, writable: true, status: 'loading', user: {} })
  assert.ok(renderedText(render()).includes('正在读取配置'), 'a read still in flight must say so, not blame the row')
  setSnapshot({ revision: 3, writable: true, status: 'loading', user: {} })
  assert.ok(renderedText(render()).includes('没有通过 Host 的校验'), 'an unaccepted value must name the real reason')
  setSnapshot({ revision: undefined, writable: true, status: 'unavailable', user: {} })
  assert.ok(renderedText(render()).includes('插件行当前未激活'), 'a namespace the Host does not serve keeps its own message')
  setSnapshot({ revision: 3, writable: false, status: 'ready', user: {} })
  assert.ok(renderedText(render()).includes('不接受写入'), 'a Host document that refuses writes must say that instead')
  setSnapshot({ ...snapshotBase })
  render()
  assert.deepEqual([...missingKeys], [], `keys with no Chinese text: ${[...missingKeys].join(', ')}`)
})

await check('a public page reached at an authority the plugin does not publish says so', async () => {
  // The gate asks the fence about the authority this plugin publishes; a browser
  // can only arrive at the authority it typed. Reading this page at all proves the
  // fence accepted *that* one — so when the two differ, the deployment is published
  // and trusted out of step, which is the one mismatch no server-side probe sees.
  const saved = statusPayload
  pageLocation.hostname = 'dsh.example.test'
  pageLocation.host = 'dsh.example.test'
  assert.equal(renderedText(render()).includes('插件发布的公网地址'), false, 'the published authority itself must not warn')
  pageLocation.host = 'other.example.test'
  statusPayload = { ...saved, effective: { ...saved.effective, publicOrigin: 'https://dsh.example.test' } }
  const text = renderedText(render())
  assert.ok(text.includes('插件发布的公网地址'), `a mismatched page authority must warn:\n${text}`)
  assert.ok(text.includes('other.example.test') && text.includes('dsh.example.test'), 'the warning must name both authorities')
  // The operator's own machine is the normal place to edit, never a mismatch.
  pageLocation.hostname = '127.0.0.1'
  pageLocation.host = '127.0.0.1:3080'
  assert.equal(renderedText(render()).includes('插件发布的公网地址'), false, 'the loopback editing page must stay quiet')
  statusPayload = saved
  render()
})

await check('a classified failure names the field to fix, and offers a retry', async () => {
  // ssh2's own wording ("All configured authentication methods failed") tells an
  // operator nothing about which of six configured values is wrong. The Host
  // classifies the failure; this page has to turn the class into an instruction,
  // keep the raw text as evidence, and let the operator skip the backoff.
  const saved = statusPayload
  const tunnelOf = (fields: Record<string, unknown>): Record<string, unknown> => ({
    state: 'reconnecting', attempts: 3, channels: 0, remote: 'vps:22', hostKey: null,
    everListening: false, nextRetryAt: null, suspected: null, lastError: null, ...fields,
  })

  statusPayload = {
    ...saved,
    runtime: {
      ...saved.runtime,
      tunnel: tunnelOf({ kind: 'auth', lastError: 'client-authentication: All configured authentication methods failed' }),
    },
  }
  button(render(), '刷新状态').props.onClick()
  await settle()
  const authText = renderedText(render())
  assert.ok(authText.includes('SSH 认证被拒'), `an auth failure must name the credential problem:\n${authText}`)
  assert.ok(authText.includes('All configured authentication methods failed'), 'the raw reason stays as evidence')

  // A deployment that has never once come up is a different message from one that
  // dropped: the page must stop saying "reconnecting" and point at the two fields
  // that can produce it.
  statusPayload = {
    ...saved,
    runtime: {
      ...saved.runtime,
      tunnel: tunnelOf({
        kind: 'unreachable',
        attempts: 9,
        nextRetryAt: Date.now() + 60_000,
        suspected: 'configuration',
        lastError: 'client-socket: connect ECONNREFUSED 1.2.3.4:22',
      }),
    },
  }
  button(render(), '刷新状态').props.onClick()
  await settle()
  const escalated = render()
  const escalatedText = renderedText(escalated)
  assert.ok(escalatedText.includes('VPS 地址'), `a never-working deployment must point at the address and port:\n${escalatedText}`)
  assert.ok(escalatedText.includes('一次都没成功过'), 'the escalation must say why it suspects the configuration')
  assert.ok(escalatedText.includes('下次重试'), 'the fact line must carry the countdown to the next attempt')

  fetchedPaths.length = 0
  button(escalated, '立即重试').props.onClick()
  await settle()
  assert.deepEqual(
    fetchedPaths.filter(path => path.includes('tunnel.retry')),
    ['/api/sync-remote.tunnel.retry'],
    `the retry control must call the Host route: ${JSON.stringify(fetchedPaths)}`,
  )

  statusPayload = saved
  button(render(), '刷新状态').props.onClick()
  await settle()
})

await check('the release control appears only for a refused port, and only when the row allows it', async () => {
  // The sharpest capability in the plugin gets the narrowest doorway: it is offered
  // for exactly one classified failure (the VPS refusing to bind), and only when the
  // row itself switched it on. A control the Host would refuse is worse than none.
  const saved = statusPayload
  const refused = {
    state: 'reconnecting', kind: 'forward-refused', attempts: 4, channels: 0, remote: 'vps:22', hostKey: null,
    everListening: false, nextRetryAt: null, suspected: null,
    lastError: 'the VPS refused to listen on 127.0.0.1:3090 (Unable to bind to 127.0.0.1:3090); on the VPS run `sudo ss -ltnp | grep 3090`',
  }
  const hasRelease = (tree: AnyElement): boolean =>
    flatten(tree).some(element => element.type === 'button' && element.props.children === '释放 VPS 端口')

  statusPayload = { ...saved, effective: { ...saved.effective, 'tunnel.releaseStaleForward': false }, runtime: { ...saved.runtime, tunnel: refused } }
  button(render(), '刷新状态').props.onClick()
  await settle()
  const offTree = render()
  assert.equal(hasRelease(offTree), false, 'a row that does not allow the release must not offer it')
  assert.ok(renderedText(offTree).includes('ss -ltnp'), 'the refusal still carries the command to run by hand')

  statusPayload = { ...saved, effective: { ...saved.effective, 'tunnel.releaseStaleForward': true }, runtime: { ...saved.runtime, tunnel: refused } }
  button(render(), '刷新状态').props.onClick()
  await settle()
  fetchedPaths.length = 0
  button(render(), '释放 VPS 端口').props.onClick()
  await settle()
  assert.deepEqual(
    fetchedPaths.filter(path => path.includes('tunnel.release')),
    ['/api/sync-remote.tunnel.release'],
    `the release control must call the Host route: ${JSON.stringify(fetchedPaths)}`,
  )

  // And not for any other failure: an authentication rejection is not a port conflict.
  statusPayload = { ...saved, effective: { ...saved.effective, 'tunnel.releaseStaleForward': true }, runtime: { ...saved.runtime, tunnel: { ...refused, kind: 'auth' } } }
  button(render(), '刷新状态').props.onClick()
  await settle()
  assert.equal(hasRelease(render()), false, 'only the refused remote forward may offer the release')

  statusPayload = saved
  button(render(), '刷新状态').props.onClick()
  await settle()
})

await check('a blocked tunnel explains itself in Chinese, from the facts, not the console sentence', async () => {
  // `blocked` is a deliberate refusal, not a failure: the tunnel never dialed the
  // VPS, so the banner must name the `dsh web` flag. The generic ssh2 banner would
  // send the operator looking at ports and keys — and it would be a lie, because
  // nothing was attempted.
  //
  // The Host's own sentence for this state is written for the console (English), and
  // pasting it into the banner was the only English on an otherwise Chinese page.
  // The page now derives the explanation from `fence` + `launch`, so each of the
  // three refusals reads differently and none of them is the raw text.
  const saved = statusPayload
  /** @param runtime - the runtime slice to render. */
  const withRuntime = (runtime: Record<string, unknown>): void => {
    statusPayload = { ...saved, effective: { ...saved.effective, publicOrigin: 'https://dsh.example.test' }, runtime: { ...saved.runtime, ...runtime } }
    button(render(), '刷新状态').props.onClick()
  }
  const consoleSentence = 'the DSH browser-trust fence refused Host "dsh.example.test"; start the GUI with --trusted-host …'
  const blocked = {
    state: 'blocked', kind: null, attempts: 0, channels: 0, remote: 'vps:22', hostKey: null,
    everListening: false, nextRetryAt: null, suspected: null, lastError: consoleSentence,
  }

  // (a) No flag at all: the most common mistake.
  withRuntime({ tunnel: blocked, fence: { authority: 'dsh.example.test', status: 403, ok: false }, launch: { trustedHosts: [], publicUrl: null } })
  await settle()
  let text = renderedText(render())
  assert.match(text, /隧道没有开启/)
  assert.match(text, /没有\*\*加 --trusted-host/)
  assert.equal(text.includes(consoleSentence), false, `the console sentence must not be the explanation:\n${text}`)
  assert.equal(/上面是 ssh2 报的原始原因/u.test(text), false, `a blocked tunnel must not carry the ssh2 hint:\n${text}`)

  // (b) A different host was trusted: the same refusal, a different fix.
  withRuntime({ tunnel: blocked, fence: { authority: 'dsh.example.test', status: 403, ok: false }, launch: { trustedHosts: ['other.example.test'], publicUrl: null } })
  await settle()
  text = renderedText(render())
  assert.match(text, /信任的是 other\.example\.test/)
  assert.match(text, /安全围栏: 现 Host 被拒绝：DSH 信任的是别的域名/)

  // (c) Nothing answered: the fence never decided, which is not a --trusted-host bug.
  withRuntime({ tunnel: { ...blocked, lastError: 'the local GUI did not confirm it accepts Host …' }, fence: { authority: 'dsh.example.test', status: 404, ok: true }, launch: { trustedHosts: ['dsh.example.test'], publicUrl: null } })
  await settle()
  assert.match(renderedText(render()), /最近一次答复是 HTTP 404/)

  // (d) A page reloaded ahead of the Host half: no launch facts at all. Claiming
  // "you passed no flag" here would send the operator to fix the wrong thing.
  withRuntime({ tunnel: blocked, fence: { authority: 'dsh.example.test', status: 403, ok: false }, launch: null })
  await settle()
  text = renderedText(render())
  assert.match(text, /没有 DSH 的启动参数/)
  assert.equal(/没有\*\*加 --trusted-host/u.test(text), false, `without the facts, the page must not assert the flag was missing:\n${text}`)

  statusPayload = saved
  button(render(), '刷新状态').props.onClick()
  await settle()
})

await check('the fence row names the refusal the operator actually made', async () => {
  const saved = statusPayload
  /** @param fence - the fence slice to render. @param launch - the launch facts to render. */
  const withFence = async (fence: Record<string, unknown>, launch: Record<string, unknown>): Promise<string> => {
    statusPayload = { ...saved, effective: { ...saved.effective, publicOrigin: 'https://dsh.example.test' }, runtime: { ...saved.runtime, fence, launch } }
    button(render(), '刷新状态').props.onClick()
    // The refresh is a fetch: without settling, the tree still shows the payload
    // from the previous case and every assertion below would read the same string.
    await settle()
    return renderedText(render())
  }
  assert.match(
    await withFence({ authority: 'dsh.example.test', status: 401, ok: true }, { trustedHosts: ['dsh.example.test'], publicUrl: null }),
    /安全围栏: 该 Host 被接受/,
  )
  assert.match(
    await withFence({ authority: 'dsh.example.test', status: 403, ok: false }, { trustedHosts: [], publicUrl: null }),
    /安全围栏: 现 Host 被拒绝，DSH 启动时未加 --trusted-host/,
  )
  assert.match(
    await withFence({ authority: 'dsh.example.test', status: 403, ok: false }, { trustedHosts: ['other.example.test'], publicUrl: null }),
    /安全围栏: 现 Host 被拒绝：DSH 信任的是别的域名/,
  )
  statusPayload = saved
  button(render(), '刷新状态').props.onClick()
  await settle()
})

await check('an older Host payload renders as missing, not as undefined or NaN', async () => {
  // The client bundle and the Host half reload independently: a page can be running
  // this version against a Host half that predates `kind` and `nextRetryAt`. That has
  // to read as "the field is not there", never as `(undefined)` or `下次重试 NaNs`.
  const saved = statusPayload
  statusPayload = {
    ...saved,
    runtime: {
      ...saved.runtime,
      tunnel: { state: 'reconnecting', attempts: 3, channels: 0, remote: 'vps:22', hostKey: null, lastError: 'connect ECONNREFUSED 1.2.3.4:22' },
    },
  }
  button(render(), '刷新状态').props.onClick()
  await settle()
  const text = renderedText(render())
  assert.match(text, /隧道: reconnecting/, text)
  assert.equal(/undefined/u.test(text), false, `no field may render as undefined:\n${text}`)
  assert.equal(/NaN/u.test(text), false, `no field may render as NaN:\n${text}`)
  statusPayload = saved
  button(render(), '刷新状态').props.onClick()
  await settle()
})

await check('a failure banner labels the raw reason as the raw reason', async () => {
  // The raw text stays for ssh2 failures — it is the evidence, and translating it
  // would be inventing. It is labelled so a Chinese page carrying an English line
  // reads as deliberate rather than as a half-finished translation.
  const saved = statusPayload
  statusPayload = {
    ...saved,
    runtime: {
      ...saved.runtime,
      tunnel: {
        state: 'reconnecting', kind: 'auth', attempts: 2, channels: 0, remote: 'vps:22', hostKey: null,
        everListening: false, nextRetryAt: null, suspected: null,
        lastError: 'client-authentication: All configured authentication methods failed',
      },
    },
  }
  button(render(), '刷新状态').props.onClick()
  await settle()
  const text = renderedText(render())
  assert.match(text, /原始原因（英文，插件原文）/)
  assert.match(text, /All configured authentication methods failed/)
  statusPayload = saved
  button(render(), '刷新状态').props.onClick()
  await settle()
})

await check('the page polls the status instead of freezing on the first read', () => {
  assert.ok(intervalCalls.some((call) => call.ms === 10_000),
    `no 10s status poll was registered: ${JSON.stringify(intervalCalls.map((call) => call.ms))}`)
  const poll = intervalCalls.find((call) => call.ms === 10_000)
  assert.ok(poll !== undefined)
  // Unmounting must stop it: the section is torn down on every settings switch.
  unmount()
  assert.ok(clearedIntervals.includes(poll.handle), 'the poll timer outlived the section')
})

console.log('')
if (failures > 0) {
  console.log(`${String(failures)} client check(s) failed`)
  process.exit(1)
}
console.log('client checks passed')

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

const snapshotBase = {
  revision: 1,
  writable: true,
  mode: 'host',
  status: 'active',
  user: {} as Record<string, unknown>,
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
  if (String(path).includes('enroll.mint')) return { ok: true, status: 200, json: async () => ({ url: 'https://dsh.example.test/auth?token=x', qr: 'data:image/svg+xml;base64,AA', expiresAt: Date.now() + 600_000 }) }
  return { ok: true, status: 200, json: async () => statusPayload }
}
;(globalThis as any).styles = { insert: () => () => {} }
;(globalThis as any).document = undefined

const entry = await new Promise<{ id: string, factory: (require: (name: string) => unknown) => any }>((resolve) => {
  ;(globalThis as any).window = { __ModuleLoader__: { load: (value: unknown) => resolve(value as never) } }
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

await check('a blocked tunnel explains the flag instead of showing the ssh2 hint', async () => {
  // `blocked` is a deliberate refusal, not a failure: the tunnel never dialed the
  // VPS, so the banner must name the `dsh web` flag. The generic ssh2 banner would
  // send the operator looking at ports and keys — and it would be a lie, because
  // nothing was attempted.
  const saved = statusPayload
  statusPayload = {
    ...saved,
    runtime: {
      ...saved.runtime,
      tunnel: {
        state: 'blocked', attempts: 0, channels: 0, remote: 'vps:22', hostKey: null,
        lastError: 'the DSH browser-trust fence refused Host "dsh.example.test"; start the GUI with --trusted-host "dsh.example.test" (and --public-url https://dsh.example.test/), or every request through this gateway will 403 — the reverse tunnel stays closed until then',
      },
      fence: { authority: 'dsh.example.test', status: 403, ok: false },
    },
  }
  button(render(), '刷新状态').props.onClick()
  await settle()
  const text = flatten(render()).map((element) => JSON.stringify(element.props.children ?? '')).join('\n')
  assert.match(text, /隧道没有开启/)
  assert.match(text, /--trusted-host/)
  assert.equal(/上面是 ssh2 报的原始原因/u.test(text), false, `a blocked tunnel must not carry the ssh2 hint:\n${text}`)
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

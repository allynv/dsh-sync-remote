/**
 * The gateway's own pages: a small bilingual login/enrollment document plus the
 * script that drives `navigator.credentials`.
 *
 * The script is written in `src/app.ts` and built by `tsconfig.client.json` into
 * `lib/app.js`, which is read back here as text — the one build step in this
 * bundle. The JSON ↔ ArrayBuffer conversion lives in that script rather than in a
 * bundler dependency, because then the browser has nothing to resolve.
 *
 * Both documents are served from the public origin, so they are same-origin
 * with the DSH GUI and no cross-origin policy is involved.
 *
 * @module @allynv/dsh-sync-remote/pages
 */

import { readFileSync } from 'node:fs'

/** Content-Security-Policy for the served documents. */
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

const STYLE = `
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center;
    padding: 1.25rem 0; overflow-x: hidden; overflow-wrap: anywhere;
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: #14161a; color: #e6e8ec; }
  main { width: min(30rem, 92vw); padding: 1.75rem 1.5rem; border: 1px solid #2a2e36;
    border-radius: 14px; background: #191c21; }
  h1 { margin: 0 0 .25rem; font-size: 1.2rem; }
  p { margin: .5rem 0 1.25rem; color: #9aa2b1; font-size: .9rem; }
  p + p { margin-top: -.6rem; }
  code { background: #23272e; padding: .1rem .3rem; border-radius: 4px; font-size: .85em; }
  label { display: block; font-size: .85rem; color: #9aa2b1; margin-bottom: .25rem; }
  input { width: 100%; padding: .55rem .7rem; margin-bottom: 1rem;
    border-radius: 8px; border: 1px solid #2f343d; background: #12141a; color: inherit; font: inherit; }
  button { width: 100%; padding: .7rem 1rem; border-radius: 9px; border: 1px solid #3a63d8;
    background: #2f56c8; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .55; cursor: progress; }
  button.secondary { margin-top: .6rem; background: transparent; color: #9aa2b1; border-color: #2f343d; font-weight: 500; }
  #status { margin: 1rem 0 0; min-height: 1.4rem; font-size: .85rem; color: #9aa2b1; }
  #status[data-kind="error"] { color: #ff8b8b; }
  #status[data-kind="ok"] { color: #7ee0a6; }
  @media (max-width: 380px) { main { padding: 1.25rem 1rem; } }
`

/**
 * Render one of the two documents.
 * @param mode - `login` or `enroll`; the script reads it back from the body.
 * @param origin - the advertised public origin, shown in the copy.
 * @returns the complete HTML document.
 */
export function renderPage(mode: 'login' | 'enroll', origin: string): string {
  const body = mode === 'enroll'
    ? `
      <h1>注册这台设备的 Passkey</h1>
      <p>注册后，这台设备（指纹 / 面容 / 系统 PIN / 安全密钥）将成为访问 <code>${origin}</code> 的唯一凭证。</p>
      <label for="label">给它起个名字</label>
      <input id="label" maxlength="64" autocomplete="off" placeholder="例如 MacBook、iPhone">
      <button id="action" type="button">创建 Passkey</button>`
    : `
      <h1>登录</h1>
      <p>入口只对已注册的 Passkey 开放。</p>
      <p>使用注册过的设备（指纹 / 面容 / 系统 PIN / 安全密钥）验证身份。</p>
      <button id="action" type="button">使用 Passkey 登录</button>`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>DSH 远程访问</title>
<style>${STYLE}</style>
</head>
<body data-mode="${mode}">
<main>
${body}
  <p id="status" role="status"></p>
</main>
<script type="module" src="/app.js"></script>
</body>
</html>
`
}

/**
 * The page script, read from the file `tsconfig.client.json` builds.
 *
 * The source of truth is `src/app.ts`; this module serves the built artifact
 * rather than carrying a second copy, so what the browser runs is what was
 * type-checked. A missing artifact fails here, while the plugin loads, with the
 * command that fixes it — never as a blank page in a browser.
 */
export const APP_JS: string = (() => {
  try {
    return readFileSync(new URL('../lib/app.js', import.meta.url), 'utf8')
  } catch (error) {
    throw new Error(
      'dsh-sync-remote: lib/app.js is missing; the login page script is built from src/app.ts — '
      + `run "npm run build" in the plugin directory (${error instanceof Error ? error.message : String(error)})`,
    )
  }
})()

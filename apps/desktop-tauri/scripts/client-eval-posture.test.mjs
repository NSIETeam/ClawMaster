/**
 * The packaged pages deny `eval` while their scripts must not need it.
 *
 * Two policies withhold runtime evaluation from the shipped pages. The host page
 * (`packages/host/frontend-static`) emits `script-src` without `'unsafe-eval'` and
 * `style-src` with a nonce, and hands those nonces to the page as `dsh-script-nonce`
 * and `dsh-style-nonce` meta tags; the client side of that bargain is that no browser
 * bundle evaluates source at runtime and every injected style carries the nonce. The
 * Tauri window policy in `src-tauri/tauri.conf.json` grants only `'self'` for scripts
 * and styles to the packaged chrome (`shell.html`, `splash.html`), so those scripts
 * may not need an evaluator either.
 *
 * Either half breaking produces the same user-visible symptom: the module loader never
 * leaves its queue, the root element stays empty and the window is blank with no
 * console error to explain it. This gate fails when a shipped page gains a runtime
 * evaluator or a policy grants one.
 */
import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const HOST_CSP = new URL('../../../packages/host/frontend-static/src/index.ts', import.meta.url).pathname
const TAURI_CONF = new URL('../src-tauri/tauri.conf.json', import.meta.url).pathname
const CLIENT_GLOBS = [`${REPO_ROOT}/packages/client/**/src/**/*.{ts,tsx}`, `${REPO_ROOT}/frontends/dsh/src/**/*.{ts,tsx}`]
const CHROME_PAGES = ['../shell.js', '../splash.js']

/** @param {string} path @returns {string} The source with whole-line comments removed. */
function codeOf(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
    .join('\n')
}

/**
 * @param {string} source Source text to inspect.
 * @returns {string[]} Runtime evaluators the browser would execute.
 */
function runtimeEvaluators(source) {
  const pattern = /(?:^|[^\w.$])(new Function\s*\(|eval\s*\()/gmu
  return [...source.matchAll(pattern)].map(match => match[1])
}

/**
 * @param {string} path Client source path.
 * @returns {boolean} True when the path ships in a browser bundle.
 */
function isBrowserBundleSource(path) {
  return !/(?:^|\/)tests?\//u.test(path) && !/\.(?:spec|test)\./u.test(path)
}

test('no browser bundle or packaged chrome script evaluates source at runtime', () => {
  const bundles = globSync(CLIENT_GLOBS).filter(isBrowserBundleSource)
  assert.ok(bundles.length > 200, `expected the client and product webview sources under the repository root, saw ${bundles.length}`)
  const chrome = CHROME_PAGES.map(relative => fileURLToPath(new URL(relative, import.meta.url)))
  for (const path of chrome) assert.doesNotThrow(() => readFileSync(path), path)
  const found = [...bundles, ...chrome].flatMap(path => runtimeEvaluators(codeOf(path)).map(hit => `${path}: ${hit.trim()}`))
  assert.deepEqual(found, [], `the packaged policies deny 'unsafe-eval'; these would blank the window:\n${found.join('\n')}`)
})

test('the host page denies eval and hands the client its nonces', () => {
  const source = codeOf(HOST_CSP)
  const scriptSrc = /`script-src[^`]*`/u.exec(source)?.[0]
  const styleSrc = /`style-src[^`]*`/u.exec(source)?.[0]
  assert.ok(scriptSrc, 'the host must emit a script-src directive')
  assert.ok(styleSrc, 'the host must emit a style-src directive')
  assert.doesNotMatch(scriptSrc, /'unsafe-eval'/u)
  assert.match(scriptSrc, /'nonce-\$\{scriptNonce\}'/u)
  assert.match(styleSrc, /'nonce-\$\{styleNonce\}'/u)
  assert.match(source, /meta name="dsh-script-nonce"/u)
  assert.match(source, /meta name="dsh-style-nonce"/u)
})

test('the packaged window policy withholds eval and inline execution', () => {
  const csp = JSON.parse(readFileSync(TAURI_CONF, 'utf8')).app.security.csp
  for (const directive of ['script-src', 'style-src']) {
    assert.equal(csp[directive], "'self'", directive)
  }
  for (const [directive, value] of Object.entries(csp)) {
    assert.doesNotMatch(value, /unsafe-(?:eval|inline)/u, `${directive} must not grant runtime evaluation`)
  }
})

test('a runtime evaluator or a granted eval is rejected, so the gate can fail', () => {
  assert.deepEqual(runtimeEvaluators('const f = new Function("return 1")'), ['new Function('])
  assert.deepEqual(runtimeEvaluators('const v = eval("1 + 1")'), ['eval('])
  assert.deepEqual(runtimeEvaluators('const no = evaluate(input)'), [])
  for (const granted of ["script-src 'self' 'unsafe-eval' 'nonce-${scriptNonce}'", "style-src 'self' 'unsafe-inline'"]) {
    assert.match(granted, /unsafe-(?:eval|inline)/u)
  }
})

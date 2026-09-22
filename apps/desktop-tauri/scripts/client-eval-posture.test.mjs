/**
 * The host page denies `eval` while the client must not need it.
 *
 * `packages/host/frontend-static` emits `script-src` without `'unsafe-eval'` and
 * `style-src` with a nonce, and hands the nonces to the page as `dsh-script-nonce`
 * and `dsh-style-nonce` meta tags. The client side of that bargain is that no
 * browser bundle evaluates source at runtime and every injected style carries the
 * nonce. Either half breaking produces the same user-visible symptom: the module
 * loader never leaves its queue, the root element stays empty and the window is
 * blank with no console error to explain it. This gate fails when a browser bundle
 * gains a runtime evaluator or the host page grants one.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import test from 'node:test'

const HOST_CSP = new URL('../../../packages/host/frontend-static/src/index.ts', import.meta.url).pathname
const CLIENT_GLOBS = ['packages/client/**/src/**/*.{ts,tsx}', 'frontends/dsh/src/**/*.{ts,tsx}']

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

test('no browser bundle evaluates source at runtime', () => {
  const inspected = globSync(CLIENT_GLOBS).filter(isBrowserBundleSource)
  assert.ok(inspected.length > 0, 'expected browser bundle sources to inspect')
  const found = inspected.flatMap(path => runtimeEvaluators(codeOf(path)).map(hit => `${path}: ${hit.trim()}`))
  assert.deepEqual(found, [], `the host page denies 'unsafe-eval'; these would blank the window:\n${found.join('\n')}`)
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

test('a runtime evaluator or a granted eval is rejected, so the gate can fail', () => {
  assert.deepEqual(runtimeEvaluators('const f = new Function("return 1")'), ['new Function('])
  assert.deepEqual(runtimeEvaluators('const v = eval("1 + 1")'), ['eval('])
  assert.deepEqual(runtimeEvaluators('const no = evaluate(input)'), [])
  const granted = "script-src 'self' 'unsafe-eval' 'nonce-${scriptNonce}'"
  assert.match(granted, /'unsafe-eval'/u)
})

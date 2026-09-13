/** Localized IM branding against the pinned client artifact and its upstream control. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const dependencies = createRequire(join(repository, 'apps/web/package.json'))
const typescript = createRequire(join(repository, 'package.json'))('typescript')
const core = resolve(process.env.DSH_DESKTOP_SMOKE_ROOT ?? join(repository, 'apps/desktop-tauri/bundled/harness'))
const resolver = createRequire(join(core, 'apps/cli/package.json'))
const packageRoot = process.env.DSH_IM_TEST_PACKAGE_ROOT
  ? resolve(process.env.DSH_IM_TEST_PACKAGE_ROOT)
  : dirname(resolver.resolve('@xmanrui/dsh-im/package.json'))
const patchPath = fileURLToPath(new URL('../patches/@xmanrui__dsh-im@4.20.0.patch', import.meta.url))
const provenance = JSON.parse(await readFile(fileURLToPath(new URL('../patches/dsh-im@4.20.0.provenance.json', import.meta.url)), 'utf8'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

/** Separate published string literals from the executable tokens around them. */
function literals(source, file) {
  const parsed = typescript.createSourceFile(file, source, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.JS)
  assert.deepEqual(parsed.parseDiagnostics, [], file)
  const values = []
  let cursor = 0
  let code = ''
  const visit = node => {
    if (typescript.isStringLiteral(node) || typescript.isNoSubstitutionTemplateLiteral(node)) {
      code += source.slice(cursor, node.getStart(parsed)) + '<string>'
      cursor = node.end
      values.push(node.text)
    }
    typescript.forEachChild(node, visit)
  }
  visit(parsed)
  return { values, code: code + source.slice(cursor) }
}

/** Expose the artifact's existing locale functions alongside its public settings component. */
async function clientFactory(directory) {
  const source = await readFile(join(directory, 'lib/client.js'), 'utf8')
  const end = 'return module.exports;'
  assert.equal(source.split(end).length, 2)
  let registration
  assert.match(source, /function h2\(type, props, \.\.\.children\)/u)
  vm.runInNewContext(source.replace(end, 'return { ...module.exports, en, zh, setImTranslator, localizeText, h: h2, SLACK_APP_MANIFEST_YAML };'), {
    window: { __ModuleLoader__: { load: entry => { registration = entry } } },
    console, URL, AbortController, setTimeout, clearTimeout,
  }, { filename: '@xmanrui/dsh-im/lib/client.js' })
  assert.equal(registration.id, '@xmanrui/dsh-im')
  return registration.factory(dependencies)
}

test('IM client uses localized ClawMaster copy without rewriting dynamic content', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'clawmaster-im-branding-test-'))
  t.after(() => rm(temporary, { recursive: true, force: true, maxRetries: 3 }))
  const original = join(temporary, 'original')
  const patched = join(temporary, 'patched')
  for (const destination of [original, patched]) {
    await mkdir(destination)
    await cp(join(packageRoot, 'src'), join(destination, 'src'), { recursive: true })
  }
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@xmanrui/dsh-im')
  assert.equal(manifest.version, '4.20.0')
  assert.equal(sha(await readFile(patchPath)), provenance.patchSha256)
  const installedHash = sha(await readFile(join(packageRoot, 'lib/client.js')))
  const isPatched = installedHash === provenance.patchedSha256['lib/client.js']
  assert.ok(isPatched || installedHash === provenance.upstreamSha256['lib/client.js'], 'unknown IM artifact')
  for (const file of Object.keys(provenance.patchedSha256)) {
    assert.equal(sha(await readFile(join(packageRoot, file))), (isPatched ? provenance.patchedSha256 : provenance.upstreamSha256)[file], file)
    for (const destination of [original, patched]) {
      await mkdir(dirname(join(destination, file)), { recursive: true })
      await cp(join(packageRoot, file), join(destination, file))
    }
  }
  const applied = spawnSync('git', ['apply', ...(isPatched ? ['--reverse'] : []), patchPath], {
    cwd: isPatched ? original : patched, encoding: 'utf8', timeout: 10000,
  })
  assert.equal(applied.error, undefined)
  assert.equal(applied.signal, null)
  assert.equal(applied.status, 0, applied.stderr)
  for (const file of Object.keys(provenance.patchedSha256)) {
    assert.equal(sha(await readFile(join(original, file))), provenance.upstreamSha256[file], `original ${file}`)
    assert.equal(sha(await readFile(join(patched, file))), provenance.patchedSha256[file], `patched ${file}`)
  }
  const React = dependencies('react')
  const { renderToStaticMarkup } = dependencies('react-dom/server')
  const before = await clientFactory(original)
  const after = await clientFactory(patched)
  const language = (client, locale) => client.setImTranslator(key => client[locale][key] ?? key)
  const header = client => renderToStaticMarkup(React.createElement(client.IMSettingsTab, {}))

  await t.test('upstream Chinese and English headers expose the reported brand', () => {
    for (const locale of ['zh', 'en']) {
      language(before, locale)
      assert.match(header(before), /DeepSeek Harness/u)
    }
  })

  await t.test('both client languages render the product slogan with the original plugin version', () => {
    for (const [locale, slogan] of [['zh', '开启AI时代的企业协作'], ['en', 'Enterprise collaboration for the AI era']]) {
      language(after, locale)
      const markup = header(after)
      assert.ok(markup.includes(slogan), locale)
      assert.doesNotMatch(markup, /DeepSeek Harness/u)
      assert.match(markup, /v4\.20\.0/u)
    }
  })

  await t.test('QR accessibility text and removal confirmations keep supplied names intact', () => {
    const alt = '用于把微信机器人绑定到 ClawMaster 的一次性二维码'
    const supplied = 'Customer DeepSeek Harness'
    for (const locale of ['zh', 'en']) {
      language(after, locale)
      const markup = renderToStaticMarkup(after.h('img', { alt }))
      assert.ok(markup.includes('ClawMaster'))
      assert.doesNotMatch(markup, /DeepSeek Harness/u)
      assert.equal(after.localizeText(supplied), supplied)
      const confirmation = after.localizeText(`从 ClawMaster 移除“${supplied}”？`)
      assert.ok(confirmation.includes(supplied))
      assert.ok(confirmation.includes('ClawMaster'))
      if (locale === 'en') assert.match(confirmation, /^Remove /u)
    }
  })

  await t.test('standalone product names are localized while Host diagnostic keys and supplied names stay intact', async () => {
    const expected = JSON.parse(await readFile(new URL('./expected/im-client-branding.json', import.meta.url), 'utf8'))
    const actual = {}
    for (const locale of ['zh', 'en']) {
      language(after, locale)
      const entries = Object.entries(before[locale]).filter(([key, value]) =>
        (/\bHarness\b/u.test(key) || /\bHarness\b/u.test(value)) && !/DeepSeek Harness/u.test(key + value))
      assert.equal(entries.length, provenance.build.clientBrandedLocaleCount)
      actual[locale] = Object.fromEntries(entries.map(([key]) => [key, after.localizeText(key)]))
      for (const value of Object.values(after[locale])) assert.doesNotMatch(value, /\bHarness\b/u)
      for (const supplied of ['Customer Harness', 'Customer Harness Host', 'https://example.test/Harness']) {
        assert.equal(after.localizeText(supplied), supplied)
      }
      const heading = renderToStaticMarkup(after.h('h3', {}, '扫一次码，就能在微信里使用 Harness'))
      assert.match(heading, /ClawMaster/u)
      assert.doesNotMatch(heading, /\bHarness\b/u)
      assert.ok(after.localizeText('Harness 的 Host 信任检查拒绝了非回环地址请求。请检查 harnessBaseUrl 与 trustedHosts 配置。').includes('harnessBaseUrl'))
    }
    assert.deepEqual(actual, expected)
  })

  await t.test('all edited locale copy, sources and client artifact omit the old full brand', async () => {
    for (const locale of ['zh', 'en']) {
      for (const [key, value] of Object.entries(after[locale])) {
        assert.doesNotMatch(key, /DeepSeek Harness/u)
        assert.doesNotMatch(value, /DeepSeek Harness/u)
      }
    }
    for (const file of Object.keys(provenance.patchedSha256)) {
      assert.doesNotMatch(await readFile(join(patched, file), 'utf8'), /DeepSeek Harness/u, file)
    }
  })

  await t.test('Slack manifest branding preserves permissions and event subscriptions', () => {
    const yaml = createRequire(join(repository, 'package.json'))('yaml')
    const upstream = yaml.parse(before.SLACK_APP_MANIFEST_YAML)
    const desktop = yaml.parse(after.SLACK_APP_MANIFEST_YAML)
    assert.equal(desktop.display_information.name, 'ClawMaster')
    assert.equal(desktop.features.bot_user.display_name, 'ClawMaster')
    assert.match(desktop.display_information.description, /ClawMaster/u)
    for (const value of [upstream, desktop]) {
      delete value.display_information.name
      delete value.display_information.description
      delete value.features.bot_user.display_name
    }
    assert.deepEqual(desktop, upstream)
  })

  await t.test('Host messages retain supplied content, approval decisions and localized instructions', async () => {
    const host = async root => {
      const module = name => import(pathToFileURL(join(root, 'src/channels/shared', `${name}.mjs`)).href)
      const [locale, connection, approval, question] = await Promise.all([
        module('i18n'), module('connection-test'), module('harness-approval'), module('harness-question'),
      ])
      return { ...locale, ...connection, ...approval, ...question }
    }
    const upstream = await host(original)
    const desktop = await host(patched)
    const supplied = 'Customer DeepSeek Harness'
    for (const locale of ['zh', 'en']) {
      upstream.setImHostLanguage(locale)
      desktop.setImHostLanguage(locale)
      assert.match(upstream.connectionTestMessage('Example'), /DeepSeek Harness/u)
      const connection = desktop.connectionTestMessage(supplied)
      assert.match(connection.split('\n')[0], /ClawMaster/u)
      assert.ok(connection.includes(supplied))
      const prompt = { id: 'example', question: supplied }
      const question = desktop.harnessQuestionText(prompt, 0, 1)
      assert.match(question.split('\n')[0], /ClawMaster/u)
      assert.ok(question.includes(supplied))
      const payload = { type: 'approval/requested', sessionId: 'test', approvalId: 'approve',
        callId: 'call', toolName: 'read_file', reason: supplied }
      const options = { toolCall: { callId: 'call', name: 'read_file', arguments: { path: supplied } } }
      const approval = desktop.harnessApprovalText(payload, options)
      assert.match(approval.split('\n')[0], /ClawMaster/u)
      assert.ok(approval.includes(supplied))
      for (const reply of ['批准', '拒绝', 'yes', 'no', 'unrecognized']) {
        assert.equal(desktop.harnessApprovalDecision(reply), upstream.harnessApprovalDecision(reply))
      }
      assert.deepEqual(desktop.harnessAnswerForQuestion(prompt, supplied), upstream.harnessAnswerForQuestion(prompt, supplied))
      if (locale === 'en') {
        assert.match(connection, /^✅ ClawMaster connection test succeeded/u)
        assert.match(approval, /^ClawMaster needs your approval:/u)
        assert.match(question, /^ClawMaster needs more information:/u)
      }
    }
  })

  await t.test('published Host changes only source-owned branded string literals', async () => {
    const before = literals(await readFile(join(original, 'lib/index.js'), 'utf8'), 'upstream Host')
    const after = literals(await readFile(join(patched, 'lib/index.js'), 'utf8'), 'desktop Host')
    assert.equal(after.code, before.code, 'non-string executable tokens remain identical')
    assert.equal(after.values.length, before.values.length)
    const owned = new Set([JSON.parse(await readFile(join(patched, 'package.json'), 'utf8')).description])
    for (const file of Object.keys(provenance.patchedSha256).filter(file => /^(?:src|plugin-src)\/.+\.m?js$/u.test(file))) {
      for (const value of literals(await readFile(join(patched, file), 'utf8'), file).values) owned.add(value)
    }
    let changes = 0
    for (const [index, value] of before.values.entries()) {
      if (after.values[index] === value) continue
      changes += 1
      assert.match(value, /DeepSeek Harness/u)
      assert.ok(owned.has(after.values[index]), value)
    }
    assert.equal(changes, provenance.build.hostBrandedLiteralCount)
    assert.ok(changes > 0)
    assert.ok(after.values.includes('DeepSeekHarness/1.1.0'), 'WeChat wire agent identity is preserved')
    assert.ok(after.values.includes('deepseek-harness'), 'QR service source identity is preserved')
  })

  await t.test('package identity and licenses stay byte-identical', async () => {
    const upstream = JSON.parse(await readFile(join(original, 'package.json'), 'utf8'))
    const desktop = JSON.parse(await readFile(join(patched, 'package.json'), 'utf8'))
    delete upstream.description
    delete desktop.description
    assert.deepEqual(desktop, upstream)
    for (const [file, hash] of Object.entries(provenance.unchangedSha256)) {
      assert.equal(sha(await readFile(join(packageRoot, file))), hash, file)
    }
    const targets = [...(await readFile(patchPath, 'utf8')).matchAll(/^\+\+\+ b\/(.+)$/gmu)].map(match => match[1])
    assert.deepEqual(targets.sort(), Object.keys(provenance.patchedSha256).sort())
    assert.equal(after.IM_PLUGIN_VERSION, before.IM_PLUGIN_VERSION)
  })
})

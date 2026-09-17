/** Real Chromium enforcement against the Host CSP and authorized dynamic source. */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { serveStatic } from '../../../packages/host/frontend-static/src/index.ts'
import { AGENT_A, AGENT_B, setup } from '../../../packages/extensions/cordis-host-runner/tests/helpers.ts'
import type { ApprovalRequestId } from '../../../packages/extensions/cordis-host-runner/src/types.ts'

it('runs only authorized source while CSP rejects injected scripts and eval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cordis-csp-'))
  const { ctx, runner, gateway } = await setup()
  let browser: Browser | undefined
  let server: Server | undefined
  try {
    const fixture = fileURLToPath(new URL('./dynamic-cordis-csp.fixture.ts', import.meta.url))
    await build({
      configFile: false,
      root: fileURLToPath(new URL('..', import.meta.url)),
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: root, emptyOutDir: false, minify: false,
        lib: { entry: fixture, formats: ['es'], fileName: () => 'probe.js' },
      },
    })
    const { pluginId, packageId } = runner.define({
      sessionId: AGENT_A.id,
      plugin: { kind: 'new', idPrefix: 'csp' },
      name: 'CSP browser fixture', purpose: 'exercise approved browser execution',
      code: { client: 'return () => { document.body.dataset.approved = "ran"; document.body.dataset.literal = "</script><script>document.body.dataset.injected = true</script>"; styles.insert("#run { color: rgb(255, 0, 0) }"); }' },
    })
    const pending = await runner.run(AGENT_A, pluginId, packageId, 'run')
    expect(pending).toMatchObject({ ok: true, status: 'awaiting-approval' })
    if (!pending.ok) throw new Error(pending.message)
    const html = '<!doctype html><html><head></head><body><button id="run">Run approved source</button><button id="attack">Probe blocked scripts</button><script type="module" src="/probe.js"></script></body></html>'
    server = createServer((request, response) => {
      if (request.url === '/source') {
        try {
          const source = runner.getClientCode(AGENT_A, pluginId, pending.pluginRunId)
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(source))
        } catch {
          // The fixture exposes the real Host's refusal without leaking source.
          response.writeHead(403)
          response.end('source not authorized')
        }
        return
      }
      void serveStatic(request.url ?? '/', response, root, join(root, 'index.html'), () => true,
        () => Promise.resolve(html)).catch((error: unknown) => { response.destroy(error as Error) })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing fixture port')
    browser = await chromium.launch()
    const page = await browser.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    const index = await page.goto(`http://127.0.0.1:${String(address.port)}`)
    expect(index?.headers()['content-security-policy']).not.toContain("'unsafe-eval'")
    await expect.poll(async () => ({ ready: await page.getAttribute('body', 'data-ready'), pageErrors }),
      { timeout: 10_000 }).toEqual({ ready: 'true', pageErrors: [] })
    await page.click('#run')
    await page.waitForFunction(() => document.body.dataset.result === 'refused')
    expect(await page.getAttribute('body', 'data-approved')).toBeNull()

    const asked = gateway.events.find(([name]) => name === 'cordis/request-run')?.[1] as { requestId: ApprovalRequestId }
    const started = await runner.runHostHalf(AGENT_A, pluginId, packageId, 'run', asked.requestId, false)
    expect(started.ok).toBe(true)
    expect(() => runner.getClientCode(AGENT_B, pluginId, pending.pluginRunId)).toThrow('no dynamic plugin')
    await page.click('#run')
    await page.waitForFunction(() => document.body.dataset.result === 'loaded')
    expect(await page.getAttribute('body', 'data-approved')).toBe('ran')
    expect(await page.locator('#run').evaluate(element => getComputedStyle(element).color)).toBe('rgb(255, 0, 0)')
    expect(await page.getAttribute('body', 'data-literal')).toContain('</script><script>')
    expect(await page.locator('script:not([src])').count()).toBe(0)

    await page.click('#attack')
    await page.waitForFunction(() => Number(document.body.dataset.violationCount ?? '0') >= 5)
    expect(await page.getAttribute('body', 'data-injected')).toBeNull()
    expect(await page.getAttribute('body', 'data-eval-error')).toBe('EvalError')
    expect(await page.getAttribute('body', 'data-violations')).toContain('script-src-attr')

    await runner.stop(AGENT_A, pluginId)
    await page.click('#run')
    await page.waitForFunction(() => document.body.dataset.result === 'refused')
  } finally {
    try {
      await browser?.close()
    } finally {
      try {
        if (server !== undefined) await new Promise<void>((resolve, reject) => {
          server!.close((error) => {
            if (error === undefined) resolve()
            else reject(error)
          })
          server!.closeAllConnections()
        })
      } finally {
        try {
          await ctx.fiber.dispose()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
    }
  }
})

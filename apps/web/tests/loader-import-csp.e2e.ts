/** The browser can import the config loader under the production Host CSP. */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { serveStatic } from '../../../packages/host/frontend-static/src/index.ts'

it('imports the browser config loader without evaluating dynamic config at startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loader-csp-'))
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let server: Server | undefined
  try {
    const fixture = fileURLToPath(new URL('./loader-import-csp.fixture.ts', import.meta.url))
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
    const html = '<!doctype html><html><head></head><body><script type="module" src="/probe.js"></script></body></html>'
    server = createServer((request, response) => {
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
    const response = await page.goto(`http://127.0.0.1:${String(address.port)}`)
    expect(response?.headers()['content-security-policy']).not.toContain("'unsafe-eval'")
    await expect.poll(async () => ({ loaded: await page.getAttribute('body', 'data-loader-loaded'), pageErrors }))
      .toEqual({ loaded: 'true', pageErrors: [] })
  } finally {
    try {
      await browser?.close()
    } finally {
      try {
        if (server !== undefined) await new Promise<void>((resolve, reject) => {
          server!.close(error => error === undefined ? resolve() : reject(error))
          server!.closeAllConnections()
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})

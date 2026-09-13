/** Real local editors edit, save, reopen and reject conflicts through the production binary upload implementation. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { unzipSync, strFromU8 } from 'fflate';
import { chromium } from 'playwright';
import { apply } from '../dist/index.js';

for (const withoutIdleCallback of [false, true]) {
test(`Word, Excel and PowerPoint edits survive save, reopen and conflicts (${withoutIdleCallback ? 'without idle callbacks' : 'native scheduling'})`, { timeout: 180000 }, async t => {
  assert.ok(process.env.DSH_OFFICE_SIDEBAR_PACKAGE_ROOT, 'Set DSH_OFFICE_SIDEBAR_PACKAGE_ROOT to the patched sidebar package.');
  const { writeWorkspaceUpload } = await import(pathToFileURL(join(resolve(process.env.DSH_OFFICE_SIDEBAR_PACKAGE_ROOT), 'src/fs-operations.ts')).href);
  const temporary = await mkdtemp(join(tmpdir(), 'clawmaster-office-browser-'));
  let browser; let server; let dispose;
  t.after(async () => {
    await browser?.close();
    await dispose?.();
    if (server?.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await rm(temporary, { recursive: true, force: true });
  });
  const parent = await build({ entryPoints: [new URL('./browser-parent.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'browser', write: false });
  let route;
  await apply({ effect: async setup => { dispose = await setup(); }, connection: { requestRejection: () => undefined }, webServer: { register: value => { route = value; return () => { route = undefined; }; } } });
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/clawmaster/office/runtime')) return await route.handler(request, response);
      if (url.pathname === '/sidebar/file') {
        const path = url.searchParams.get('path'); assert.equal(join(temporary, basename(path)), path);
        response.end(await readFile(path)); return;
      }
      if (url.pathname === '/sidebar/upload') {
        assert.equal(url.searchParams.get('dir'), temporary);
        assert.match(request.headers['if-match'], /^"sha256-[a-f0-9]{64}"$/);
        const value = await writeWorkspaceUpload({ cwd: temporary, dir: temporary, relativePath: url.searchParams.get('relativePath'), chunks: request, limit: 100 * 1024 * 1024, expectedRevision: request.headers['if-match'].slice(1, -1) });
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, value })); return;
      }
      if (url.pathname === '/parent.js') { response.setHeader('content-type', 'text/javascript'); response.end(parent.outputFiles[0].contents); return; }
      response.setHeader('content-type', 'text/html'); response.end('<!doctype html><style>html,body{margin:0;width:100%;height:100%}iframe{width:100%;height:96%;border:0}output{font:12px monospace}</style><output></output><iframe></iframe><script type="module" src="/parent.js"></script>');
    } catch (error) {
      if (!response.headersSent) response.writeHead(error.status ?? 500);
      response.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ headless: true, executablePath: process.env.OFFICE_TEST_CHROMIUM });
  const results = [];
  for (const [file, token] of [['document.docx', 'WORD_EDITED_20260913'], ['workbook.xlsx', 'EXCEL_EDITED_20260913'], ['presentation.pptx', 'PPT_EDITED_20260913']]) {
    const original = await readFile(new URL(`./fixtures/${file}`, import.meta.url));
    const path = join(temporary, file); await writeFile(path, original);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    if (withoutIdleCallback) await page.addInitScript(() => { delete window.requestIdleCallback; delete window.cancelIdleCallback; });
    try {
      const state = status => page.waitForFunction(value => document.querySelector('output').textContent.includes(`"status":"${value}"`), status, { timeout: 60000 });
      await page.goto(`http://127.0.0.1:${server.address().port}/?${new URLSearchParams({ path })}`);
      await state('ready');
      const edit = async () => {
        if (file.endsWith('.xlsx')) { await page.mouse.click(92, 242); await page.keyboard.type(token); await page.keyboard.press('Enter'); }
        else if (file.endsWith('.pptx')) { await page.mouse.dblclick(670, 465); await page.keyboard.press('Home'); await page.keyboard.type(`${token} `); }
        else { await page.mouse.click(425, 307); await page.keyboard.press('Home'); await page.keyboard.type(`${token} `); }
        await page.waitForFunction(() => document.querySelector('output').textContent.includes('"dirty":true'));
      };
      await edit(); await page.mouse.click(19, 32); await state('saved');
      const saved = await readFile(path);
      const zip = unzipSync(saved);
      const xml = Object.entries(zip).filter(([name]) => name.endsWith('.xml')).map(([, bytes]) => strFromU8(bytes)).join('\n');
      assert.ok(xml.includes(token), `${file} must contain the edit on disk`);
      if (file.endsWith('.xlsx')) assert.match(strFromU8(zip['xl/worksheets/sheet1.xml']), /<f[^>]*>C2\*D2<\/f><v>96<\/v>/);
      else if (file.endsWith('.docx')) { assert.ok(xml.includes('WORD_ORIGINAL_20260913')); assert.ok(xml.includes('<w:tbl>')); }
      else assert.ok(xml.includes('POWERPOINT_ORIGINAL_20260913'));
      await page.reload(); await state('ready');
      if (process.env.OFFICE_TEST_EVIDENCE) await page.screenshot({ path: join(process.env.OFFICE_TEST_EVIDENCE, `${file}${withoutIdleCallback ? '-without-idle-callback' : ''}.png`) });
      await edit(); await writeFile(path, original); await page.mouse.click(19, 32); await state('conflict');
      assert.deepEqual(await readFile(path), original);
      assert.match(await page.locator('output').innerText(), /"dirty":true.*"recovery":true/);
      results.push({ file, saved: true, reopened: true, conflictPreservesDisk: true });
    } finally { await page.close(); }
  }
  assert.deepEqual(results, JSON.parse(await readFile(new URL('./expected/browser.json', import.meta.url))));
});
}

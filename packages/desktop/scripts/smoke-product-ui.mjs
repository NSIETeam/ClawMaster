#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const previewRoot = path.join(desktopRoot, 'dist-preview');

execFileSync(process.execPath, [path.join(desktopRoot, 'build-preview.cjs')], {
  cwd: path.resolve(desktopRoot, '../..'),
  stdio: 'inherit',
});

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
]);

const server = createServer((request, response) => {
  const requested = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const candidate = path.resolve(previewRoot, relative);
  if (!candidate.startsWith(`${previewRoot}${path.sep}`) || !existsSync(candidate)) {
    response.writeHead(404).end('not found');
    return;
  }
  response.setHeader('Content-Type', contentTypes.get(path.extname(candidate)) ?? 'application/octet-stream');
  createReadStream(candidate).pipe(response);
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('preview server did not bind a TCP port');
const previewUrl = `http://127.0.0.1:${address.port}`;

function channelAverage(color) {
  const channels = color.match(/\d+(?:\.\d+)?/gu)?.slice(0, 3).map(Number) ?? [];
  return channels.length === 3 ? channels.reduce((sum, value) => sum + value, 0) / 3 : 255;
}

const systemBrowsers = process.platform === 'darwin'
  ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  : process.platform === 'win32'
    ? [
        `${process.env.PROGRAMFILES ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env['PROGRAMFILES(X86)'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/microsoft-edge', '/usr/bin/chromium'];
const managedBrowser = chromium.executablePath();
const executablePath = systemBrowsers.find(existsSync)
  ?? (managedBrowser && existsSync(managedBrowser) ? managedBrowser : undefined);
assert.ok(executablePath, 'product UI smoke needs Chrome, Edge, Chromium, or a managed Playwright browser');

const browser = await chromium.launch({ headless: true, executablePath });
try {
  for (const scenario of [
    { name: 'wide-light', width: 1440, height: 900, colorScheme: 'light' },
    { name: 'short-dark', width: 900, height: 560, colorScheme: 'dark' },
  ]) {
    const page = await browser.newPage({
      viewport: { width: scenario.width, height: scenario.height },
      colorScheme: scenario.colorScheme,
    });
    const failedResources = [];
    page.on('requestfailed', (request) => {
      failedResources.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'failed'}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        failedResources.push(`${response.status()} ${response.url()}`);
      }
    });
    page.setDefaultTimeout(10_000);
    await page.goto(previewUrl, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '选择工作式 UI' }).click();
    await page.getByRole('button', { name: '稍后了解' }).click();

    assert.equal(await page.getByRole('img', { name: 'ClawMaster 皇冠标志' }).count() > 0, true);
    assert.equal(await page.getByText(/^otto$/iu).count(), 0, 'legacy ClawMaster wordmark became visible');

    // A normal pointer click is intentional: it catches overlapping groups and
    // pointer interception that force-click or DOM dispatch would conceal.
    await page.getByRole('button', { name: '向园区服务添加模块' }).click();
    await page.getByRole('button', { name: /社区插件/u }).click();
    assert.equal(await page.locator('.claw-community-skill-card').count(), 41);
    assert.equal(await page.getByRole('img', { name: /插件$/u }).count(), 41);
    await page.waitForFunction(() => [...document.querySelectorAll('img[src]')]
      .every((image) => image.complete));
    const brokenImages = await page.locator('img[src]').evaluateAll((images) => images
      .filter((image) => image.naturalWidth === 0)
      .map((image) => image.getAttribute('src')));
    assert.deepEqual(brokenImages, [], 'renderer contains broken image resources');
    assert.deepEqual(failedResources, [], 'renderer requested missing or failed resources');

    const geometry = await page.evaluate(() => {
      const body = document.querySelector('.claw-module-marketplace__body');
      const catalog = document.querySelector('.claw-module-marketplace__catalog');
      const tabs = document.querySelector('.claw-module-marketplace__tabs');
      const srOnly = document.querySelector('.claw-module-marketplace .sr-only');
      const buttons = [...document.querySelectorAll(
        '.claw-module-marketplace__tabs button, .claw-module-marketplace__filters button',
      )];
      if (!body || !catalog || !tabs || !srOnly) throw new Error('marketplace layout is incomplete');
      const topBefore = tabs.getBoundingClientRect().top;
      catalog.scrollTop = Math.min(600, catalog.scrollHeight);
      const topAfter = tabs.getBoundingClientRect().top;
      return {
        bodyClientHeight: body.clientHeight,
        bodyScrollHeight: body.scrollHeight,
        catalogClientHeight: catalog.clientHeight,
        catalogScrollHeight: catalog.scrollHeight,
        controlsStayFixed: Math.abs(topAfter - topBefore) < 0.5,
        srOnlyPosition: getComputedStyle(srOnly).position,
        srOnlyWidth: getComputedStyle(srOnly).width,
        controlsFit: buttons.every((button) => button.scrollHeight <= button.clientHeight),
        rightPanelBackground: getComputedStyle(document.querySelector('.claw-right-panel')).backgroundColor,
        dialogBackground: getComputedStyle(document.querySelector('.claw-module-marketplace')).backgroundColor,
      };
    });
    assert.equal(geometry.bodyScrollHeight, geometry.bodyClientHeight);
    assert.equal(geometry.catalogScrollHeight > geometry.catalogClientHeight, true);
    assert.equal(geometry.controlsStayFixed, true);
    assert.equal(geometry.controlsFit, true);
    assert.equal(geometry.srOnlyPosition, 'absolute');
    assert.equal(geometry.srOnlyWidth, '1px');
    if (scenario.colorScheme === 'dark') {
      assert.equal(channelAverage(geometry.rightPanelBackground) < 90, true);
      assert.equal(channelAverage(geometry.dialogBackground) < 90, true);
    }

    await page.getByRole('button', { name: '关闭添加模块' }).click();
    await page.getByRole('button', { name: '功能组菜单：园区服务' }).click();
    const menuBounds = await page.getByRole('menu', { name: '园区服务设置' }).boundingBox();
    assert.ok(menuBounds, 'group menu is not visible');
    assert.equal(menuBounds.x >= 0 && menuBounds.y >= 0, true);
    assert.equal(menuBounds.x + menuBounds.width <= scenario.width, true);
    assert.equal(menuBounds.y + menuBounds.height <= scenario.height, true);

    await page.close();
    console.log(`[product-ui] ${scenario.name} passed`);
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log('[product-ui] crown, right rail, marketplace, short viewport and dark theme passed');

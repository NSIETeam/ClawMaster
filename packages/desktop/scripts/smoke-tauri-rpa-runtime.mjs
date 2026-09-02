#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readVerifiedBinaryCapsule } from './binary-capsule.mjs';
import { materializeDirectoryCapsule } from './directory-capsule.mjs';
import { resolveTauriRuntimePlatform } from './tauri-runtime-policy.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const useStaging = process.argv[2] === '--staging';
const appRoot = path.resolve(!useStaging && process.argv[2] ? process.argv[2] : path.join(
  desktopRoot,
  'src-tauri',
  'target',
  'release',
  'bundle',
  'macos',
  'ClawMaster.app',
));
const runtimeRoot = useStaging
  ? path.join(desktopRoot, 'src-tauri', 'target', 'sidecar-staging', 'runtime')
  : path.join(appRoot, 'Contents', 'Resources', 'runtime');
const runtimePlatform = resolveTauriRuntimePlatform(process.platform, process.arch);
const nodeCapsuleRoot = path.join(runtimeRoot, 'node');
const nodeCapsule = path.join(nodeCapsuleRoot, 'node.br');
const nodeManifest = path.join(nodeCapsuleRoot, 'node-manifest.json');
const agentCapsule = path.join(runtimeRoot, 'agent', 'agent.br');
const agentManifest = path.join(runtimeRoot, 'agent', 'agent-manifest.json');

for (const required of [nodeCapsule, nodeManifest, agentCapsule, agentManifest]) {
  if (!existsSync(required)) {
    throw new Error(`packaged RPA runtime input is missing: ${required}`);
  }
}

const { bytes: nodeBytes } = readVerifiedBinaryCapsule({
  capsulePath: nodeCapsule,
  manifestPath: nodeManifest,
  target: runtimePlatform.target,
  minimumBytes: 1_000_000,
});
const probeRoot = mkdtempSync(path.join(tmpdir(), 'clawmaster-rpa-node-'));
const nodeBinary = path.join(probeRoot, process.platform === 'win32' ? 'node.exe' : 'node');
const agentRoot = materializeDirectoryCapsule({
  capsulePath: agentCapsule,
  manifestPath: agentManifest,
  target: runtimePlatform.target,
  targetDirectory: path.join(probeRoot, 'agent'),
});
const playwrightEntry = path.join(agentRoot, 'node_modules', 'playwright-core', 'index.mjs');
writeFileSync(nodeBinary, nodeBytes);
chmodSync(nodeBinary, 0o700);

const probe = `
import { existsSync } from 'node:fs';
const { chromium } = await import(${JSON.stringify(pathToFileURL(playwrightEntry).href)});
const systemCandidates = process.platform === 'darwin'
  ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  : process.platform === 'win32'
    ? [
        process.env.PROGRAMFILES && process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env['PROGRAMFILES(X86)'] && process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
        process.env.LOCALAPPDATA && process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
      ].filter(Boolean)
    : [];
const managed = chromium.executablePath();
const executablePath = systemCandidates.find(existsSync)
  ?? (existsSync(managed) ? managed : undefined);
if (!executablePath) throw new Error('no supported ClawMaster RPA browser runtime is installed');
const browser = await chromium.launch({ headless: true, executablePath });
try {
  const page = await browser.newPage();
  await page.setContent('<label>Task <input id="task"></label><button id="run">Run</button><output id="result"></output>');
  await page.evaluate(() => {
    document.querySelector('#run').addEventListener('click', () => {
      document.querySelector('#result').textContent = document.querySelector('#task').value.toUpperCase();
    });
  });
  await page.locator('#task').fill('clawmaster rpa ready');
  await page.locator('#run').click();
  const result = await page.locator('#result').textContent();
  if (result !== 'CLAWMASTER RPA READY') throw new Error('packaged RPA interaction result mismatch');
  process.stdout.write(JSON.stringify({ ok: true, executablePath, result }) + '\\n');
} finally {
  await browser.close();
}
`;

try {
  execFileSync(nodeBinary, ['--input-type=module', '--eval', probe], {
    stdio: 'inherit',
    timeout: 45_000,
  });
} finally {
  rmSync(probeRoot, { recursive: true, force: true });
}
console.log(`[tauri-rpa] ${useStaging ? 'staged' : 'packaged'} browser interaction smoke passed`);

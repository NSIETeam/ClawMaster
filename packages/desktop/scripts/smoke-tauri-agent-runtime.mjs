#!/usr/bin/env node
/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { resolveTauriRuntimePlatform } from './tauri-runtime-policy.mjs';
import { readVerifiedBinaryCapsule } from './binary-capsule.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staging = path.join(desktopRoot, 'src-tauri', 'target', 'sidecar-staging');
const runtime = path.join(staging, 'runtime');
const runtimePlatform = resolveTauriRuntimePlatform(process.platform, process.arch);
const nodeCapsule = path.join(runtime, 'node', 'node.br');
const nodeManifestPath = path.join(runtime, 'node', 'node-manifest.json');
const bootstrap = path.join(runtime, 'agent', 'bootstrap.mjs');
const sqlcipher = path.join(runtime, 'sqlcipher', 'better_sqlite3.node');

for (const required of [
  nodeCapsule,
  nodeManifestPath,
  bootstrap,
  path.join(runtime, 'agent', 'directory-capsule.mjs'),
  path.join(runtime, 'agent', 'agent.br'),
  path.join(runtime, 'agent', 'agent-manifest.json'),
  sqlcipher,
]) {
  if (!existsSync(required)) throw new Error(`staged runtime is missing ${required}`);
}

const { bytes: nodeBytes } = readVerifiedBinaryCapsule({
  capsulePath: nodeCapsule,
  manifestPath: nodeManifestPath,
  target: runtimePlatform.target,
  minimumBytes: 1_000_000,
});
const nodeRoot = mkdtempSync(path.join(os.tmpdir(), 'clawmaster-tauri-node-'));
const sidecar = path.join(nodeRoot, `node${runtimePlatform.executableSuffix}`);
writeFileSync(sidecar, nodeBytes);
chmodSync(sidecar, 0o700);

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const selected = typeof address === 'object' && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(selected));
  });
});
const home = mkdtempSync(path.join(os.tmpdir(), 'clawmaster-tauri-smoke-'));
const userRoot = path.join(home, '.clawmaster-user');
const keyPath = path.join(home, 'database.key');
const endpointPath = path.join(userRoot, 'server-endpoint.json');
writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });

const child = spawn(sidecar, [bootstrap, 'start'], {
  cwd: home,
  env: {
    HOME: home,
    USERPROFILE: home,
    PWD: home,
    PATH: process.env.PATH ?? '',
    TMPDIR: os.tmpdir(),
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    LANG: process.env.LANG ?? 'C.UTF-8',
    CLAWMASTER_RESOURCES_PATH: runtime,
    CLAWMASTER_SQLCIPHER_NATIVE_BINDING: sqlcipher,
    CLAWMASTER_DATABASE_ENCRYPTION_KEY_FILE: keyPath,
    CLAWMASTER_DATABASE_ENCRYPTION_KEY_ID: 'tauri-runtime-smoke',
    CLAWMASTER_SERVER_PORT: String(port),
    CLAWMASTER_USER_DIR: userRoot,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-12_000); });

const deadline = Date.now() + 60_000;
let endpoint = null;
while (Date.now() < deadline) {
  if (child.exitCode !== null) break;
  try {
    const candidate = JSON.parse(readFileSync(endpointPath, 'utf8'));
    if (
      candidate.host === '127.0.0.1'
      && candidate.port === port
      && candidate.pid === child.pid
      && typeof candidate.clientToken === 'string'
      && candidate.clientToken.length > 10
    ) {
      endpoint = candidate;
      break;
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}

let protocolError = null;
if (endpoint) {
  try {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?clientToken=${encodeURIComponent(endpoint.clientToken)}`,
    );
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('packaged WebSocket open timed out')), 5_000);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    socket.send(JSON.stringify({
      type: 'hello',
      payload: { protocolVersion: endpoint.protocolVersion, clientKind: 'desktop' },
    }));
    const commands = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('slash command discovery timed out')), 5_000);
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type !== 'slash_commands_list') return;
        clearTimeout(timer);
        resolve(frame.payload.commands.map((command) => command.name));
      });
      socket.send(JSON.stringify({ type: 'list_slash_commands', payload: {} }));
    });
    socket.close();
    for (const requiredCommand of ['plan', 'goal', 'system', 'init']) {
      if (!commands.includes(requiredCommand)) {
        throw new Error(`packaged runtime is missing /${requiredCommand}`);
      }
    }
  } catch (error) {
    protocolError = error;
  }
}

child.kill('SIGTERM');
await new Promise((resolve) => {
  if (child.exitCode !== null) return resolve();
  child.once('exit', resolve);
  setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3_000).unref();
});
const startupError = !endpoint
  ? new Error(`Tauri Agent runtime failed its startup smoke test:\n${stderr || 'no endpoint produced'}`)
  : protocolError;
rmSync(home, { recursive: true, force: true });
rmSync(nodeRoot, { recursive: true, force: true });
if (startupError) throw startupError;
console.log(`[tauri-runtime] sidecar and /plan /goal /system /init discovery passed on 127.0.0.1:${port}`);

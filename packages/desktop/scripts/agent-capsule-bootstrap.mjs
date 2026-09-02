import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { materializeDirectoryCapsule } from './directory-capsule.mjs';
import {
  bindSidecarToParentPipe,
  removeOwnedEndpoint,
} from './sidecar-parent-lifetime.mjs';

function runtimeTarget() {
  const target = new Map([
    ['darwin-arm64', 'darwin-arm64'],
    ['darwin-x64', 'darwin-x64'],
    ['win32-x64', 'win32-x64'],
  ]).get(`${process.platform}-${process.arch}`);
  if (!target) throw new Error(`unsupported ClawMaster Agent runtime: ${process.platform}-${process.arch}`);
  return target;
}

const capsuleRoot = path.dirname(fileURLToPath(import.meta.url));
const capsulePath = path.join(capsuleRoot, 'agent.br');
const manifestPath = path.join(capsuleRoot, 'agent-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.sha256)) {
  throw new Error('packaged Agent capsule manifest has an invalid identity');
}
const userRoot = process.env.OTTO_USER_DIR
  || path.join(homedir(), '.clawmaster-user');
if (process.env.CLAWMASTER_PARENT_PIPE === '1') {
  bindSidecarToParentPipe({
    parentPid: Number(process.env.CLAWMASTER_PARENT_PID) || undefined,
    beforeExit: () => removeOwnedEndpoint(
      path.join(userRoot, 'server-endpoint.json'),
    ),
  });
}
const targetDirectory = path.join(
  userRoot,
  'runtime-cache',
  `agent-${manifest.sha256}`,
);
const agentRoot = materializeDirectoryCapsule({
  capsulePath,
  manifestPath,
  target: runtimeTarget(),
  targetDirectory,
});
process.env.CLAWMASTER_AGENT_ROOT = agentRoot;
const entry = process.argv[2] === 'document' ? 'document.mjs' : 'server.mjs';
await import(pathToFileURL(path.join(agentRoot, entry)).href);

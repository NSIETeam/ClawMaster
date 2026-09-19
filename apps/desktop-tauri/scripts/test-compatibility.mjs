/** Reproducible package compatibility tests bound to the current prepared desktop build. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPreparedBundle } from './bundle-harness-source.mjs';
import { desktopBuildMode, verifyPreparedBuild } from './build-provenance.mjs';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(desktop, '../..');

/**
 * Reject an archive before extraction unless it matches the reviewed package digest.
 * @param {Uint8Array} bytes Downloaded official package bytes.
 * @param {'sha256'|'sha512'} algorithm Digest declared by the provenance owner.
 * @param {string} expected Hex SHA-256 or base64 SHA-512 digest.
 * @returns {void}
 */
export function verifyArchive(bytes, algorithm, expected) {
  const actual = createHash(algorithm).update(bytes).digest(algorithm === 'sha256' ? 'hex' : 'base64');
  assert.equal(actual, expected, 'Official package archive differs from reviewed provenance');
}

function run(command, args, cwd, environment = process.env) {
  const windowsPnpm = process.platform === 'win32' && command === 'pnpm';
  const executable = windowsPnpm ? environment.ComSpec ?? 'cmd.exe' : command;
  const parameters = windowsPnpm ? ['/d', '/s', '/c', 'pnpm install --frozen-lockfile --ignore-scripts'] : args;
  // CI mode keeps pnpm non-interactive (module-layout purges would prompt).
  const env = { ...environment, CI: 'true' };
  const result = spawnSync(executable, parameters, { cwd, env, stdio: 'inherit', timeout: 600000 });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `${command} was terminated before completion`);
  assert.equal(result.status, 0, `${command} failed`);
}

async function extract(url, algorithm, digest, target) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, 200, 'Pinned package download failed');
  const bytes = new Uint8Array(await response.arrayBuffer());
  verifyArchive(bytes, algorithm, digest);
  await mkdir(target);
  const archive = `${target}.tgz`;
  await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
  run('tar', ['-xzf', archive, '-C', target, '--strip-components=1'], desktop);
}

async function main() {
  const mode = desktopBuildMode();
  const source = verifyPreparedBuild(repository, mode);
  const bundled = join(desktop, 'bundled/harness');
  assertPreparedBundle(bundled, mode);
  const manifest = JSON.parse(await readFile(join(bundled, '.bundle-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.buildProvenance, source, 'Prepared bundle does not belong to the current source build');
  const temporary = await mkdtemp(join(tmpdir(), 'clawmaster-package-compat-'));
  try {
    const memory = JSON.parse(await readFile(join(desktop, 'patches/openviking-0.3.0.integrity.json'), 'utf8'));
    const office = JSON.parse(await readFile(join(desktop, 'patches/dsh-better-sidebar@0.19.1.office-save.provenance.json'), 'utf8'));
    const core = join(temporary, 'harness');
    const pristine = join(temporary, 'openviking');
    const sidebar = join(temporary, 'sidebar');
    await cp(bundled, core, { recursive: true });
    await extract(memory.registryTarball, 'sha256', memory.tarballSha256, pristine);
    await extract(office.upstreamTarball, 'sha512', office.upstreamIntegrity.replace(/^sha512-/, ''), sidebar);
    run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], core);
    const environment = {
      ...process.env,
      DSH_DESKTOP_SMOKE_ROOT: core,
      DSH_ROUTING_TEST_CORE_ROOT: core,
      DSH_OPENVIKING_TEST_CORE_ROOT: core,
      DSH_OPENVIKING_PRISTINE: pristine,
      DSH_OFFICE_SIDEBAR_PACKAGE_ROOT: sidebar,
    };
    run(process.execPath, ['--test', 'scripts/desktop-plugin-install.test.mjs', 'scripts/openviking-compat.test.mjs',
      'scripts/routing-suite.test.mjs', 'scripts/harness-startup.test.mjs'], desktop, environment);
    run(process.execPath, ['--import', 'tsx/esm', '--test', 'scripts/office-save.test.mjs'], desktop, environment);
    verifyPreparedBuild(repository, mode);
    console.log('Package compatibility passed against the current prepared build. Live OpenViking and IM acceptance are separate tests.');
  } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 3 }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

/** Prepare the hash-pinned Office editor with bounded retries for transient HTTP downloads. */
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

/**
 * Download an immutable archive; curl retries transient HTTP responses, not invalid content.
 * @param {string} url Pinned upstream archive URL.
 * @param {string} destination Private temporary archive path.
 * @returns {Promise<void>} Completes only after a successful HTTP download.
 */
export async function downloadOfficeArchive(url, destination) {
  await execute('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3',
    '--retry-delay', '2', '--max-time', '300', '--output', destination, url]);
}

async function main() {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const source = JSON.parse(await readFile(join(root, 'frontends/office/vendor/onlyoffice-web-local/SOURCE.json'), 'utf8'));
  const temporary = await mkdtemp(join(tmpdir(), 'clawmaster-office-download-'));
  try {
    const archive = join(temporary, 'release.zip');
    await downloadOfficeArchive(source.archiveUrl, archive);
    const { stdout, stderr } = await execute(process.execPath, [
      join(root, 'frontends/office/scripts/prepare-runtime.mjs'), '--archive', archive,
    ], { cwd: root, maxBuffer: 1024 * 1024 });
    process.stdout.write(stdout); process.stderr.write(stderr);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) await main();

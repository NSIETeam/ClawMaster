/** Repeatable, threshold-free capacity diagnostic for the production enterprise store. */
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../..');
type Metric = { elapsedMs: number; eventLoopRoundtripMs: number; responseBytes: number | null; rssBeforeBytes: number; rssAfterBytes: number; heapAfterBytes: number };
type Sample = { samples: Record<string, Metric>; peakRssBytes: number };

/**
 * Select a nearest-rank percentile without deleting slow samples.
 * @param samples Nonempty measurements.
 * @param fraction Percentile between zero and one.
 * @returns Selected measured value.
 */
export function percentile(samples: readonly number[], fraction: number): number {
  if (!samples.length || samples.some(value => !Number.isFinite(value) || value < 0) || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new Error('Invalid percentile samples');
  return [...samples].sort((a, b) => a - b)[Math.max(0, Math.ceil(samples.length * fraction) - 1)]!;
}

function child(worker: string, mode: string, path: string, count: number): Promise<string> {
  return new Promise((accept, reject) => {
    const environment = { ...globalThis.process.env };
    delete environment.NODE_OPTIONS;
    const process = spawn(globalThis.process.execPath, ['--expose-gc', worker, mode, path, String(count)], { stdio: ['ignore', 'pipe', 'pipe'], env: environment });
    let stdout = '';
    let stderr = '';
    let expired = false;
    const timer = setTimeout(() => { expired = true; process.kill('SIGKILL'); }, 120_000);
    process.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    process.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    process.once('error', error => { clearTimeout(timer); reject(error); });
    process.once('close', code => {
      clearTimeout(timer);
      if (expired || code !== 0) reject(new Error(`Capacity worker ${mode} failed (${expired ? 'timeout' : code}): ${stderr}`));
      else accept(stdout);
    });
  });
}

/**
 * Compile a private adapter and measure fresh processes against isolated SQLite copies.
 * @param tiers Synthetic record counts per business collection.
 * @param repetitions Independent process samples per tier.
 * @returns Source/artifact identity and raw observations; no release or browser verdict.
 */
export async function runCapacity(tiers: readonly number[], repetitions: number) {
  if (!tiers.length || tiers.some(value => !Number.isSafeInteger(value) || value < 1 || value > 10_000) || !Number.isSafeInteger(repetitions) || repetitions < 2 || repetitions > 20) throw new Error('Use 1–10000 records per tier and 2–20 samples');
  const buildRoot = resolve(directory, '../.dsh-build');
  await mkdir(buildRoot, { recursive: true });
  const artifact = await mkdtemp(join(buildRoot, 'capacity-'));
  const data = await mkdtemp(join(tmpdir(), 'clawmaster-capacity-'));
  try {
    const worker = join(artifact, 'worker.mjs');
    await build({ absWorkingDir: root, entryPoints: [join(directory, 'enterprise-worker.mjs')], outfile: worker, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'es2022', metafile: false });
    const observations = [];
    for (const count of tiers) {
      const seed = join(data, `seed-${count}.sqlite`);
      await child(worker, 'seed', seed, count);
      const samples: Sample[] = [];
      for (let index = 0; index < repetitions; index++) {
        const path = join(data, `sample-${count}-${index}.sqlite`);
        await cp(seed, path);
        samples.push(JSON.parse(await child(worker, 'sample', path, count)) as Sample);
      }
      const metrics = Object.fromEntries(Object.keys(samples[0]!.samples).map(name => [name, {
        p50Ms: percentile(samples.map(sample => sample.samples[name]!.elapsedMs), 0.5),
        p95Ms: percentile(samples.map(sample => sample.samples[name]!.elapsedMs), 0.95),
        maxEventLoopRoundtripMs: Math.max(...samples.map(sample => sample.samples[name]!.eventLoopRoundtripMs)),
        maxResponseBytes: Math.max(...samples.map(sample => sample.samples[name]!.responseBytes ?? 0)),
      }]));
      observations.push({ recordsPerCollection: count, seededAuditEntries: count * 5, metrics, peakRssBytes: Math.max(...samples.map(sample => sample.peakRssBytes)), samples });
    }
    return {
      schemaVersion: 1, measuredAt: new Date().toISOString(), evidencePlane: 'diagnostic-artifact',
      source: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '' },
      artifact: { sha256: createHash('sha256').update(await readFile(worker)).digest('hex'), packages: 'external' },
      host: { platform: process.platform, arch: process.arch, node: process.version, cpus: cpus().length, totalMemoryBytes: totalmem() },
      exclusions: ['release installation', 'HTTP authentication and transport', 'browser interaction and paint', 'cold filesystem cache', 'enforced timing budgets'], observations,
    };
  } finally {
    await rm(artifact, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { tiers: { type: 'string', default: '100,1000,10000' }, samples: { type: 'string', default: '5' }, output: { type: 'string' } } });
  const report = JSON.stringify(await runCapacity(values.tiers!.split(',').map(Number), Number(values.samples)), null, 2) + '\n';
  if (values.output) await writeFile(values.output, report);
  else process.stdout.write(report);
}

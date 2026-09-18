/** Read-only compatibility inspection for the portable updater kit; located files do not prove an active Host. */
import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { valid } from 'semver';
import { isMap, isSeq, parseDocument, type YAMLMap } from 'yaml';
import { highestInstalledComponentVersion } from './components.ts';
import type { HostIdentity } from './facts.ts';

/** Explicit locations and process evidence supplied by the kit; no environment or home discovery occurs here. */
export interface CompatibilityOptions {
  dshHome?: string;
  runtimeRoot?: string;
  cwd?: string;
  platform: NodeJS.Platform;
  runtimeStatePath?: string;
  inheritedRunId?: string;
  hostIdentity?: Pick<HostIdentity, 'pid' | 'runId' | 'entry'>;
  launchManifestPath?: string;
}

/** Read-only process probe; implementations must not send a terminating signal or launch a command. */
export interface CompatibilityDependencies { isProcessAlive?: (pid: number) => boolean | Promise<boolean> }

/** A detected incompatibility requires a native upgrade; missing evidence instead requires an explicit location. */
export type CompatibilityStatus = 'supported-component-bootstrap' | 'updater-already-present' | 'native-upgrade-required' | 'needs-location';

/** Safe diagnostic codes and text never contain configuration values or parser excerpts. */
export interface CompatibilityReason { code: string; message: string }

/** Static compatibility evidence; even a supported profile requires independent Loader observation after mounting. */
export interface CompatibilityReport {
  status: CompatibilityStatus;
  reasons: CompatibilityReason[];
  knownDshVersion: string | null;
  knownCordisVersion: string | null;
  runtimeRoot: string | null;
  dshHome: string | null;
  verifiedNodePath: string | null;
  updaterVersion: string | null;
  updaterDeclared: boolean;
  source: 'explicit-runtime' | 'host-entry' | 'working-directory' | 'desktop-runtime-locator' | 'launch-manifest-locator' | 'unavailable';
}

const MAX_METADATA_BYTES = 1024 * 1024;
const SUPPORTED_DSH = '0.1.5-rc.2';
const SUPPORTED_CORDIS = '4.0.2';
const KIT_UPDATER = '0.1.0';
const UPDATER_PACKAGE = '@clawmaster/dsh-updates';
const coreServices: Record<string, string> = { commands: '@deepseek-ai/dsh-commands', tools: '@deepseek-ai/dsh-tools', approval: '@deepseek-ai/dsh-user-approval' };
type RecordValue = Record<string, unknown>;
interface LocatedRuntime { root: string; dsh: string; cordis: string | null; cliVersion: string | null }

function object(value: unknown): RecordValue | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null; }
function version(value: unknown): string | null { return typeof value === 'string' && valid(value) === value ? value : null; }
function absolute(value: unknown): value is string { return typeof value === 'string' && isAbsolute(value) && resolve(value) === value && parse(value).root !== value && !/[\u0000-\u001f\u007f]/u.test(value); }
function inside(parent: string, child: string): boolean { const path = relative(parent, child); return path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path); }

async function plainDirectory(path: string): Promise<boolean> {
  try { const info = await lstat(path); return info.isDirectory() && !info.isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function text(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_METADATA_BYTES) throw new Error('unsafe-metadata');
    const bytes = await readFile(path);
    if (bytes.length > MAX_METADATA_BYTES) throw new Error('unsafe-metadata');
    return bytes.toString('utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function record(path: string): Promise<RecordValue | null> {
  const bytes = await text(path);
  if (bytes === null) return null;
  const value = object(JSON.parse(bytes));
  if (!value) throw new Error('invalid-metadata');
  return value;
}

async function runtime(root: string): Promise<LocatedRuntime | null> {
  if (!absolute(root) || !await plainDirectory(root)) return null;
  const manifest = await record(join(root, 'package.json'));
  if (manifest?.name !== '@deepseek-ai/dsh-root') return null;
  const dsh = version(manifest.version);
  if (!dsh) throw new Error('invalid-runtime-version');
  if (!await plainDirectory(join(root, 'vendor')) || !await plainDirectory(join(root, 'vendor', 'cordis'))) return { root, dsh, cordis: null, cliVersion: null };
  const cordis = await record(join(root, 'vendor', 'cordis', 'package.json'));
  return { root, dsh, cordis: cordis?.name === '@deepseek-ai/cordis' ? version(cordis.version) : null, cliVersion: null };
}

async function ancestors(start: string, cliEntry: boolean): Promise<LocatedRuntime | null> {
  let directory = cliEntry ? dirname(start) : start;
  let cliVersion: string | null = null;
  if (cliEntry) {
    const info = await lstat(start).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info?.isFile() || info.isSymbolicLink()) return null;
  }
  for (let depth = 0; depth <= 4 && directory !== parse(directory).root; depth += 1) {
    if (!await plainDirectory(directory)) return null;
    const manifest = await record(join(directory, 'package.json'));
    if (manifest?.name === '@deepseek-ai/dsh') cliVersion = version(manifest.version);
    const candidate = manifest?.name === '@deepseek-ai/dsh-root' ? await runtime(directory) : null;
    if (candidate) return cliEntry && cliVersion !== candidate.dsh ? null : { ...candidate, cliVersion };
    directory = dirname(directory);
  }
  return null;
}

function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

function patchRows(source: string | null): YAMLMap[] {
  const doc = parseDocument(source ?? '');
  if (doc.errors.length || (doc.contents !== null && !isSeq(doc.contents))) throw new Error('invalid-profile-patch');
  const rows: YAMLMap[] = [];
  if (isSeq(doc.contents)) for (const row of doc.contents.items) {
    if (!isMap(row)) throw new Error('invalid-profile-patch');
    rows.push(row);
    const inserted = row.get('insert', true);
    if (inserted !== undefined && !isSeq(inserted)) throw new Error('invalid-profile-patch');
    if (isSeq(inserted)) for (const entry of inserted.items) {
      if (!isMap(entry)) throw new Error('invalid-profile-patch');
      rows.push(entry);
    }
  }
  return rows;
}

/** Inspect explicitly selected and bounded locator paths without modifying configuration, installing packages or reading secrets.
 * @param options Selected locations, platform and optional evidence from the owning Host.
 * @param dependencies Read-only process liveness probe; defaults to signal zero.
 * @returns A conservative static compatibility report; absent evidence never establishes support or activation.
 */
export async function inspectCompatibility(options: CompatibilityOptions, dependencies: CompatibilityDependencies = {}): Promise<CompatibilityReport> {
  const report: CompatibilityReport = { status: 'needs-location', reasons: [], knownDshVersion: null, knownCordisVersion: null,
    runtimeRoot: null, dshHome: options.dshHome ?? null, verifiedNodePath: null, updaterVersion: null, updaterDeclared: false, source: 'unavailable' };
  const finish = (status: CompatibilityStatus, code: string, message: string): CompatibilityReport => {
    report.status = status; report.reasons.push({ code, message }); return report;
  };
  for (const value of [options.dshHome, options.runtimeRoot, options.cwd, options.runtimeStatePath, options.launchManifestPath, options.hostIdentity?.entry]) {
    if (value !== undefined && !absolute(value)) return finish('needs-location', 'invalid-location', 'Select absolute normalized locations below the filesystem root.');
  }
  try {
    let located: LocatedRuntime | null = null;
    if (options.runtimeRoot) {
      located = await runtime(options.runtimeRoot);
      if (!located) return finish('needs-location', 'runtime-not-found', 'The selected directory does not contain a verified DSH runtime manifest.');
      report.source = 'explicit-runtime';
    }
    const home = options.dshHome;
    if (!located && home) {
      const statePath = join(home, 'desktop', 'current-runtime.json');
      if (options.runtimeStatePath && options.runtimeStatePath !== statePath) return finish('needs-location', 'runtime-state-home-mismatch', 'The runtime record must belong to the selected DSH home.');
      if (await plainDirectory(home) && await plainDirectory(join(home, 'desktop'))) {
        const state = await record(statePath);
        if (state) {
          const identity = options.hostIdentity;
          const ownHost = identity && Number.isSafeInteger(identity.pid) && identity.pid > 0 && state.hostPid === identity.pid && !!identity.runId && state.runId === identity.runId;
          const childOfHost = state.schemaVersion === 1 && state.status === 'ready' && !!options.inheritedRunId && state.runId === options.inheritedRunId && typeof state.hostPid === 'number'
            && Number.isSafeInteger(state.hostPid) && state.hostPid > 0 && await (dependencies.isProcessAlive ?? processAlive)(state.hostPid);
          if (state.schemaVersion === 1 && state.status === 'ready' && (ownHost || childOfHost) && absolute(state.harnessRoot)) {
            const candidate = await runtime(state.harnessRoot);
            if (candidate && candidate.dsh === state.harnessVersion && (!identity?.entry || inside(candidate.root, identity.entry))) {
              located = candidate; report.source = 'desktop-runtime-locator';
            }
          }
          if (!located) report.reasons.push({ code: 'runtime-state-unverified', message: 'The runtime record does not establish a matching live Host and runtime location.' });
        }
      }
    }
    if (!located && options.hostIdentity?.entry) { located = await ancestors(options.hostIdentity.entry, true); if (located) report.source = 'host-entry'; }
    if (!located && options.cwd) { located = await ancestors(options.cwd, false); if (located) report.source = 'working-directory'; }
    if (!located && options.launchManifestPath) {
      if (!await plainDirectory(dirname(options.launchManifestPath)) || !await plainDirectory(dirname(dirname(options.launchManifestPath)))) return finish('needs-location', 'launch-manifest-unavailable', 'The launch metadata directory is missing or redirected.');
      const launch = await record(options.launchManifestPath);
      if (launch) {
        if (!absolute(launch.cli) || !absolute(launch.dshHome) || !absolute(launch.node)) return finish('needs-location', 'launch-manifest-invalid', 'The launch metadata does not contain valid absolute locations.');
        if (options.dshHome && launch.dshHome !== options.dshHome) return finish('needs-location', 'launch-home-mismatch', 'Launch metadata belongs to a different DSH home; the selected home was preserved.');
        located = await ancestors(launch.cli, true);
        if (located) {
          report.dshHome = launch.dshHome; report.source = 'launch-manifest-locator';
          const node = await lstat(launch.node).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
          if (node?.isFile() && !node.isSymbolicLink() && (options.platform === 'win32' || (node.mode & 0o111) !== 0)) report.verifiedNodePath = launch.node;
        }
      }
    }
    if (!located) return finish('needs-location', 'runtime-location-unverified', 'No inspected location established the installed DSH runtime; select its actual runtime and home.');
    report.runtimeRoot = located.root; report.knownDshVersion = located.dsh; report.knownCordisVersion = located.cordis;
    if (located.dsh !== SUPPORTED_DSH || located.cordis !== SUPPORTED_CORDIS) return finish('native-upgrade-required', 'runtime-incompatible', 'The observed DSH or Cordis version is outside this kit\'s supported component bootstrap.');
    if (!report.dshHome || !await plainDirectory(report.dshHome)) return finish('needs-location', 'home-unverified', 'Select the existing DSH home used by ClawMaster.');
    const profile = join(report.dshHome, 'profiles', 'web');
    if (!await plainDirectory(join(report.dshHome, 'profiles')) || !await plainDirectory(profile)) return finish('needs-location', 'web-profile-unavailable', 'The selected home has no regular web profile directory.');
    const manifest = await record(join(profile, 'package.json'));
    if (!manifest) return finish('needs-location', 'web-profile-unavailable', 'The selected web profile has no package manifest.');
    const profileSettings = object(object(manifest.dsh)?.profile);
    const bundles = profileSettings?.bundles;
    const profileDependencies = object(manifest.dependencies);
    const rows = [...patchRows(await text(join(profile, 'cordis.patch.yml'))), ...patchRows(await text(join(report.dshHome, 'cordis.patch.yml')))];
    const ownedUrl = pathToFileURL(`${join(report.dshHome, 'clawmaster-updates', 'components', 'updates')}/`).href;
    report.updaterDeclared = !!profileDependencies && Object.hasOwn(profileDependencies, UPDATER_PACKAGE)
      || Array.isArray(bundles) && bundles.includes(UPDATER_PACKAGE)
      || rows.some(row => row.get('id') === 'clawmaster-update-component-updates' || row.get('name') === UPDATER_PACKAGE
        || typeof row.get('name') === 'string' && (row.get('name') as string).startsWith(ownedUrl));
    report.updaterVersion = await highestInstalledComponentVersion(report.dshHome, 'updates');
    if (report.updaterDeclared || report.updaterVersion !== null && report.updaterVersion !== KIT_UPDATER) return finish('updater-already-present', 'updater-present', 'An updater is already declared or a different verified version is installed; this kit must not replace it. Activation has not been verified.');
    if (!Array.isArray(bundles) || !bundles.includes('@deepseek-ai/dsh-base') || !bundles.includes('@deepseek-ai/dsh-web-app')) return finish('needs-location', 'custom-profile-unverified', 'This custom profile does not declare the supported base and web bundles; its required services need separate verification.');
    if (profileSettings?.patchReload !== undefined && profileSettings.patchReload !== 'live') return finish('needs-location', 'profile-not-live', 'The web profile does not enable live user-patch loading.');
    if (rows.some(row => {
      const id = row.get('id');
      if (typeof id !== 'string' || !Object.hasOwn(coreServices, id)) return false;
      return row.has('disabled') && ![false, null].includes(row.get('disabled') as false | null)
        || row.has('name') && row.get('name') !== coreServices[id]
        || ['inject', 'isolate', 'intercept', 'group'].some(key => row.has(key));
    })) return finish('needs-location', 'required-services-customized', 'The profile overrides a required updater service; activation needs separate verification.');
    return finish('supported-component-bootstrap', 'static-requirements-met', 'The inspected runtime and web profile support first component bootstrap. Actual Loader activation still requires observation.');
  } catch {
    return finish('needs-location', 'metadata-unusable', 'A selected metadata or updater-state file is unreadable, redirected, malformed, oversized or inconsistent. No files were changed.');
  }
}

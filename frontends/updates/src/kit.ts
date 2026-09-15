/** Verify a portable update kit and bind its finite operations to inspected local state. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, opendir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { inspectCompatibility, type CompatibilityOptions, type CompatibilityReport } from './compatibility.ts';
import { parseSignedCatalog, type CatalogItem } from './catalog.ts';
import { installComponent, readComponentPatchRevision } from './components.ts';
import { bootstrapUpdater } from './bootstrap.ts';
import { assertManagedHome } from './managed-home.ts';
import { fetchNativeRelease, nativeArtifact, prepareNativeUpdate, type NativeTarget } from './native.ts';
import { COMPONENT_PUBLIC_KEY, NATIVE_PUBLIC_KEY } from './keys.ts';

const CATALOG_URL = 'https://8.140.52.117/updates/clawmaster/components/catalog.json';
const NATIVE_URL = 'https://8.140.52.117/updates/clawmaster/latest.json';
const METADATA_BYTES = 1024 * 1024;
const PAYLOAD_BYTES = 64 * 1024 * 1024;
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const manifestSchema = z.strictObject({ schemaVersion: z.literal(1), kitVersion: z.literal('0.1.0'), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  files: z.array(z.strictObject({ path: z.string().regex(/^[A-Za-z0-9@_.-]+(?:\/[A-Za-z0-9@_.-]+)*$/u), sha256: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().nonnegative().max(PAYLOAD_BYTES) })).min(1).max(128),
});

/** Deployment trust and network adapter; production CLI uses its embedded public keys. */
export interface KitTrust { componentPublicKey: string; catalogUrl: string; nativePublicKey: string; nativeManifestUrl: string; fetchImpl?: typeof fetch }
const productionTrust: KitTrust = { componentPublicKey: COMPONENT_PUBLIC_KEY, catalogUrl: CATALOG_URL, nativePublicKey: NATIVE_PUBLIC_KEY, nativeManifestUrl: NATIVE_URL };

/** Authenticated kit metadata and retained archive bytes; callers must not reread an untrusted extraction directory for installation. */
export interface VerifiedKit { kitVersion: string; sourceCommit: string; component: Extract<CatalogItem, { kind: 'component' }>; archivePath: string; archiveBytes: Buffer }
/** Read-only first-install plan; a missing revision never authorizes a write. */
export interface KitPlan { status: CompatibilityReport['status']; compatibility: CompatibilityReport; component: CatalogItem; patchRevision: string | null; kitVersion: string; sourceCommit: string }
/** Explicit local selection and confirmation of a previously inspected plan. */
export interface KitInstallOptions { kitRoot: string; compatibility: CompatibilityOptions; confirmed: boolean; expectedSha256?: string; expectedPatchRevision?: string }

async function regularDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('A kit or update directory is redirected or is not a directory');
}

async function boundedFile(root: string, relative: string, limit: number): Promise<Buffer> {
  await regularDirectory(root);
  const parts = relative.split('/');
  if (parts.some(part => part === '.' || part === '..' || !part)) throw new Error('Invalid relative kit path');
  let parent = root;
  for (const part of parts.slice(0, -1)) { parent = join(parent, part); await regularDirectory(parent); }
  const path = join(root, ...parts);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('A kit or profile file is redirected, oversized or is not a regular file');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error('File exceeds the allowed byte limit');
  return bytes;
}

async function inventory(root: string, expected: Set<string>): Promise<string[]> {
  const files: string[] = [];
  const directories = new Set<string>();
  for (const file of expected) {
    const parts = file.split('/');
    for (let length = 1; length < parts.length; length += 1) directories.add(parts.slice(0, length).join('/'));
  }
  let entries = 0;
  async function walk(prefix: string): Promise<void> {
    await regularDirectory(join(root, prefix));
    for await (const entry of await opendir(join(root, prefix))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      entries += 1;
      if (entries > expected.size + directories.size) throw new Error('Portable kit contains too many entries');
      if (entry.isSymbolicLink()) throw new Error('Portable kit contains a symbolic link');
      if (entry.isDirectory()) {
        if (!directories.has(path) || path.split('/').length > 8) throw new Error('Portable kit contains an unexpected directory');
        await walk(path);
      } else if (entry.isFile()) files.push(path);
      else throw new Error('Portable kit contains an unsupported file');
    }
  }
  await walk('');
  return files;
}

/** Verify the signed file list, exact kit inventory and signed bundled catalog without network access or writes.
 * @param root Extracted kit directory, never the ZIP itself.
 * @param trust Pinned deployment key and catalog origin.
 * @returns Authenticated payload location and source provenance.
 */
export async function verifyKit(root: string, trust: KitTrust = productionTrust): Promise<VerifiedKit> {
  const bytes = await boundedFile(root, 'kit-manifest.json', METADATA_BYTES);
  const encoded = (await boundedFile(root, 'kit-manifest.json.sig', 1024)).toString('utf8').trim();
  const signature = Buffer.from(encoded, 'base64');
  const key = createPublicKey(trust.componentPublicKey);
  if (signature.length !== 64 || signature.toString('base64') !== encoded || key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, signature)) throw new Error('Portable kit signature verification failed');
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  const expected = new Set(['kit-manifest.json', 'kit-manifest.json.sig']);
  const folded = new Set([...expected].map(path => path.toLowerCase()));
  let total = 0;
  for (const file of manifest.files) {
    if (folded.has(file.path.toLowerCase()) || file.path.split('/').some(part => part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)) || file.path.split('/').length > 9) throw new Error('Portable kit manifest repeats or redirects a path');
    folded.add(file.path.toLowerCase());
    expected.add(file.path);
    total += file.size;
    if (total > 96 * METADATA_BYTES) throw new Error('Portable kit exceeds its total byte limit');
    const contents = await boundedFile(root, file.path, file.size);
    if (contents.length !== file.size || digest(contents) !== file.sha256) throw new Error('Portable kit file hash verification failed');
  }
  const actual = await inventory(root, expected);
  if (actual.length !== expected.size || actual.some(file => !expected.has(file))) throw new Error('Portable kit inventory differs from its signed manifest');
  const catalogPath = 'payloads/catalog.json';
  if (!expected.has('update-kit.mjs') || !expected.has(catalogPath) || !expected.has(`${catalogPath}.sig`)) throw new Error('Portable kit is missing required signed files');
  const catalog = parseSignedCatalog(await boundedFile(root, catalogPath, METADATA_BYTES), (await boundedFile(root, `${catalogPath}.sig`, 1024)).toString('utf8'), {
    catalogUrl: trust.catalogUrl, publicKeyPem: trust.componentPublicKey, maxDownloadBytes: PAYLOAD_BYTES,
  });
  const component = catalog.components.find(item => item.id === 'updates');
  if (!component || component.kind !== 'component' || component.packageName !== '@clawmaster/dsh-updates' || component.version !== '0.1.0' || component.activation !== 'restart'
    || component.requiresDshVersion !== '0.1.5-rc.2') throw new Error('Portable kit has no supported first-install updater');
  const archive = `payloads/clawmaster-dsh-updates-${component.version}.tgz`;
  if (!expected.has(archive)) throw new Error('Portable kit archive is absent from the signed manifest');
  const payload = await boundedFile(root, archive, component.size);
  if (payload.length !== component.size || digest(payload) !== component.sha256) throw new Error('Bundled updater differs from its signed catalog');
  return { kitVersion: manifest.kitVersion, sourceCommit: manifest.sourceCommit, component, archivePath: join(root, archive), archiveBytes: payload };
}

/** Inspect the bundled updater against a selected runtime and profile; no directories are created.
 * @param options Extracted kit and optional installed-runtime locations.
 * @param trust Pinned deployment trust anchors.
 * @returns Compatibility, exact payload hash and watched-profile revision for confirmation.
 */
export async function inspectKit(options: Pick<KitInstallOptions, 'kitRoot' | 'compatibility'>, trust: KitTrust = productionTrust): Promise<KitPlan> {
  const kit = await verifyKit(options.kitRoot, trust);
  const compatibility = await inspectCompatibility(options.compatibility);
  const patchRevision = compatibility.status === 'supported-component-bootstrap' && compatibility.dshHome
    ? await readComponentPatchRevision(compatibility.dshHome) : null;
  return { status: compatibility.status, compatibility, component: kit.component, patchRevision, kitVersion: kit.kitVersion, sourceCommit: kit.sourceCommit };
}

async function ownedChild(parent: string, child: string): Promise<string> {
  await regularDirectory(parent);
  const path = join(parent, child);
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  await regularDirectory(path);
  return path;
}

async function backupProfile(dshHome: string, patchRevision: string): Promise<string> {
  const paths = ['profiles/web/cordis.patch.yml', 'profiles/web/package.json', 'cordis.patch.yml'];
  const snapshots = await Promise.all(paths.map(async path => {
    try { return { path, bytes: await boundedFile(dshHome, path, METADATA_BYTES) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, bytes: null }; throw error; }
  }));
  const patchBytes = snapshots[0]?.bytes ?? Buffer.alloc(0);
  if (`sha256-${digest(patchBytes)}` !== patchRevision || await readComponentPatchRevision(dshHome) !== patchRevision) throw new Error('The confirmed profile changed before backup');
  const managed = await ownedChild(dshHome, 'clawmaster-updates');
  const backupRoot = await ownedChild(managed, 'kit-backups');
  const directory = await mkdtemp(join(backupRoot, 'backup-'));
  const receipt: Array<{ path: string; existed: boolean; storedAs: string | null; sha256: string | null }> = [];
  for (const snapshot of snapshots) {
    const storedAs = snapshot.bytes ? `${receipt.length}.original` : null;
    if (storedAs && snapshot.bytes) await writeFile(join(directory, storedAs), snapshot.bytes, { mode: 0o600, flag: 'wx' });
    receipt.push({ path: snapshot.path, existed: snapshot.bytes !== null, storedAs, sha256: snapshot.bytes ? digest(snapshot.bytes) : null });
  }
  await writeFile(join(directory, 'receipt.json'), `${JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), patchRevision, files: receipt }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return directory;
}

/** Back up relevant profile files and mount the bundled updater only on its first installation.
 * Authenticated archive bytes are copied into private staging; changes to the extracted kit cannot replace the installed input.
 * @param options Explicit confirmation bound to the displayed payload and patch revision.
 * @param trust Pinned deployment trust anchors.
 * @returns Read-only plan or pending Loader activation and private backup location.
 */
export async function installKit(options: KitInstallOptions, trust: KitTrust = productionTrust): Promise<Record<string, unknown> | KitPlan> {
  const plan = await inspectKit(options, trust);
  if (!options.confirmed) return plan;
  if (plan.status !== 'supported-component-bootstrap' || !plan.compatibility.dshHome || !plan.patchRevision || !plan.compatibility.knownDshVersion || !plan.compatibility.knownCordisVersion) throw new Error('This installation does not support first updater bootstrap; inspect the reported compatibility reason');
  if (options.expectedSha256 !== plan.component.sha256 || options.expectedPatchRevision !== plan.patchRevision) throw new Error('The confirmed kit plan differs; inspect a fresh plan before retrying');
  const dshHome = plan.compatibility.dshHome;
  await assertManagedHome(dshHome);
  const backupDirectory = await backupProfile(dshHome, plan.patchRevision);
  const kit = await verifyKit(options.kitRoot, trust);
  if (kit.component.sha256 !== options.expectedSha256) throw new Error('The confirmed kit payload changed before installation');
  const managed = await ownedChild(dshHome, 'clawmaster-updates');
  const stagingRoot = await ownedChild(managed, 'kit-install-stages');
  const stage = await mkdtemp(join(stagingRoot, '.stage-'));
  try {
    const archivePath = join(stage, 'component.tgz');
    await writeFile(archivePath, kit.archiveBytes, { flag: 'wx', mode: 0o600 });
    const installed = await installComponent({ archivePath, descriptor: kit.component, dshHome, dshVersion: plan.compatibility.knownDshVersion,
      providedPackages: { '@deepseek-ai/cordis': plan.compatibility.knownCordisVersion } });
    if (installed.archiveSha256 !== kit.component.sha256) throw new Error('Installed component differs from the authenticated kit payload');
    const activation = await bootstrapUpdater({ dshHome, version: kit.component.version, expectedPatchRevision: plan.patchRevision, confirmed: true });
    return { ...plan, ...activation, backupDirectory };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

/** Current machine selection and confirmation for a native download, never native installation. */
export interface KitNativeOptions { kitRoot: string; compatibility: CompatibilityOptions; platform: NodeJS.Platform; arch: string; target?: NativeTarget; confirmed: boolean; expectedVersion?: string; expectedDigest?: string; signal?: AbortSignal }

/** Plan or verify a native update without closing ClawMaster or executing an installer.
 * @param options Machine target and explicit confirmation of a version and manifest digest.
 * @param trust Pinned component and native signing keys and HTTPS origins.
 * @returns A bound read-only plan or named, signature-verified file requiring native installation.
 */
export async function nativeKit(options: KitNativeOptions, trust: KitTrust = productionTrust): Promise<Record<string, unknown>> {
  await verifyKit(options.kitRoot, trust);
  const validTargets: NativeTarget[] = options.platform === 'darwin' && options.arch === 'arm64' ? ['darwin-aarch64']
    : options.platform === 'darwin' && options.arch === 'x64' ? ['darwin-x86_64']
    : options.platform === 'win32' && options.arch === 'x64' ? ['windows-x86_64']
    : options.platform === 'linux' && options.arch === 'x64' ? ['linux-x86_64', 'linux-x86_64-deb'] : [];
  const target = options.target ?? (validTargets.length === 1 ? validTargets[0] : undefined);
  if (!target || !validTargets.includes(target)) throw new Error('Select an installer target supported on this machine; Linux requires an explicit AppImage or DEB target');
  const request = { ...(trust.fetchImpl ? { fetchImpl: trust.fetchImpl } : {}), ...(options.signal ? { signal: options.signal } : {}) };
  const release = await fetchNativeRelease({ ...request, manifestUrl: trust.nativeManifestUrl, requestTimeoutMs: 30_000, maxCatalogBytes: METADATA_BYTES });
  const artifact = nativeArtifact(release, target);
  const planDigest = digest(Buffer.from(JSON.stringify({ version: release.version, target, ...artifact })));
  const plan = { status: 'native-download-confirmation-required', version: release.version, target, digest: planDigest, url: artifact.url, installationRequired: true };
  if (!options.confirmed) return plan;
  if (options.expectedVersion !== release.version || options.expectedDigest !== planDigest) throw new Error('The confirmed native plan differs; inspect a fresh plan before retrying');
  const compatibility = await inspectCompatibility(options.compatibility);
  const dshHome = compatibility.dshHome;
  if (!dshHome) throw new Error('Select the existing DSH home before downloading a native update');
  await assertManagedHome(dshHome);
  const managed = await ownedChild(dshHome, 'clawmaster-updates');
  const cacheDir = await ownedChild(managed, 'downloads');
  const file = await prepareNativeUpdate(release, target, { ...request, publicKey: trust.nativePublicKey, cacheDir, downloadTimeoutMs: 900_000, maxDownloadBytes: 2 * 1024 * 1024 * 1024 });
  const namedRoot = await ownedChild(managed, 'native-downloads');
  const filename = new URL(artifact.url).pathname.split('/').at(-1);
  if (!filename || dirname(filename) !== '.') throw new Error('Native manifest has no valid filename');
  const directory = await mkdtemp(join(namedRoot, '.stage-'));
  const path = join(directory, filename);
  try {
    await copyFile(file.path, path, constants.COPYFILE_EXCL);
    // Verify the user-facing copy independently before reporting it as ready for installation.
    const { verifyNativeFile } = await import('./native.ts');
    await verifyNativeFile(path, trust.nativePublicKey, artifact.signature, options.signal ?? AbortSignal.timeout(900_000));
    const committed = join(namedRoot, `verified-${directory.slice(directory.lastIndexOf('.stage-') + '.stage-'.length)}`);
    await rename(directory, committed);
    return { ...plan, status: file.status, path: join(committed, filename), sha256: file.sha256, size: file.size };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Fixed Office assets served by the existing authenticated DSH WebServer. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

declare const __OFFICE_RUNTIME_MANIFEST_SHA256__: string;
const MANIFEST = '.clawmaster-office-manifest.json';
const PREFIX = '/clawmaster/office/runtime';
const HTML_POLICY = "default-src 'self' blob: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' blob: data:; img-src 'self' blob: data:; font-src 'self' data:; frame-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; form-action 'none'; base-uri 'self'";
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  upstream: z.object({ repository: z.string().min(1), commit: z.string().min(1), releaseTag: z.string().min(1), archiveUrl: z.url(), archiveSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
}).strict();
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json',
  '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.gz': 'application/gzip', '.txt': 'text/plain; charset=utf-8',
};

/** Host plugin name. */
export const name = 'clawmaster-office';
/** Existing HTTP transport and browser authentication services. */
export const inject = ['webServer', 'connection'];

/** Packaged runtime is the default; a deployment may provide another verified absolute root. */
export interface Config { runtimeRoot?: string; }

interface Asset {
  path: string; sha256: string; size: number; dev: number; ino: number; mtimeMs: number; ctimeMs: number;
}
/** Verified resource whitelist and its canonical filesystem root. */
export interface OfficeRuntime { root: string; assets: ReadonlyMap<string, Readonly<Asset>>; }
/** Public DSH service subset used by the static Office route. */
export interface HostServices {
  connection: { requestRejection(request: IncomingMessage): 401 | 403 | undefined };
  webServer: { register(route: { kind: 'prefix'; path: string; handler(request: IncomingMessage, response: ServerResponse): Promise<void> }): () => void };
  effect(setup: () => Promise<() => Promise<void>>, label?: string): unknown;
}

function safeRelativePath(path: string): boolean {
  return !/[\\%?#:\x00-\x1f\x7f]/.test(path) && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}
function sameFile(a: Pick<Asset, 'size' | 'dev' | 'ino' | 'mtimeMs' | 'ctimeMs'>, b: Pick<Asset, 'size' | 'dev' | 'ino' | 'mtimeMs' | 'ctimeMs'>): boolean {
  return a.size === b.size && a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
async function openRegular(path: string): Promise<FileHandle> {
  if (await realpath(path) !== path) throw new Error('Office runtime contains a symbolic link.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  if (!(await file.stat()).isFile()) { await file.close(); throw new Error('Office runtime asset is not a regular file.'); }
  return file;
}

/**
 * Check the build-pinned manifest and every runtime file without buffering asset bodies.
 * @param runtimeRoot Absolute directory prepared from the pinned upstream archive.
 * @returns Canonical paths and file identities used to reject changes after startup.
 * @throws Error when the manifest, tree, or file bytes differ from the build.
 */
export async function verifyOfficeRuntime(runtimeRoot: string): Promise<OfficeRuntime> {
  if (!isAbsolute(runtimeRoot)) throw new Error('Office runtimeRoot must be absolute.');
  if (!(await lstat(runtimeRoot)).isDirectory()) throw new Error('Office runtimeRoot must be a real directory.');
  const root = await realpath(runtimeRoot);
  const manifestPath = join(root, MANIFEST);
  const manifestFile = await openRegular(manifestPath);
  let bytes: Buffer;
  try { bytes = await manifestFile.readFile(); } finally { await manifestFile.close(); }
  if (typeof __OFFICE_RUNTIME_MANIFEST_SHA256__ !== 'string'
    || createHash('sha256').update(bytes).digest('hex') !== __OFFICE_RUNTIME_MANIFEST_SHA256__) {
    throw new Error('Office runtime manifest differs from the build. Run prepare-runtime and rebuild the Office bundle.');
  }
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (!Object.hasOwn(manifest.files, 'index.html')) throw new Error('Office runtime manifest must include index.html.');
  const seen = new Set<string>();
  const walk = async (directory: string, relative: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else if (!entry.isFile()) throw new Error(`Office runtime entry must be a regular file: ${path}`);
      else if (path !== MANIFEST) seen.add(path);
    }
  };
  await walk(root, '');
  const assets = new Map<string, Asset>();
  for (const [relative, sha256] of Object.entries(manifest.files)) {
    if (!safeRelativePath(relative) || relative === MANIFEST) throw new Error(`Office manifest contains an invalid asset path: ${relative}`);
    if (!seen.delete(relative)) throw new Error(`Office runtime asset is missing: ${relative}`);
    const path = join(root, relative);
    const file = await openRegular(path);
    try {
      const before = await file.stat();
      const hash = createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await file.stat();
      if (!sameFile(before, after) || hash.digest('hex') !== sha256) throw new Error(`Office runtime asset differs from the manifest: ${relative}`);
      assets.set(relative, { path, sha256, size: after.size, dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs });
    } finally { await file.close(); }
  }
  if (seen.size) throw new Error(`Office runtime contains unlisted assets: ${[...seen].join(', ')}`);
  return { root, assets };
}

async function serve(runtime: OfficeRuntime, request: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { allow: 'GET, HEAD' }); response.end(); return; }
  const path = String(request.url).split('?', 1)[0]!;
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) { response.writeHead(404); response.end(); return; }
  const encoded = path.slice(PREFIX.length + 1);
  let relative: string;
  try { relative = decodeURIComponent(encoded || 'index.html'); }
  catch { response.writeHead(400); response.end(); return; }
  if (/%(?:2f|5c)/i.test(encoded) || !safeRelativePath(relative)) { response.writeHead(403); response.end(); return; }
  const asset = runtime.assets.get(relative);
  if (!asset) { response.writeHead(404); response.end(); return; }
  signal.throwIfAborted();
  const file = await openRegular(asset.path);
  try {
    if (!sameFile(asset, await file.stat())) throw new Error('Office runtime asset changed after startup. Restart with the verified Office bundle.');
    signal.throwIfAborted();
    response.writeHead(200, {
      'content-type': MIME[extname(asset.path).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(asset.size), 'cache-control': 'private, no-cache',
      'x-content-type-options': 'nosniff', etag: `"${asset.sha256}"`,
      ...(extname(asset.path).toLowerCase() === '.html' ? { 'content-security-policy': HTML_POLICY } : {}),
    });
    if (request.method === 'HEAD') { response.end(); return; }
    await pipeline(file.createReadStream({ autoClose: false }), response, { signal });
  } finally { await file.close(); }
}

/**
 * Mount only verified Office resources behind DSH's Host/Origin and browser-session checks.
 * Disposal unregisters the route, aborts streams, and waits for file handles to close.
 * @param ctx Existing DSH transport and effect owner; no server or Workspace is created.
 * @param config Optional absolute runtime root; its bytes must match this bundle's manifest digest.
 */
export async function apply(ctx: HostServices, config: Config = {}): Promise<void> {
  const runtimeRoot = config.runtimeRoot ?? fileURLToPath(new URL('../runtime/', import.meta.url));
  if (!isAbsolute(runtimeRoot)) throw new Error('Office runtimeRoot must be absolute.');
  await ctx.effect(async () => {
    const runtime = await verifyOfficeRuntime(resolve(runtimeRoot));
    const lifetime = new AbortController();
    const pending = new Set<Promise<void>>();
    const unregister = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler(request, response) {
      const rejection = ctx.connection.requestRejection(request);
      if (rejection !== undefined) { response.writeHead(rejection); response.end(); return Promise.resolve(); }
      if (lifetime.signal.aborted) { response.writeHead(503); response.end(); return Promise.resolve(); }
      const operation = serve(runtime, request, response, lifetime.signal);
      pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    } });
    return async () => { unregister(); lifetime.abort(); await Promise.allSettled([...pending]); };
  }, 'clawmaster-office: verified authenticated resources');
}

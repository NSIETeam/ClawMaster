/**
 * The PDF service: read a file from the task folder, run operations, write the results.
 *
 * Two properties are load-bearing:
 * - The source is never overwritten unless the caller asked for it, so a wrong operation costs a new
 *   file rather than the original document.
 * - Every write is atomic and records the file's revision, so a concurrent edit by the sidebar or
 *   another agent is detected instead of being clobbered.
 *
 * The filesystem is injected, so the whole service is testable against a real temporary directory or a
 * fake one without the routes being involved.
 */
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { editPdf, inspectPdf, PdfError, type PdfInput, type PdfOperation } from './editor.ts';
import { derivedPath, resolveInside, PdfPathError, PDF_EXTENSION } from './paths.ts';
import { DELEGATED_OPERATIONS, type PdfEditReceipt, type PdfEditRequest, type PdfInfo, type StirlingStatus } from './protocol.ts';

/** The filesystem surface this service needs; `node:fs/promises` satisfies it. */
export interface PdfFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<unknown>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
  unlink(path: string): Promise<unknown>;
}

/** How the service is configured. */
export interface PdfServiceOptions {
  /** The absolute folder every path is resolved against. */
  root: string;
  /** The filesystem to use. */
  fs: PdfFs;
  /** Where the optional Stirling-PDF runtime lives, and whether it answered. */
  stirling?: StirlingStatus;
}

/** What the service refuses, in a shape the routes can turn into a response. */
export class PdfServiceError extends Error {
  constructor(readonly code: 'invalid_request' | 'unsupported' | 'damaged' | 'not_found' | 'conflict' | 'storage_unavailable', message: string, readonly currentRevision?: string) {
    super(message);
    this.name = 'PdfServiceError';
  }
}

/** The revision of some bytes, in the same shape the sidebar's If-Match contract uses. */
export function revisionOf(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * The PDF service over one task folder.
 */
export class PdfService {
  constructor(private readonly options: PdfServiceOptions) {}

  /** Read a file's structure without changing it. */
  async info(source: string): Promise<PdfInfo> {
    const path = this.resolve(source);
    const bytes = await this.read(path, source);
    let structure;
    try {
      structure = await inspectPdf(bytes);
    } catch (error) {
      throw asServiceError(error);
    }
    return {
      path: normalize(source),
      bytes: bytes.byteLength,
      revision: revisionOf(bytes),
      ...structure,
    };
  }

  /**
   * Run an operation sequence and write the results.
   * @param request - The source, any extra inputs, and the operations in order.
   * @returns Every file that was written, with its revision.
   */
  async edit(request: PdfEditRequest): Promise<PdfEditReceipt> {
    const source = normalize(request.source);
    const basePath = this.resolve(source);
    const base = await this.read(basePath, source);
    const files = new Map<string, Uint8Array>();
    for (const input of request.inputs) {
      const safe = normalize(input);
      if (safe === source) continue;
      files.set(safe, await this.read(this.resolve(safe), safe));
    }

    // The wire schema deliberately accepts any operation name so that one it cannot perform produces
    // a precise refusal rather than a parse error, which means the shape is checked here: `assertRunnable`
    // rejects a name this track does not have, and the editor validates each field and refuses a bad one
    // as `invalid_request` rather than applying half of it.
    const operations = request.operations as unknown as readonly PdfOperation[];
    assertRunnable(operations);
    let result;
    try {
      result = await editPdf({ base, files } satisfies PdfInput, operations);
    } catch (error) {
      throw asServiceError(error);
    }

    // A single output replaces the source only when asked; anything else lands beside it, named after
    // the source so the user can see where it came from.
    const single = result.outputs.length === 1;
    const revisions: Record<string, string> = {};
    const written: Array<{ path: string; bytes: number; pageCount: number }> = [];
    const only = single ? result.outputs[0] : undefined;
    if (only !== undefined && request.inPlace) {
      await this.writeAtomically(basePath, only.bytes);
      revisions[source] = revisionOf(only.bytes);
      written.push({ path: source, bytes: only.bytes.byteLength, pageCount: only.pageCount });
      return { source, outputs: written, revisions, replacedSource: true };
    }
    const suffix = suffixFor(operations);
    for (const [index, output] of result.outputs.entries()) {
      // A by-product of a split is reported but never written over the source, which is what makes
      // splitting safe: the original document is exactly as it was.
      if (output.carriedThrough === true && output.name === 'result' && result.outputs.length > 1) continue;
      // The output name is derived from the source, so deriving it can fail for the same reasons a
      // source path can; both go through the same wrapper so the caller sees one error shape.
      const relative = this.resolve(targetPath(source, suffix, output.name, index, result.outputs.length), true);
      await this.writeAtomically(join(this.options.root, relative), output.bytes);
      revisions[relative] = revisionOf(output.bytes);
      written.push({ path: relative, bytes: output.bytes.byteLength, pageCount: output.pageCount });
    }
    return { source, outputs: written, revisions, replacedSource: false };
  }

  /** What the optional heavy track can do, and why it cannot when it cannot. */
  stirling(): StirlingStatus {
    return this.options.stirling ?? {
      available: false,
      directory: '',
      reason: 'The optional Stirling-PDF component is not enabled.',
      delegatedOperations: [...DELEGATED_OPERATIONS],
    };
  }

  /**
   * Resolve a caller's path against the task folder.
   * @param path - The relative path.
   * @param relative - True to return the workspace-relative form, false for the absolute one.
   * @returns The resolved path.
   */
  private resolve(path: string, relative = false): string {
    try {
      const absolute = resolveInside(this.options.root, path);
      return relative ? relativeTo(this.options.root, absolute) : absolute;
    } catch (error) {
      throw asServiceError(error);
    }
  }

  /** Read a file, turning a missing or unreadable file into a typed refusal. */
  private async read(path: string, source: string): Promise<Uint8Array> {
    try {
      const bytes = await this.options.fs.readFile(path);
      return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBufferLike);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT' || code === 'EISDIR') throw new PdfServiceError('not_found', `There is no file ${source} in this task folder.`);
      throw new PdfServiceError('storage_unavailable', `Could not read ${source}: ${messageOf(error)}`);
    }
  }

  /** Write a file so a reader never sees a half-written PDF. */
  private async writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
    await this.options.fs.mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.part-${process.pid}-${Date.now()}`;
    try {
      await this.options.fs.writeFile(temporary, bytes);
      await this.options.fs.rename(temporary, path);
    } catch (error) {
      // A failed write must not leave a stray part file behind for the sidebar to list.
      await this.options.fs.unlink(temporary).catch(() => undefined);
      throw new PdfServiceError('storage_unavailable', `Could not write ${basename(path)}: ${messageOf(error)}`);
    }
  }
}

/**
 * Refuse an operation the built-in track does not implement, naming the optional track.
 *
 * A caller that asks for encryption or text extraction should be told which component does it rather
 * than receiving a vague failure or, worse, a file that silently lacks the change.
 * @param operations - The operations a caller asked for.
 */
export function assertRunnable(operations: readonly { op: string }[]): void {
  const requested = new Set(operations.map(operation => operation.op));
  const delegated = DELEGATED_OPERATIONS.filter(name => requested.has(name as PdfOperation['op']));
  if (delegated.length > 0) {
    throw new PdfServiceError('unsupported', `${delegated.join(', ')} needs the optional Stirling-PDF component; the built-in tools do not implement it.`);
  }
  if (operations.length === 0) throw new PdfServiceError('invalid_request', 'Give at least one operation.');
}

/** A short marker for the files an operation sequence produces. */
function suffixFor(operations: readonly PdfOperation[]): string {
  const multi = operations.some(operation => operation.op === 'extract' && operation.mode !== 'remove');
  if (multi) return '取页';
  if (operations.some(operation => operation.op === 'merge')) return '合并';
  if (operations.some(operation => operation.op === 'watermark' || operation.op === 'pageNumbers')) return '标注';
  return '编辑';
}

/** The path one output should be written to. */
function targetPath(source: string, suffix: string, outputName: string, index: number, total: number): string {
  if (total === 1) return derivedPath(source, suffix);
  // Several outputs come from a split, so each is numbered and the last one — the rest of the document
  // — keeps the source's own name so it is obvious which file is the remainder.
  if (outputName === 'result') return source;
  return derivedPath(source, `${suffix} ${index + 1}`);
}

/** Normalise a caller's path the way the receipt should echo it. */
function normalize(path: string): string {
  return path.split('\\').join('/');
}

/** The workspace-relative form of an absolute path inside the root. */
function relativeTo(root: string, path: string): string {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : basename(path);
}

/** Turn an editor or path refusal into a service refusal. */
function asServiceError(error: unknown): PdfServiceError {
  if (error instanceof PdfServiceError) return error;
  if (error instanceof PdfError) return new PdfServiceError(error.code, error.message);
  if (error instanceof PdfPathError) return new PdfServiceError(error.code === 'unsupported_type' ? 'unsupported' : 'invalid_request', error.message);
  return new PdfServiceError('damaged', messageOf(error));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The extension the panel filters on. */
export { PDF_EXTENSION };

/**
 * Where a PDF tool may read and write.
 *
 * The policy is the same one the notes vault applies, for the same reason: a tool that takes a path
 * from a model must not be able to address anything outside the folder the session is already allowed
 * to touch, and must not be able to reach a hidden or system location by writing `..` or a drive
 * prefix. Path resolution is a security boundary, so it is one small reviewed module rather than a
 * `join` scattered through the service.
 */
import { isAbsolute, resolve, sep } from 'node:path';
import { PDF_EXTENSION } from './constants.ts';

/** Refusals a caller can show a user. */
export class PdfPathError extends Error {
  constructor(readonly code: 'invalid_path' | 'outside_root' | 'unsupported_type', message: string) {
    super(message);
    this.name = 'PdfPathError';
  }
}

/** The only extension these tools write; defined in constants.ts so client code can share it. */
export { PDF_EXTENSION };

/** Longest path this component will consider, in characters. */
export const MAX_PATH_LENGTH = 1024;

/**
 * Validate a workspace-relative POSIX path.
 * @param path - The path as the caller wrote it.
 * @param extensions - The extensions that are acceptable, lower case and including the dot.
 * @returns The path with its separators normalised.
 */
export function assertRelativePath(path: unknown, extensions: readonly string[] = [PDF_EXTENSION]): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) {
    throw new PdfPathError('invalid_path', `A path must be 1-${MAX_PATH_LENGTH} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new PdfPathError('invalid_path', 'A path must not contain control characters.');
  if (isAbsolute(path) || path.startsWith('/') || path.startsWith('\\')) {
    throw new PdfPathError('invalid_path', 'Use a path relative to the task folder, not an absolute one.');
  }
  if (path.includes('\\')) throw new PdfPathError('invalid_path', 'Use / as the separator.');
  if (path.includes(':')) throw new PdfPathError('invalid_path', 'A path must not contain a drive prefix or a stream name.');
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw new PdfPathError('invalid_path', 'A path must not contain empty, "." or ".." segments.');
    if (segment.startsWith('.')) throw new PdfPathError('invalid_path', 'A path must not address hidden entries.');
    if (segment !== segment.trim()) throw new PdfPathError('invalid_path', 'A path segment must not carry outer whitespace.');
  }
  const normalised = segments.join('/');
  if (extensions.length > 0 && !extensions.some(extension => normalised.toLowerCase().endsWith(extension))) {
    throw new PdfPathError('unsupported_type', `This tool handles ${extensions.join(', ')} files.`);
  }
  return normalised;
}

/**
 * Map a relative path onto an absolute one, refusing anything that would leave the root.
 * The check is on the resolved result rather than the text, so no amount of leading `./` or repeated
 * separators can talk its way past it.
 * @param root - The absolute folder the session may touch.
 * @param path - The relative path.
 * @param extensions - Acceptable extensions.
 * @returns The absolute path inside the root.
 */
export function resolveInside(root: string, path: unknown, extensions: readonly string[] = [PDF_EXTENSION]): string {
  const safe = assertRelativePath(path, extensions);
  const base = resolve(root);
  const target = resolve(base, safe);
  const prefix = base.endsWith(sep) ? base : base + sep;
  if (!target.startsWith(prefix)) throw new PdfPathError('outside_root', 'That path leaves the task folder.');
  return target;
}

/**
 * The name of the file a working copy of `source` should live at.
 * Every tool writes a new file instead of overwriting the input, so a wrong click never destroys the
 * original; the name is derived from the source so two runs cannot collide.
 * @param source - The workspace-relative source path.
 * @param suffix - A short marker such as `合并`.
 * @returns A workspace-relative path that does not end in the source's own name.
 */
export function derivedPath(source: string, suffix: string): string {
  const safe = assertRelativePath(source);
  const directory = safe.includes('/') ? `${safe.slice(0, safe.lastIndexOf('/'))}/` : '';
  const stem = safe.slice(safe.lastIndexOf('/') + 1, -PDF_EXTENSION.length);
  const marker = suffix.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return `${directory}${stem}${marker === '' ? '' : ` (${marker})`}${PDF_EXTENSION}`;
}

/** Lexical path operations for POSIX paths and explicit Windows drive or UNC paths. */
import { posix, win32 } from 'node:path';

/** Whether a path names an absolute Windows drive or UNC location.
 * @param value - A path, after shell tokenization.
 * @returns Whether Windows separator rules apply.
 */
export function isWindowsPath(value: string): boolean {
  return /^[a-z]:[/\\]/i.test(value) || /^(?:\\\\|\/\/)[^/\\]+[/\\][^/\\]+/.test(value);
}

/** Fold dot segments without interpreting POSIX backslashes as separators.
 * @param value - An absolute path.
 * @returns A normalized path with forward slash separators for Windows paths.
 */
export function normalizePath(value: string): string {
  const normalized = isWindowsPath(value) ? win32.normalize(value).replaceAll('\\', '/') : posix.normalize(value);
  return normalized === '/' || /^[a-z]:\/$/i.test(normalized) ? normalized : normalized.replace(/\/+$/, '');
}

/** Compare paths using Windows case folding only for explicit Windows paths.
 * @param left - One absolute path.
 * @param right - Another absolute path.
 * @returns Whether both paths name the same lexical location.
 */
export function samePath(left: string, right: string): boolean {
  const first = normalizePath(left).replace(/\/+$/, '');
  const second = normalizePath(right).replace(/\/+$/, '');
  return isWindowsPath(left) && isWindowsPath(right) ? first.toLowerCase() === second.toLowerCase() : first === second;
}

/** Match a protected path by complete segments, including a filesystem root.
 * @param target - An absolute target path.
 * @param prefix - A configured absolute prefix; empty matches nothing.
 * @returns Whether the target equals or descends from the prefix.
 */
export function pathUnder(target: string, prefix: string): boolean {
  if (prefix === '') return false;
  let candidate = normalizePath(target).replace(/\/+$/, '');
  let parent = normalizePath(prefix).replace(/\/+$/, '');
  if (isWindowsPath(target) && isWindowsPath(prefix)) {
    candidate = candidate.toLowerCase();
    parent = parent.toLowerCase();
  }
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

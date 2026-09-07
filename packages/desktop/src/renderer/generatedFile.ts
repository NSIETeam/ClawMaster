/** Only the native runtime may attach a verified generatedFile descriptor. */
export function generatedFilePath(status: string, result: unknown): string | null {
  if (status !== 'succeeded' || !result || typeof result !== 'object') return null;
  const descriptor = (result as { generatedFile?: unknown }).generatedFile;
  if (!descriptor || typeof descriptor !== 'object') return null;
  const path = (descriptor as { path?: unknown }).path;
  return typeof path === 'string' && /^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(path) && !path.includes('\0')
    ? path : null;
}

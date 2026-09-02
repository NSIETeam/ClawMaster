const DEFAULT_MAX_RESIDENT_ENTRY_BYTES = 4 * 1024 * 1024;

export function evaluateAgentBundleLayout(
  manifest,
  metafile,
  { maxResidentEntryBytes = DEFAULT_MAX_RESIDENT_ENTRY_BYTES } = {},
) {
  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error('Agent bundle manifest is missing its file inventory');
  }
  if (!metafile || !metafile.outputs || typeof metafile.outputs !== 'object') {
    throw new Error('Agent bundle is missing its esbuild dependency graph');
  }
  const inventory = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const outputPaths = new Map();
  for (const outputPath of Object.keys(metafile.outputs)) {
    const normalized = outputPath.replaceAll('\\', '/');
    const marker = '/agent-payload/';
    outputPaths.set(normalized.includes(marker) ? normalized.split(marker).at(-1) : normalized, outputPath);
  }
  const serverOutput = outputPaths.get('server.mjs');
  if (!serverOutput) {
    throw new Error('Agent bundle is missing its resident server entry');
  }
  const resident = new Set();
  const visit = (outputPath) => {
    if (resident.has(outputPath)) return;
    resident.add(outputPath);
    const output = metafile.outputs[outputPath];
    for (const imported of output?.imports ?? []) {
      if (imported.external || imported.kind === 'dynamic-import') continue;
      const normalized = imported.path.replaceAll('\\', '/').replace(/^\.\//u, '');
      const target = outputPaths.get(normalized)
        ?? [...outputPaths.entries()].find(([relative]) => relative.endsWith(`/${normalized}`))?.[1];
      if (target) visit(target);
    }
  };
  visit(serverOutput);
  const residentPaths = [...resident].map((outputPath) => {
    const normalized = outputPath.replaceAll('\\', '/');
    const marker = '/agent-payload/';
    return normalized.includes(marker) ? normalized.split(marker).at(-1) : normalized;
  });
  const residentEntryBytes = residentPaths.reduce((total, filePath) => {
    const entry = inventory.get(filePath);
    if (!entry || !Number.isSafeInteger(entry.bytes)) {
      throw new Error(`Agent bundle graph references missing output: ${filePath}`);
    }
    return total + entry.bytes;
  }, 0);
  if (residentEntryBytes > maxResidentEntryBytes) {
    throw new Error(
      `Agent resident closure exceeds ${maxResidentEntryBytes} bytes: ${residentEntryBytes}`,
    );
  }
  const chunks = manifest.files.filter(
    (entry) => entry.path.startsWith('chunks/')
      && entry.path.endsWith('.mjs')
      && !residentPaths.includes(entry.path),
  );
  if (chunks.length === 0) {
    throw new Error('Agent bundle is missing deferred capability chunks');
  }
  return {
    residentEntryBytes,
    residentFileCount: residentPaths.length,
    deferredChunkBytes: chunks.reduce((total, entry) => total + entry.bytes, 0),
    deferredChunkCount: chunks.length,
  };
}

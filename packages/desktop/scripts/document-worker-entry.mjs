import { once } from 'node:events';
import { exportEditedDocument, extractEditableDocument } from 'otto-core';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
await once(process.stdin, 'end');

try {
  const request = JSON.parse(input);
  const result = request.operation === 'extract'
    ? await extractEditableDocument(request.filePath)
    : request.operation === 'export'
      ? await exportEditedDocument(request.sourcePath, request.content, request.outPath)
      : (() => { throw new Error('unsupported document worker operation'); })();
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
}

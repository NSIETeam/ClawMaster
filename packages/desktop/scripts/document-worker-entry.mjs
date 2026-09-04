import { once } from 'node:events';
import { exportEditedDocument, extractEditableDocument } from 'clawmaster-core';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
await once(process.stdin, 'end');

let exitCode = 0;
let response;
try {
  const request = JSON.parse(input);
  const result = request.operation === 'extract'
    ? await extractEditableDocument(request.filePath)
    : request.operation === 'export'
      ? await exportEditedDocument(request.sourcePath, request.content, request.outPath)
      : (() => { throw new Error('unsupported document worker operation'); })();
  response = { ok: true, result };
} catch (error) {
  exitCode = 1;
  response = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

await new Promise((resolve, reject) => {
  process.stdout.write(JSON.stringify(response), (error) => {
    if (error) reject(error);
    else resolve();
  });
});
// This worker serves exactly one request. Exit even if imported dependencies
// retain background handles, otherwise synchronous desktop callers can hang.
process.exit(exitCode);

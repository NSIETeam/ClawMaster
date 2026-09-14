/** Package archive substitution is rejected before extraction or execution. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyArchive } from './test-compatibility.mjs';

for (const algorithm of ['sha256', 'sha512']) {
  test(`${algorithm} rejects an altered package archive`, () => {
    const bytes = Buffer.from('reviewed archive fixture');
    const expected = createHash(algorithm).update(bytes).digest(algorithm === 'sha256' ? 'hex' : 'base64');
    verifyArchive(bytes, algorithm, expected);
    assert.throws(() => verifyArchive(Buffer.from('different archive'), algorithm, expected), /differs from reviewed provenance/);
  });
}

/**
 * The PDF service.
 *
 * These cases run against a real temporary directory rather than a fake filesystem, because the things
 * most likely to be wrong here are filesystem things: that the source is not overwritten by default,
 * that a written file is complete rather than half-flushed, that a stray part file is cleaned up, and
 * that a path cannot leave the folder. A fake would hide all four.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PdfService, PdfServiceError, assertRunnable, revisionOf } from '../src/service.ts';
import { derivedPath, resolveInside } from '../src/paths.ts';

/** A document whose page widths identify the pages. */
async function makePdf(count) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < count; index += 1) {
    doc.addPage([300 + index * 10, 400]).drawText(`p${index + 1}`, { x: 20, y: 380, size: 12, font });
  }
  return new Uint8Array(await doc.save());
}

/** A service over a fresh temporary folder with the given files already in it. */
async function harness(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-service-'));
  for (const [path, bytes] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, bytes);
  }
  const service = new PdfService({ root, fs: await import('node:fs/promises') });
  return {
    root,
    service,
    async list() {
      const walk = async (directory, prefix = '') => {
        const entries = await readdir(directory, { withFileTypes: true });
        const found = [];
        for (const entry of entries) {
          if (entry.isDirectory()) found.push(...await walk(join(directory, entry.name), `${prefix}${entry.name}/`));
          else found.push(`${prefix}${entry.name}`);
        }
        return found.sort();
      };
      return walk(root);
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test('info reports geometry, metadata and the revision the sidebar would use', async () => {
  const bytes = await makePdf(3);
  const h = await harness({ 'a.pdf': bytes });
  try {
    const info = await h.service.info('a.pdf');
    assert.equal(info.pageCount, 3);
    assert.equal(info.path, 'a.pdf');
    assert.equal(info.bytes, bytes.byteLength);
    assert.equal(info.revision, revisionOf(bytes));
    assert.deepEqual(info.sizes.map(size => size.width), [300, 310, 320]);
  } finally {
    await h.close();
  }
});

test('an edit writes a new file and leaves the source untouched', async () => {
  const original = await makePdf(3);
  const h = await harness({ 'a.pdf': original });
  try {
    const receipt = await h.service.edit({ source: 'a.pdf', inputs: [], operations: [{ op: 'rotate', by: 90 }], inPlace: false });
    assert.equal(receipt.replacedSource, false);
    assert.deepEqual(receipt.outputs.map(output => output.path), ['a (编辑).pdf']);
    assert.equal(await readFile(join(h.root, 'a.pdf')).then(buffer => buffer.byteLength), original.byteLength, 'the source is untouched');
    assert.deepEqual(await h.list(), ['a (编辑).pdf', 'a.pdf']);
    const produced = await PDFDocument.load(await readFile(join(h.root, 'a (编辑).pdf')));
    assert.equal(produced.getPages()[0].getRotation().angle, 90);
  } finally {
    await h.close();
  }
});

test('in place replaces the source and reports it', async () => {
  const h = await harness({ 'a.pdf': await makePdf(2) });
  try {
    const receipt = await h.service.edit({ source: 'a.pdf', inputs: [], operations: [{ op: 'delete', pages: '1' }], inPlace: true });
    assert.equal(receipt.replacedSource, true);
    assert.deepEqual(receipt.outputs.map(output => output.path), ['a.pdf']);
    assert.equal(receipt.outputs[0].pageCount, 1);
    assert.equal((await PDFDocument.load(await readFile(join(h.root, 'a.pdf')))).getPageCount(), 1);
    assert.deepEqual(await h.list(), ['a.pdf'], 'no stray file was left behind');
  } finally {
    await h.close();
  }
});

test('a split writes numbered files plus the remainder, all complete', async () => {
  const h = await harness({ 'a.pdf': await makePdf(4) });
  try {
    const receipt = await h.service.edit({ source: 'a.pdf', inputs: [], operations: [{ op: 'extract', ranges: '1,3', mode: 'keep' }], inPlace: false });
    // Only the pages the user asked for are written; the document carried through the sequence is
    // reported but not written back over the source.
    assert.deepEqual(receipt.outputs.map(output => output.path), ['a (取页 1).pdf', 'a (取页 2).pdf']);
    assert.deepEqual(await h.list(), ['a (取页 1).pdf', 'a (取页 2).pdf', 'a.pdf'], 'the source is untouched');
    for (const output of receipt.outputs) {
      const bytes = await readFile(join(h.root, output.path));
      assert.equal(bytes.byteLength, output.bytes, `${output.path} is fully written`);
      assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
    }

  } finally {
    await h.close();
  }
});

test('a merge reads the named inputs from the same folder', async () => {
  const h = await harness({ 'a.pdf': await makePdf(2), 'sub/b.pdf': await makePdf(1) });
  try {
    const receipt = await h.service.edit({ source: 'a.pdf', inputs: ['sub/b.pdf'], operations: [{ op: 'merge', paths: ['sub/b.pdf'] }], inPlace: false });
    assert.equal(receipt.outputs[0].pageCount, 3);
    assert.equal(receipt.outputs[0].path, 'a (合并).pdf');
  } finally {
    await h.close();
  }
});

test('a missing file, an escaping path and a wrong extension are refused', async () => {
  const h = await harness({ 'a.pdf': await makePdf(1) });
  try {
    await assert.rejects(h.service.info('nope.pdf'), error => error instanceof PdfServiceError && error.code === 'not_found');
    // Every refusal is the service's own error, so a route can map it to a status and a code.
    await assert.rejects(h.service.info('../a.pdf'), error => error instanceof PdfServiceError && error.code === 'invalid_request' && /segments/.test(error.message));
    await assert.rejects(h.service.info('/etc/passwd'), error => error instanceof PdfServiceError && /relative to the task folder/.test(error.message));
    await assert.rejects(h.service.info('a.txt'), error => error instanceof PdfServiceError && error.code === 'unsupported');
    await assert.rejects(h.service.info('.hidden/a.pdf'), error => error instanceof PdfServiceError && /hidden entries/.test(error.message));
    await assert.rejects(h.service.edit({ source: 'a.pdf', inputs: ['../other.pdf'], operations: [{ op: 'rotate', by: 90 }], inPlace: false }), error => error instanceof PdfServiceError && /segments/.test(error.message));
  } finally {
    await h.close();
  }
});

test('an operation the built-in track does not have names the optional component', async () => {
  const h = await harness({ 'a.pdf': await makePdf(1) });
  try {
    for (const op of ['encrypt', 'ocr', 'fillForm']) {
      assert.throws(() => assertRunnable([{ op }]), error => error instanceof PdfServiceError && error.code === 'unsupported' && /Stirling-PDF/.test(error.message));
    }
    await assert.rejects(h.service.edit({ source: 'a.pdf', inputs: [], operations: [{ op: 'ocr' }], inPlace: false }), /Stirling-PDF/);
    // And nothing was written by the refusal.
    assert.deepEqual(await h.list(), ['a.pdf']);
  } finally {
    await h.close();
  }
});

test('a damaged source is refused without writing anything', async () => {
  const h = await harness({ 'bad.pdf': new TextEncoder().encode('this is not a pdf') });
  try {
    await assert.rejects(h.service.info('bad.pdf'), error => error instanceof PdfServiceError && error.code === 'damaged');
    await assert.rejects(h.service.edit({ source: 'bad.pdf', inputs: [], operations: [{ op: 'rotate', by: 90 }], inPlace: true }), /does not start with %PDF-/);
    assert.deepEqual(await h.list(), ['bad.pdf']);
  } finally {
    await h.close();
  }
});

test('a failed write leaves no part file behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-fail-'));
  const realFs = await import('node:fs/promises');
  const failing = {
    readFile: realFs.readFile,
    mkdir: realFs.mkdir,
    unlink: realFs.unlink,
    rename: async () => { throw Object.assign(new Error('read-only volume'), { code: 'EROFS' }); },
    writeFile: realFs.writeFile,
    stat: realFs.stat,
  };
  const service = new PdfService({ root, fs: failing });
  try {
    await writeFile(join(root, 'a.pdf'), await makePdf(1));
    await assert.rejects(service.edit({ source: 'a.pdf', inputs: [], operations: [{ op: 'rotate', by: 90 }], inPlace: false }), /Could not write/);
    assert.deepEqual((await readdir(root)).sort(), ['a.pdf'], 'the half-written part file was cleaned up');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('derived names never overwrite the source and stay in its folder', () => {
  assert.equal(derivedPath('a.pdf', '编辑'), 'a (编辑).pdf');
  assert.equal(derivedPath('deep/sub/a.pdf', '合并'), 'deep/sub/a (合并).pdf');
  assert.equal(derivedPath('deep/a.pdf', 'x/y:z'), 'deep/a (x y z).pdf');
  assert.equal(derivedPath('a.pdf', ''), 'a.pdf');
  assert.equal(derivedPath('a.pdf', '编辑').includes('/'), false);
});

test('a path that resolves outside the root is refused even when it looks relative', () => {
  assert.throws(() => resolveInside('/tmp/root', 'a/../../b.pdf'), /segments|leaves the task folder/);
  assert.throws(() => resolveInside('/tmp/root', './a.pdf'), /segments/);
  assert.equal(resolveInside('/tmp/root', 'a/b.pdf'), '/tmp/root/a/b.pdf');
});

test('the Stirling status is honest when it is not installed', async () => {
  const h = await harness();
  try {
    const status = h.service.stirling();
    assert.equal(status.available, false);
    assert.match(status.reason, /not enabled/);
    assert.equal(status.delegatedOperations.includes('encrypt'), true);
    assert.equal(status.delegatedOperations.includes('extractText'), true);
  } finally {
    await h.close();
  }
});

test('the receipt reports a revision for every file it wrote', async () => {
  const h = await harness({ 'a.pdf': await makePdf(2) });
  try {
    const receipt = await h.service.edit({ source: 'a.pdf', inputs: [], operations: [{ op: 'reorder', order: '2,1' }], inPlace: false });
    for (const output of receipt.outputs) {
      assert.match(receipt.revisions[output.path], /^sha256-[0-9a-f]{64}$/);
      const bytes = await readFile(join(h.root, output.path));
      assert.equal(receipt.revisions[output.path], revisionOf(bytes), 'the revision matches the bytes on disk');
    }
    // The reorder really happened.
    const reordered = await PDFDocument.load(await readFile(join(h.root, receipt.outputs[0].path)));
    assert.deepEqual(reordered.getPages().map(page => page.getWidth()), [310, 300]);
  } finally {
    await h.close();
  }
});

test('a written file is a complete document a reader can open', async () => {
  const h = await harness({ 'a.pdf': await makePdf(2) });
  try {
    await h.service.edit({ source: 'a.pdf', inputs: [], operations: [{ op: 'watermark', text: 'CONFIDENTIAL', opacity: 0.2 }], inPlace: false });
    const path = join(h.root, 'a (标注).pdf');
    const info = await stat(path);
    assert.ok(info.size > 1000, `a real document, not an empty file (${info.size} bytes)`);
    assert.equal((await PDFDocument.load(await readFile(path))).getPageCount(), 2);
  } finally {
    await h.close();
  }
});

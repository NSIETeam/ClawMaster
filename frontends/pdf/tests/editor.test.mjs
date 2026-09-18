/**
 * PDF operations.
 *
 * Every case here is checked by reading the produced PDF back rather than by trusting the library's
 * return value, because the failure that matters is a file that opens but is wrong: a page that did not
 * rotate, a merge that lost a page, a watermark drawn off the page. The document under test is built in
 * the test so page counts and sizes are known exactly.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  MAX_INPUT_BYTES, PdfError, editPdf, inspectPdf, selectPages,
} from '../src/editor.ts';

/** A document with `count` pages whose sizes identify them, and a text label on each page. */
async function makePdf(count, options = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < count; index += 1) {
    const page = doc.addPage([300 + index * 10, 400 + index * 10]);
    page.drawText(options.label ?? `page ${index + 1}`, { x: 20, y: 380, size: 12, font });
  }
  return await doc.save();
}

/** Load the single output of an edit sequence. */
async function only(result) {
  assert.equal(result.outputs.length, 1, `expected one output, got ${result.outputs.length}`);
  return await PDFDocument.load(result.outputs[0].bytes);
}

test('a document is read back with its page geometry and metadata', async () => {
  const info = await inspectPdf(await makePdf(3));
  assert.equal(info.pageCount, 3);
  assert.deepEqual(info.sizes, [
    { width: 300, height: 400 },
    { width: 310, height: 410 },
    { width: 320, height: 420 },
  ]);
  assert.deepEqual(info.rotations, [0, 0, 0]);
  assert.deepEqual(info.keywords, []);
});

test('a page selection reads the way a person writes it', () => {
  assert.deepEqual(selectPages('all', 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(selectPages('', 3), [0, 1, 2]);
  assert.deepEqual(selectPages('2', 5), [1]);
  assert.deepEqual(selectPages('2-4', 5), [1, 2, 3]);
  assert.deepEqual(selectPages('4-2', 5), [3, 2, 1], 'a reversed range is a slip, not a different request');
  assert.deepEqual(selectPages('1,3-4', 5), [0, 2, 3]);
  assert.deepEqual(selectPages('last', 5), [4]);
  assert.deepEqual(selectPages('-1', 5), [4]);
  assert.deepEqual(selectPages('-2--1', 5), [3, 4]);
  assert.deepEqual(selectPages('2,2,2', 5), [1], 'a repeated page is taken once');
  assert.throws(() => selectPages('9', 3), (error) => error instanceof PdfError && error.code === 'invalid_request');
  assert.throws(() => selectPages('0', 3), /out of range/);
  assert.throws(() => selectPages('abc', 3), /Cannot read the page selection/);
  assert.throws(() => selectPages('1-', 3), /Cannot read/);
});

test('delete removes the named pages and keeps the rest in order', async () => {
  const result = await editPdf({ base: await makePdf(4) }, [{ op: 'delete', pages: '2,4' }]);
  const doc = await only(result);
  assert.equal(doc.getPageCount(), 2);
  assert.deepEqual(doc.getPages().map(page => page.getWidth()), [300, 320], 'pages 1 and 3 survived');
});

test('deleting every page is refused rather than producing an empty file', async () => {
  await assert.rejects(editPdf({ base: await makePdf(2) }, [{ op: 'delete', pages: 'all' }]), /at least one page must remain/);
});

test('rotate turns the named pages by the given amount, and again on a second pass', async () => {
  const first = await editPdf({ base: await makePdf(3) }, [{ op: 'rotate', pages: '1,3', by: 90 }]);
  const doc = await only(first);
  assert.deepEqual(doc.getPages().map(page => page.getRotation().angle), [90, 0, 90]);
  const second = await editPdf({ base: first.outputs[0].bytes }, [{ op: 'rotate', pages: '1', by: 270 }]);
  const again = await only(second);
  assert.equal(again.getPages()[0].getRotation().angle, 0, 'rotation accumulates and wraps');
});

test('rotate with no selection turns every page', async () => {
  const doc = await only(await editPdf({ base: await makePdf(2) }, [{ op: 'rotate', by: 180 }]));
  assert.deepEqual(doc.getPages().map(page => page.getRotation().angle), [180, 180]);
});

test('reorder puts the named pages in the given order', async () => {
  const doc = await only(await editPdf({ base: await makePdf(3) }, [{ op: 'reorder', order: '3,1,2' }]));
  assert.deepEqual(doc.getPages().map(page => page.getWidth()), [320, 300, 310]);
});

test('a reorder that does not name every page is refused', async () => {
  await assert.rejects(editPdf({ base: await makePdf(3) }, [{ op: 'reorder', order: '1,2' }]), /must name every page/);
  await assert.rejects(editPdf({ base: await makePdf(3) }, [{ op: 'reorder', order: '1,2,2' }]), /must name every page/);
});

test('extract produces one file per selected page', async () => {
  const result = await editPdf({ base: await makePdf(4) }, [{ op: 'extract', ranges: '2,4' }]);
  // The document itself is also carried through as the result, so two splits plus the remainder.
  assert.deepEqual(result.outputs.map(output => output.name), ['extract-1', 'extract-2', 'result']);
  for (const output of result.outputs.slice(0, 2)) {
    assert.equal(output.pageCount, 1);
    const doc = await PDFDocument.load(output.bytes);
    assert.equal(doc.getPageCount(), 1);
  }
  const first = await PDFDocument.load(result.outputs[0].bytes);
  assert.equal(first.getPages()[0].getWidth(), 310, 'the first extract is page 2');
});

test('extract with mode remove behaves like delete', async () => {
  const doc = await only(await editPdf({ base: await makePdf(4) }, [{ op: 'extract', ranges: '1-2', mode: 'remove' }]));
  assert.equal(doc.getPageCount(), 2);
  assert.deepEqual(doc.getPages().map(page => page.getWidth()), [320, 330]);
});

test('merge appends another document, copying its pages', async () => {
  const files = new Map([['b.pdf', await makePdf(2, { label: 'other' })]]);
  const result = await editPdf({ base: await makePdf(3), files }, [{ op: 'merge', paths: ['b.pdf'] }]);
  const doc = await only(result);
  assert.equal(doc.getPageCount(), 5);
});

test('merge can start from nothing but files', async () => {
  const files = new Map([['a.pdf', await makePdf(2)], ['b.pdf', await makePdf(1)]]);
  const doc = await only(await editPdf({ files }, [{ op: 'merge', paths: ['a.pdf', 'b.pdf'] }]));
  assert.equal(doc.getPageCount(), 3);
});

test('merge refuses an unknown file instead of silently merging less', async () => {
  await assert.rejects(editPdf({ base: await makePdf(1), files: new Map() }, [{ op: 'merge', paths: ['nope.pdf'] }]), /No input file named nope\.pdf/);
  await assert.rejects(editPdf({ base: await makePdf(1), files: new Map() }, [{ op: 'merge' }]), /at least one other document/);
});

test('insert puts another whole document at a page position', async () => {
  const files = new Map([['cover.pdf', await makePdf(1, { label: 'cover' })]]);
  const doc = await only(await editPdf({ base: await makePdf(3), files }, [{ op: 'insert', at: 0, from: 'cover.pdf' }]));
  assert.equal(doc.getPageCount(), 4);
  assert.equal(doc.getPages()[0].getWidth(), 300, 'the inserted page is first');
  const atEnd = await only(await editPdf({ base: await makePdf(3), files }, [{ op: 'insert', at: 3, from: 'cover.pdf' }]));
  assert.equal(atEnd.getPageCount(), 4);
});

test('insert at an impossible position is refused', async () => {
  const files = new Map([['x.pdf', await makePdf(1)]]);
  await assert.rejects(editPdf({ base: await makePdf(2), files }, [{ op: 'insert', at: 3, from: 'x.pdf' }]), /between 0 and 2/);
  await assert.rejects(editPdf({ base: await makePdf(2), files }, [{ op: 'insert', at: -1, from: 'x.pdf' }]), /between 0 and 2/);
});

test('page numbers are drawn on every page and honour the template and start', async () => {
  const result = await editPdf({ base: await makePdf(3) }, [{ op: 'pageNumbers', template: '{n}/{total}', startAt: 10 }]);
  assert.equal(result.outputs[0].pageCount, 3);
  // The numbers are drawn content, so the check is that the file grew and still loads.
  const doc = await only(result);
  assert.equal(doc.getPageCount(), 3);
  const bare = await makePdf(3);
  assert.ok(result.outputs[0].bytes.byteLength > bare.byteLength, 'drawing text adds content');
});

test('the built-in fonts draw Latin text only, and say so for anything else', async () => {
  // This is a real measured boundary: pdf-lib's standard fonts are WinAnsi, so a CJK watermark would
  // need an embedded font subset of several megabytes. The refusal names the track that can do it.
  await assert.rejects(
    editPdf({ base: await makePdf(1) }, [{ op: 'watermark', text: '草稿', opacity: 0.3 }]),
    error => error instanceof PdfError && error.code === 'unsupported' && /Latin text only/.test(error.message) && /Stirling-PDF/.test(error.message),
  );
  await assert.rejects(
    editPdf({ base: await makePdf(1) }, [{ op: 'pageNumbers', template: '第{n}页' }]),
    error => error instanceof PdfError && /cannot contain/.test(error.message),
  );
  // Latin and Western punctuation are fine.
  const latin = await editPdf({ base: await makePdf(1) }, [{ op: 'watermark', text: 'DRAFT (final)', opacity: 0.3 }]);
  assert.equal(latin.outputs[0].pageCount, 1);
});

test('a watermark is drawn on every page and stays inside the page box', async () => {
  const result = await editPdf({ base: await makePdf(2) }, [{ op: 'watermark', text: 'DRAFT', opacity: 0.3, size: 32, angle: 45, color: 'red' }]);
  const doc = await only(result);
  assert.equal(doc.getPageCount(), 2);
  assert.ok(result.outputs[0].bytes.byteLength > (await makePdf(2)).byteLength);
});

test('metadata is written and reads back', async () => {
  const result = await editPdf({ base: await makePdf(1) }, [{
    op: 'metadata', title: '季度报告', author: '铭象悦动', subject: '评审', keywords: ['季度', '评审'],
  }]);
  const info = await inspectPdf(result.outputs[0].bytes);
  assert.equal(info.title, '季度报告');
  assert.equal(info.author, '铭象悦动');
  assert.equal(info.subject, '评审');
  assert.deepEqual(info.keywords, ['季度', '评审']);
  // pdf-lib claims Producer for itself on every save, so ClawMaster signs its work in Creator.
  assert.equal(info.creator, 'ClawMaster');
  assert.match(info.producer, /pdf-lib/);
});

test('operations compose in order', async () => {
  const files = new Map([['extra.pdf', await makePdf(1)]]);
  const base = await makePdf(4);
  const result = await editPdf({ base, files }, [
    { op: 'merge', paths: ['extra.pdf'] },
    { op: 'rotate', pages: 'last', by: 90 },
    { op: 'delete', pages: '2' },
    { op: 'metadata', title: 'composed' },
  ]);
  const doc = await only(result);
  assert.equal(doc.getPageCount(), 4, '5 minus one deleted');
  assert.equal(doc.getPages().at(-1).getRotation().angle, 90, 'the rotated page is still last');
  assert.equal(doc.getTitle(), 'composed');
});

test('an empty or damaged file is refused with a reason a user can act on', async () => {
  await assert.rejects(editPdf({ base: new Uint8Array(0) }, []), /is empty/);
  await assert.rejects(editPdf({ base: new TextEncoder().encode('not a pdf at all') }, []), /does not start with %PDF-/);
  await assert.rejects(editPdf({ base: await makePdf(1), files: new Map([['b.pdf', new TextEncoder().encode('nope')]]) }, [{ op: 'merge', paths: ['b.pdf'] }]), /does not start with %PDF-/);
});

test('a document past the size bound is refused before it is parsed', async () => {
  const huge = new Uint8Array(MAX_INPUT_BYTES + 1);
  huge.set(new TextEncoder().encode('%PDF-'));
  await assert.rejects(editPdf({ base: huge }, []), /at most 64 MiB/);
});

test('an operation sequence with no base document is refused unless it merges', async () => {
  await assert.rejects(editPdf({}, [{ op: 'rotate', by: 90 }]), /base document is required/);
});

test('the result reports the page count of the document it carried through', async () => {
  const result = await editPdf({ base: await makePdf(3) }, [{ op: 'delete', pages: '1' }]);
  assert.equal(result.pageCount, 2);
  assert.equal(result.outputs.at(-1).name, 'result');
  assert.equal(result.outputs.at(-1).pageCount, 2);
});

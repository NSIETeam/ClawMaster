/** What can pdf-lib actually do here? Measure before designing around it. */
import { PDFDocument, degrees, rgb, StandardFonts } from 'pdf-lib';

// build a 3-page document with known sizes to test against
const doc = await PDFDocument.create();
for (let i = 0; i < 3; i++) {
  const page = doc.addPage([300 + i * 10, 400 + i * 10]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(`page ${i + 1}`, { x: 20, y: 380, size: 12, font });
}
const bytes = await doc.save();
console.log('built bytes:', bytes.byteLength, 'header:', String.fromCharCode(...bytes.slice(0, 5)));

// 1. load + inspect
const loaded = await PDFDocument.load(bytes);
console.log('pages:', loaded.getPageCount(), 'sizes:', loaded.getPages().map(p => p.getSize()));

// 2. rotate / delete / reorder / extract
const copy = await PDFDocument.load(bytes);
copy.getPages()[0].setRotation(degrees(90));
const removed = await PDFDocument.load(bytes); removed.removePage(1);
// pages cannot move between documents: a cross-document page must be copied first
const order = await PDFDocument.load(bytes);
const [moved] = await order.copyPages(copy, [1]);
order.removePage(1); order.insertPage(0, moved);
for (const [name, d] of [['rotate', copy], ['delete', removed], ['reorder', order]]) {
  const out = await d.save();
  const back = await PDFDocument.load(out);
  console.log(`${name}: pages=${back.getPageCount()} rotation=${back.getPages()[0].getRotation().angle} bytes=${out.byteLength}`);
}

// 3. watermark + page numbers
const marked = await PDFDocument.load(bytes);
const font = await marked.embedFont(StandardFonts.HelveticaBold);
marked.getPages().forEach(p => p.drawText('DRAFT', { x: 60, y: 200, size: 40, font, color: rgb(0.9, 0.2, 0.2), opacity: 0.3, rotate: degrees(30) }));
const markedBytes = await marked.save();
console.log('watermark bytes:', markedBytes.byteLength, 'loads:', (await PDFDocument.load(markedBytes)).getPageCount());

// 4. metadata + copy a whole doc in (merge)
const merged = await PDFDocument.create();
const fromA = await merged.copyPages(loaded, loaded.getPageIndices());
const fromB = await merged.copyPages(await PDFDocument.load(markedBytes), [0]);
for (const p of [...fromA, ...fromB]) merged.addPage(p);
merged.setTitle('merged'); merged.setAuthor('ClawMaster');
const mergedBytes = await merged.save();
const mergedBack = await PDFDocument.load(mergedBytes);
console.log('merge: pages=', mergedBack.getPageCount(), 'title=', mergedBack.getTitle());

// 5. can it encrypt? (expected: no)
console.log('encrypt API present:', typeof merged.encrypt === 'function');

// 6. text extraction? (expected: no)
console.log('extractText API present:', typeof merged.getPages()[0].getTextContent === 'function');

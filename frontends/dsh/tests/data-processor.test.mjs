import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeDelimitedBytes, parseDelimited, processTable, serializeDelimited } from '../src/business.ts';

const options = {
  header: true, trim: false, deduplicate: false, filterColumn: null, filterText: '',
  sortColumn: null, sortDirection: 'ascending', locale: 'en-US',
};

test('CSV and TSV retain quoted newlines, escaped quotes, leading zeros, and whitespace', () => {
  const csv = parseDelimited('\ufeffname,note,code\r\n" East, West ","line 1\r\nline ""2""",0012\r\n');
  assert.deepEqual(csv.rows, [['name', 'note', 'code'], [' East, West ', 'line 1\r\nline "2"', '0012']]);
  assert.deepEqual(csv.issues, []);
  const tsv = parseDelimited('name\tnote\nA\t"two\tparts\nnext line"\n');
  assert.equal(tsv.delimiter, '\t');
  assert.deepEqual(tsv.rows, [['name', 'note'], ['A', 'two\tparts\nnext line']]);
  assert.deepEqual(tsv.issues, []);
});

test('malformed quotations and uneven records block processing', () => {
  for (const input of ['a,b\n"unterminated,1', 'a,b\n"bad"tail,1', 'a,b\n1,2,3', 'a,b\n1']) {
    const table = parseDelimited(input, ',');
    assert.ok(table.issues.some(issue => issue.severity === 'error'), input);
    assert.throws(() => processTable(table, options), /invalid table/);
  }
  assert.deepEqual(parseDelimited('a,b\n1,2,3', ',').issues, [
    { code: 'columns', severity: 'error', record: 2, expected: 2, actual: 3 },
  ]);
});

test('empty records are preserved unless explicitly excluded and then counted', () => {
  const table = parseDelimited('a,b\n\nx,y\n', ',');
  assert.equal(table.rows.length, 3);
  assert.equal(table.blankRowsRemoved, 0);
  assert.ok(table.issues.some(issue => issue.code === 'columns'));
  const skipped = parseDelimited('a,b\n\nx,y\n', ',', true);
  assert.deepEqual(skipped.rows, [['a', 'b'], ['x', 'y']]);
  assert.equal(skipped.blankRowsRemoved, 1);
  assert.deepEqual(skipped.issues, []);
  assert.deepEqual(parseDelimited('').rows, []);
  assert.deepEqual(parseDelimited('a\n""\n', ',').rows, [['a'], ['']]);
});

test('ambiguous single-column auto detection is visible and explicit CSV removes the warning', () => {
  assert.equal(parseDelimited('code\n0012').issues[0].code, 'delimiter');
  assert.deepEqual(parseDelimited('code\n0012', ',').issues, []);
});

test('trim, dedupe, filtering, and natural sorting preserve the header and source', () => {
  const table = parseDelimited('name, amount \n Beta ,10\nAlpha,2\n Beta ,10\nGamma,30', ',');
  const original = structuredClone(table);
  const result = processTable(table, {
    ...options, trim: true, deduplicate: true, filterColumn: 0, filterText: 'a', sortColumn: 1,
  });
  assert.deepEqual(result.headers, ['name', 'amount']);
  assert.deepEqual(result.rows, [['Alpha', '2'], ['Beta', '10'], ['Gamma', '30']]);
  assert.equal(result.sourceRows, 4);
  assert.equal(result.trimmedCells, 3);
  assert.equal(result.duplicatesRemoved, 1);
  assert.equal(result.filteredOut, 0);
  assert.deepEqual(table, original);
  const filtered = processTable(table, { ...options, filterColumn: null, filterText: 'BETA' });
  assert.equal(filtered.rows.length, 2);
  assert.equal(filtered.filteredOut, 2);
});

test('headerless mode retains the first row and duplicate matching cannot collide across cells', () => {
  const table = parseDelimited('"a,b",c\na,"b,c"\n"a,b",c', ',');
  const result = processTable(table, { ...options, header: false, deduplicate: true });
  assert.equal(result.headers, null);
  assert.deepEqual(result.rows, [['a,b', 'c'], ['a', 'b,c']]);
  assert.equal(result.sourceRows, 3);
  assert.equal(result.duplicatesRemoved, 1);
});

test('sort changes row order without converting cell values', () => {
  const table = parseDelimited('code\n002\n10\n2', ',');
  const result = processTable(table, { ...options, sortColumn: 0, sortDirection: 'descending' });
  assert.deepEqual(result.rows, [['10'], ['002'], ['2']]);
});

test('CSV export contains every processed row and round trips quoted values', () => {
  const table = parseDelimited('name,note\nA,"one\ntwo"\nB,"a,b"', ',');
  const result = processTable(table, options);
  const exported = serializeDelimited(result, ',', false);
  assert.deepEqual(parseDelimited(exported, ',').rows, table.rows);
  assert.deepEqual(parseDelimited(serializeDelimited(result, '\t', false), '\t').rows, table.rows);
});

test('spreadsheet protection is an explicit export choice and leaves the in-memory values intact', () => {
  const table = parseDelimited('name,value\nA,=SUM(A1)\nB,-12\nC,@example', ',');
  const result = processTable(table, options);
  assert.equal(result.formulaCells, 3);
  assert.match(serializeDelimited(result, ',', true), /'=SUM\(A1\)/);
  assert.match(serializeDelimited(result, ',', true), /'-12/);
  assert.match(serializeDelimited(result, ',', false), /,=SUM\(A1\)/);
  assert.equal(result.rows[1][1], '-12');
});

test('local file decoding rejects invalid encoding instead of silently inserting replacement characters', () => {
  assert.equal(decodeDelimitedBytes(new TextEncoder().encode('名称,值\n甲,1'), 'utf-8'), '名称,值\n甲,1');
  assert.throws(() => decodeDelimitedBytes(new Uint8Array([0xff]), 'utf-8'));
  assert.equal(decodeDelimitedBytes(new Uint8Array([0xff, 0xfe, 0x41, 0, 0x2c, 0, 0x42, 0]), 'utf-16le'), 'A,B');
});

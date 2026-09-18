/**
 * The panel's own logic.
 *
 * The panel deliberately does no document work, so the only thing worth testing here is how one choice
 * becomes an operation: a page selection that must default to every page rather than to an empty one,
 * a watermark that must carry its text, and a merge whose file list is typed with commas.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOperations } from '../src/client.tsx';

test('a page selection defaults to every page rather than to nothing', () => {
  assert.deepEqual(buildOperations('delete', { selection: '', text: '', inputs: '' }), [{ op: 'delete', pages: 'all' }]);
  assert.deepEqual(buildOperations('delete', { selection: '   ', text: '', inputs: '' }), [{ op: 'delete', pages: 'all' }]);
  assert.deepEqual(buildOperations('rotate', { selection: '2-4', text: '', inputs: '' }), [{ op: 'rotate', pages: '2-4', by: 90 }]);
});

test('split asks for the named pages and reorder for a whole new order', () => {
  assert.deepEqual(buildOperations('extract', { selection: '1,3', text: '', inputs: '' }), [{ op: 'extract', ranges: '1,3', mode: 'keep' }]);
  assert.deepEqual(buildOperations('reorder', { selection: '3,1,2', text: '', inputs: '' }), [{ op: 'reorder', order: '3,1,2' }]);
});

test('a watermark carries the text and page numbers need no selection', () => {
  assert.deepEqual(buildOperations('watermark', { selection: 'all', text: 'DRAFT', inputs: '' }), [{ op: 'watermark', text: 'DRAFT' }]);
  assert.deepEqual(buildOperations('pageNumbers', { selection: 'all', text: '', inputs: '' }), [{ op: 'pageNumbers' }]);
});

test('a merge file list is split on commas and cleaned', () => {
  assert.deepEqual(buildOperations('merge', { selection: 'all', text: '', inputs: ' a.pdf , b.pdf ,,' }), [{ op: 'merge', paths: ['a.pdf', 'b.pdf'] }]);
  assert.deepEqual(buildOperations('merge', { selection: 'all', text: '', inputs: '' }), [{ op: 'merge', paths: [] }]);
});

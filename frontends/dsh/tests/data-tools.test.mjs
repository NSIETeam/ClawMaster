import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import * as ObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import { applyDataTools } from '../src/data-tools.ts';
import { parseDelimited } from '../src/business.ts';

async function fixture(t, { mode = 'workspace-write', limits = {}, approval, bare = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'clawmaster-csv-tools-'));
  const fibers = [];
  t.after(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  const ctx = new Context();
  const mount = async (plugin, config) => { const fiber = await ctx.plugin(plugin, config); fibers.push(fiber); return fiber; };
  await mount(SessionProjections);
  await mount(SystemPrompt);
  await mount(ToolRuntime);
  await mount(SandboxPolicy, { mode, workspaceRoot: root });
  await mount(bare ? LocalFileSystem : SandboxedFileSystem, { cwd: root });
  await mount(ObservationPolicy);
  if (approval !== undefined) {
    await mount(ApprovalService);
    ctx.on('approval/request', request => Promise.resolve(approval(request)));
  }
  const id = SessionId('csv-fixture');
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd });
  session.append('turn/start', { turn: 1 });
  const agent = { session };
  const toolFiber = await mount({ name: 'csv-tools-fixture', inject: ['tools', 'fs', 'sandboxPolicy'], apply: context => applyDataTools(context, limits) });
  let sequence = 0;
  const call = (args, signal = new AbortController().signal) => ctx.tools.execute({
    name: 'csv_process', arguments: args, agent, signal, callId: ToolCallId(`csv-${++sequence}`),
  });
  return { root, cwd, ctx, session, call, toolFiber };
}

function ok(result) {
  assert.equal(result.isError, false, JSON.stringify(result.content));
  assert.deepEqual(JSON.parse(result.content[0].text), result.value);
  return result.value;
}

test('CSV tool appears in the real DSH schema and preview returns bounded cells without writing', async t => {
  const f = await fixture(t, { limits: { previewRows: 1, previewColumns: 2, previewCellChars: 4 } });
  await writeFile(join(f.cwd, 'input.csv'), 'identifier,name,note\r\n001,Alpha,"one\r\ntwo"\r\n002,Beta,tail');
  const schema = f.ctx.tools.schemas().find(tool => tool.name === 'csv_process');
  assert.equal(schema.parameters.properties.input_path.type, 'string');
  assert.equal((await f.ctx.systemPrompt.assemble()).tools.some(tool => tool.name === 'csv_process'), true);
  const value = ok(await f.call({ input_path: 'input.csv' }));
  assert.equal(value.operation, 'preview');
  assert.equal(value.outputPath, null);
  assert.equal(value.resultRows, 2);
  assert.deepEqual(value.preview, {
    headers: ['iden', 'name'], rows: [['001', 'Alph']], omittedRows: 1, omittedColumns: 1,
    clippedCells: 2, cellCharacterLimit: 4,
  });
  assert.deepEqual(await readdir(f.cwd), ['input.csv']);
  await f.toolFiber.dispose();
  assert.equal(f.ctx.tools.get('csv_process'), undefined);
});

test('CSV cleaning saves every row, preserves quoted CRLF and leading zeros, and protects formulas', async t => {
  const f = await fixture(t, { limits: { previewRows: 1, previewColumns: 1, previewCellChars: 3 } });
  const input = 'id,name,note\r\n010, Alpha ,"keep\r\nline"\r\n010, Alpha ,"keep\r\nline"\r\n002,alpha,=1+2\r\n003,beta,remove\r\n001,ALPHA,@SUM(A1)';
  await writeFile(join(f.cwd, 'source.csv'), input);
  const value = ok(await f.call({ input_path: 'source.csv', output_path: 'result.csv', trim: true, deduplicate: true, filter: { text: 'alpha', column: 1 }, sort: { column: 0 } }));
  assert.equal(value.operation, 'create');
  assert.equal(value.sourceRows, 5);
  assert.equal(value.resultRows, 3);
  assert.equal(value.trimmedCells, 2);
  assert.equal(value.duplicatesRemoved, 1);
  assert.equal(value.filteredOut, 1);
  assert.equal(value.formulaCells, 2);
  assert.equal(value.formulasProtected, true);
  assert.equal(value.preview.rows.length, 1);
  const exported = await readFile(join(f.cwd, 'result.csv'));
  assert.deepEqual([...exported.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(value.outputBytes, exported.length);
  assert.deepEqual(parseDelimited(exported.toString('utf8'), ',').rows, [
    ['id', 'name', 'note'], ['001', 'ALPHA', "'@SUM(A1)"], ['002', 'alpha', "'=1+2"], ['010', 'Alpha', 'keep\r\nline'],
  ]);
  assert.equal(await readFile(join(f.cwd, 'source.csv'), 'utf8'), input);
});

test('TSV, no-header files, blank-row removal and explicit formula preservation use the shared processor', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'input.tsv'), '002\t=2\n\n001\t=1\n');
  const result = ok(await f.call({ input_path: 'input.tsv', output_path: 'output.tsv', delimiter: 'tsv', output_format: 'tsv', header: false, skip_blank_rows: true, sort: { column: 0, direction: 'descending' }, protect_formulas: false }));
  assert.equal(result.blankRowsRemoved, 1);
  assert.equal(result.preview.headers, null);
  assert.equal(result.formulasProtected, false);
  assert.deepEqual(parseDelimited(await readFile(join(f.cwd, 'output.tsv'), 'utf8'), '\t').rows, [['002', '=2'], ['001', '=1']]);
});

test('workspace containment rejects absolute, parent and symlink escapes for reads and writes', { skip: process.platform === 'win32' ? 'Creating directory symlinks requires a Windows privilege outside this fixture' : false }, async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'outside'));
  await writeFile(join(f.root, 'outside', 'secret.csv'), 'a\nsecret');
  await writeFile(join(f.cwd, 'input.csv'), 'a\nlocal');
  await symlink(join(f.root, 'outside'), join(f.cwd, 'link'), 'dir');
  for (const input_path of ['../outside/secret.csv', join(f.root, 'outside', 'secret.csv'), 'link/secret.csv']) {
    const result = await f.call({ input_path });
    assert.equal(result.isError, true);
    assert.equal(result.error.info.code, 'FS_PERMISSION_DENIED');
    assert.equal(JSON.stringify(result.content).includes('secret'), false);
  }
  for (const output_path of ['../outside/result.csv', join(f.root, 'outside', 'result.csv'), 'link/result.csv']) {
    const result = await f.call({ input_path: 'input.csv', output_path });
    assert.equal(result.isError, true);
    assert.equal(result.error.info.code, 'FS_PERMISSION_DENIED');
  }
  assert.deepEqual(await readdir(join(f.root, 'outside')), ['secret.csv']);
  ok(await f.call({ input_path: resolve(f.cwd, 'input.csv') }));
});

test('read-only policy permits preview and denies saving until a logged one-time DSH approval', async t => {
  const questions = [];
  const f = await fixture(t, { mode: 'read-only', approval: request => { questions.push(request); return 'allowed-once'; } });
  await writeFile(join(f.cwd, 'input.csv'), 'a\n1');
  ok(await f.call({ input_path: 'input.csv' }));
  const denied = await f.call({ input_path: 'input.csv', output_path: 'output.csv' });
  assert.equal(denied.isError, true);
  assert.equal(denied.error.info.code, 'FS_SANDBOX_DENIED');
  assert.match(denied.content[0].text, /sandbox_permissions/);
  assert.equal(questions.length, 0);
  ok(await f.call({ input_path: 'input.csv', output_path: 'output.csv', sandbox_permissions: 'workspace-write', justification: 'Save the requested cleaned CSV in this workspace.' }));
  assert.equal(questions.length, 1);
  assert.equal(questions[0].toolName, 'csv_process');
  assert.match(questions[0].reason, /workspace-write/);
  assert.match(questions[0].reason, /input "input\.csv"; output "output\.csv"/);
  assert.deepEqual(f.session.snapshotEvents().filter(event => event.type.startsWith('approval/')).map(event => event.type), ['approval/asked', 'approval/decided']);
  const later = await f.call({ input_path: 'input.csv', output_path: 'later.csv' });
  assert.equal(later.error.info.code, 'FS_SANDBOX_DENIED');
  assert.deepEqual((await readdir(f.cwd)).sort(), ['input.csv', 'output.csv']);
});

test('a CSV request changed while its one-shot approval is pending cannot redirect the approved write', async t => {
  let releaseApproval;
  let markAsked;
  const asked = new Promise(resolve => { markAsked = resolve; });
  const f = await fixture(t, { mode: 'read-only', approval: () => {
    markAsked();
    return new Promise(resolve => { releaseApproval = resolve; });
  } });
  await writeFile(join(f.cwd, 'input.csv'), 'a\n1');
  const args = { input_path: 'input.csv', output_path: 'approved.csv', sandbox_permissions: 'workspace-write', justification: 'Save this CSV.' };
  const pending = f.call(args);
  await asked;
  args.output_path = 'changed.csv';
  releaseApproval('allowed-once');
  ok(await pending);
  assert.deepEqual((await readdir(f.cwd)).sort(), ['approved.csv', 'input.csv']);
  assert.equal(await readFile(join(f.cwd, 'approved.csv'), 'utf8'), '\ufeffa\r\n1');
  await assert.rejects(readFile(join(f.cwd, 'changed.csv')), { code: 'ENOENT' });
});

test('rejected and unavailable approvals never save files', async t => {
  const f = await fixture(t, { mode: 'read-only', approval: () => 'rejected' });
  await writeFile(join(f.cwd, 'input.csv'), 'a\n1');
  const args = { input_path: 'input.csv', output_path: 'output.csv', sandbox_permissions: 'workspace-write', justification: 'Save this CSV.' };
  assert.match((await f.call(args)).content[0].text, /user rejected/);
  assert.deepEqual(await readdir(f.cwd), ['input.csv']);
  const missing = await fixture(t, { mode: 'read-only' });
  await writeFile(join(missing.cwd, 'input.csv'), 'a\n1');
  assert.match((await missing.call(args)).content[0].text, /no approval service/);
  assert.deepEqual(await readdir(missing.cwd), ['input.csv']);
});

test('a cancelled approval and an approved wider mode cannot create an out-of-workspace result', async t => {
  const cancelled = await fixture(t, { mode: 'read-only', approval: () => 'cancelled' });
  await writeFile(join(cancelled.cwd, 'input.csv'), 'a\n1');
  const args = { input_path: 'input.csv', output_path: 'output.csv', sandbox_permissions: 'workspace-write', justification: 'Save this CSV.' };
  assert.match((await cancelled.call(args)).content[0].text, /cancelled/);
  assert.deepEqual(await readdir(cancelled.cwd), ['input.csv']);
  const approved = await fixture(t, { mode: 'read-only', approval: () => 'allowed-once' });
  await writeFile(join(approved.cwd, 'input.csv'), 'a\n1');
  const outside = await approved.call({ ...args, output_path: '../outside.csv', sandbox_permissions: 'danger-full-access' });
  assert.equal(outside.error.info.code, 'FS_PERMISSION_DENIED');
  assert.deepEqual(await readdir(approved.root), ['workspace']);
});

test('DSH observation guards reject blind overwrite, allow in-place cleaning, and reject stale output', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'input.csv'), 'a\n 1 ');
  await writeFile(join(f.cwd, 'existing.csv'), 'a\noriginal');
  const blind = await f.call({ input_path: 'input.csv', output_path: 'existing.csv', trim: true });
  assert.equal(blind.error.info.code, 'FS_NOT_OBSERVED');
  assert.equal(await readFile(join(f.cwd, 'existing.csv'), 'utf8'), 'a\noriginal');
  ok(await f.call({ input_path: 'input.csv', output_path: 'input.csv', trim: true }));
  assert.deepEqual(parseDelimited(await readFile(join(f.cwd, 'input.csv'), 'utf8'), ',').rows, [['a'], ['1']]);
  ok(await f.call({ input_path: 'existing.csv' }));
  await writeFile(join(f.cwd, 'existing.csv'), 'a\nnewer-user-value');
  const stale = await f.call({ input_path: 'input.csv', output_path: 'existing.csv' });
  assert.equal(stale.error.info.code, 'FS_STALE_VERSION');
  assert.equal(await readFile(join(f.cwd, 'existing.csv'), 'utf8'), 'a\nnewer-user-value');
});

test('invalid CSV, invalid UTF-8, oversized files and invalid columns never create output', async t => {
  const f = await fixture(t, { limits: { maxInputBytes: 64, maxDiagnostics: 1 } });
  await writeFile(join(f.cwd, 'bad.csv'), 'a,b\n1\n2\n3');
  const malformed = await f.call({ input_path: 'bad.csv', output_path: 'output.csv' });
  assert.equal(malformed.isError, true);
  assert.match(malformed.content[0].text, /3 parsing errors/);
  assert.equal((malformed.content[0].text.match(/"record"/g) ?? []).length, 1);
  await writeFile(join(f.cwd, 'bad.csv'), Buffer.from([0xff, 0xfe, 0xfd]));
  assert.equal((await f.call({ input_path: 'bad.csv', output_path: 'output.csv' })).isError, true);
  await writeFile(join(f.cwd, 'bad.csv'), 'a'.repeat(65));
  assert.equal((await f.call({ input_path: 'bad.csv', output_path: 'output.csv' })).error.info.code, 'FS_TOO_LARGE');
  await writeFile(join(f.cwd, 'bad.csv'), 'a,b\n1,2');
  for (const column of [-1, 1.2, 2]) assert.equal((await f.call({ input_path: 'bad.csv', output_path: 'output.csv', sort: { column } })).isError, true);
  assert.deepEqual(await readdir(f.cwd), ['bad.csv']);
});

test('cancellation before dispatch and during file acquisition prevents a saved result', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'input.csv'), 'a\n1');
  const before = new AbortController();
  before.abort();
  assert.equal((await f.call({ input_path: 'input.csv', output_path: 'before.csv' }, before.signal)).isError, true);
  const during = new AbortController();
  const originalRead = f.ctx.fs.readBytes.bind(f.ctx.fs);
  f.ctx.fs.readBytes = async (...args) => { const bytes = await originalRead(...args); during.abort(); return bytes; };
  assert.equal((await f.call({ input_path: 'input.csv', output_path: 'during.csv' }, during.signal)).isError, true);
  assert.deepEqual(await readdir(f.cwd), ['input.csv']);
});

test('a changed source fails before an observation can authorize writing mixed data', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'input.csv'), 'a\n1');
  const originalRead = f.ctx.fs.readBytes.bind(f.ctx.fs);
  f.ctx.fs.readBytes = async (...args) => { const bytes = await originalRead(...args); await writeFile(join(f.cwd, 'input.csv'), 'a\nchanged-during-read'); return bytes; };
  const result = await f.call({ input_path: 'input.csv', output_path: 'output.csv' });
  assert.equal(result.error.info.code, 'FS_STALE_VERSION');
  assert.deepEqual(await readdir(f.cwd), ['input.csv']);
});

test('CSV tools require a confining provider, valid limits and a Session workspace', async t => {
  await assert.rejects(fixture(t, { bare: true }), /sandbox-enforcing DSH filesystem/);
  await assert.rejects(fixture(t, { limits: { previewRows: 0 } }), /positive safe integer/);
  const f = await fixture(t);
  const result = await f.ctx.tools.execute({ name: 'csv_process', arguments: { input_path: 'input.csv' }, signal: new AbortController().signal, callId: ToolCallId('no-session') });
  assert.match(result.content[0].text, /requires a Session workspace/);
});

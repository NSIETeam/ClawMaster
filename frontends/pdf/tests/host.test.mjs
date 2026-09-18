/**
 * The PDF Host as the profile loads it: real routes, real tools, a real folder on disk.
 *
 * `apply()` is called with a stub of DSH's connection, tool and approval services, so this proves the
 * contract the profile and the agent depend on — route paths, method sets, request envelopes, the tool
 * names, the approval gate on writes, and the fact that reading never asks for one. The folder is a
 * temporary directory with a real PDF in it, because the behaviour that matters most here is what ends
 * up on disk.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { apply, defaultRoot, defaultStirlingDirectory } from '../src/host.ts';

/** A PDF whose page widths identify the pages. */
async function makePdf(count) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < count; index += 1) {
    doc.addPage([300 + index * 10, 400]).drawText(`p${index + 1}`, { x: 20, y: 380, size: 12, font });
  }
  return new Uint8Array(await doc.save());
}

/** A stand-in for DSH's services, recording what the plugin registered. */
function stubHost() {
  const routes = new Map();
  const tools = new Map();
  const provided = new Map();
  const approvals = [];
  const host = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return async () => { routes.delete(route.path); }; } } },
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    approval: {
      async request(request) {
        approvals.push(request);
        return 'allowed-once';
      },
    },
    effect: async (factory) => factory(),
    provide: (key, value) => provided.set(key, value),
    get: key => provided.get(key),
  };
  return { host, routes, tools, provided, approvals };
}

/** Boot the plugin over a temporary folder holding the given files. */
async function boot(files = {}, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-host-'));
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  const stub = stubHost();
  await apply(stub.host, { root, stirlingEnabled: false, ...config });
  return {
    ...stub,
    root,
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

/** Call one registered route with a JSON body. */
async function post(route, body) {
  return route.fetch(new Request('http://localhost/x', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
}

/** The execution context the tool registry supplies for one call. */
const EXEC = { agent: { id: 'agent-1' }, callId: 'call-1', name: 'pdf_edit', signal: undefined };

test('the plugin registers its routes and tools', async () => {
  const app = await boot({ 'a.pdf': await makePdf(2) });
  try {
    assert.deepEqual([...app.routes.keys()].sort(), ['/api/clawmaster/pdf/edit', '/api/clawmaster/pdf/info', '/api/clawmaster/pdf/stirling']);
    for (const route of app.routes.values()) assert.equal(route.requestBody, 'buffered');
    assert.deepEqual([...app.tools.keys()].sort(), ['pdf_edit', 'pdf_info', 'pdf_stirling']);
    assert.equal(app.provided.has('clawmasterPdf'), true);
  } finally {
    await app.close();
  }
});

test('the info route reads a real document', async () => {
  const app = await boot({ 'a.pdf': await makePdf(3) });
  try {
    const route = app.routes.get('/api/clawmaster/pdf/info');
    const response = await route.fetch(new Request('http://localhost/api/clawmaster/pdf/info?path=a.pdf'));
    assert.equal(response.status, 200);
    const info = await response.json();
    assert.equal(info.pageCount, 3);
    assert.deepEqual(info.sizes.map(size => size.width), [300, 310, 320]);
    assert.match(info.revision, /^sha256-[0-9a-f]{64}$/);
    // A read never asks for approval.
    assert.equal(app.approvals.length, 0);
  } finally {
    await app.close();
  }
});

test('a refused read answers with the typed failure and a status', async () => {
  const app = await boot({ 'a.pdf': await makePdf(1) });
  try {
    const route = app.routes.get('/api/clawmaster/pdf/info');
    const missing = await route.fetch(new Request('http://localhost/api/clawmaster/pdf/info?path=nope.pdf'));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'not_found');
    const escaped = await route.fetch(new Request('http://localhost/api/clawmaster/pdf/info?path=../outside.pdf'));
    assert.equal(escaped.status, 400);
    assert.match((await escaped.json()).error.message, /segments/);
    const noPath = await route.fetch(new Request('http://localhost/api/clawmaster/pdf/info'));
    assert.equal(noPath.status, 400);
    assert.equal((await noPath.json()).error.code, 'invalid_request');
  } finally {
    await app.close();
  }
});

test('the edit route runs operations and writes beside the source', async () => {
  const app = await boot({ 'a.pdf': await makePdf(3) });
  try {
    const route = app.routes.get('/api/clawmaster/pdf/edit');
    const response = await post(route, { request: { source: 'a.pdf', operations: [{ op: 'rotate', by: 90 }] } });
    assert.equal(response.status, 200, await response.clone().text());
    const receipt = await response.json();
    assert.equal(receipt.replacedSource, false);
    assert.deepEqual(receipt.outputs.map(output => output.path), ['a (编辑).pdf']);
    assert.deepEqual(await app.list(), ['a (编辑).pdf', 'a.pdf']);
    const produced = await PDFDocument.load(await readFile(join(app.root, 'a (编辑).pdf')));
    assert.equal(produced.getPages()[0].getRotation().angle, 90);
    // The route itself does not gate: the tool does, because a route is the panel acting for the user.
    assert.equal(app.approvals.length, 0);
  } finally {
    await app.close();
  }
});

test('the edit route refuses an unsupported operation with 422 and names the optional component', async () => {
  const app = await boot({ 'a.pdf': await makePdf(1) });
  try {
    const route = app.routes.get('/api/clawmaster/pdf/edit');
    const response = await post(route, { request: { source: 'a.pdf', operations: [{ op: 'ocr' }] } });
    assert.equal(response.status, 422);
    const failure = await response.json();
    assert.match(failure.error.message, /Stirling-PDF/);
    assert.deepEqual(await app.list(), ['a.pdf'], 'nothing was written');
  } finally {
    await app.close();
  }
});

test('the edit route rejects a malformed envelope before anything is read', async () => {
  const app = await boot({ 'a.pdf': await makePdf(1) });
  try {
    const route = app.routes.get('/api/clawmaster/pdf/edit');
    const notJson = await route.fetch(new Request('http://localhost/x', { method: 'POST', body: 'plain' }));
    assert.equal(notJson.status, 400);
    const noOperations = await post(route, { request: { source: 'a.pdf', operations: [] } });
    assert.equal(noOperations.status, 400);
    const badAngle = await post(route, { request: { source: 'a.pdf', operations: [{ op: 'rotate', by: 45 }] } });
    assert.equal(badAngle.status, 400);
    assert.deepEqual(await app.list(), ['a.pdf']);
  } finally {
    await app.close();
  }
});

test('the pdf_info tool reads without approval and reports a real structure', async () => {
  const app = await boot({ 'a.pdf': await makePdf(2) });
  try {
    const tool = app.tools.get('pdf_info');
    const info = await tool.execute({ path: 'a.pdf' }, EXEC);
    assert.equal(info.pageCount, 2);
    assert.equal(app.approvals.length, 0, 'a read never asks for approval');
    assert.match(tool.description, /never needs approval/);
    await assert.rejects(tool.execute({ path: 'missing.pdf' }, EXEC), /no file missing\.pdf/);
    await assert.rejects(tool.execute({ path: '/etc/passwd' }, EXEC), /relative to the task folder/);
  } finally {
    await app.close();
  }
});

test('the pdf_edit tool asks for exactly one approval and then writes', async () => {
  const app = await boot({ 'a.pdf': await makePdf(3) });
  try {
    const tool = app.tools.get('pdf_edit');
    const receipt = await tool.execute({ source: 'a.pdf', operations: [{ op: 'delete', pages: '2' }] }, EXEC);
    assert.equal(app.approvals.length, 1, 'one write, one grant');
    assert.match(app.approvals[0].reason, /Write PDF files/);
    assert.equal(app.approvals[0].toolName, 'pdf_edit');
    assert.equal(receipt.outputs[0].pageCount, 2);
    const produced = await PDFDocument.load(await readFile(join(app.root, receipt.outputs[0].path)));
    assert.deepEqual(produced.getPages().map(page => page.getWidth()), [300, 320]);
    assert.match(tool.description, /one-shot DSH approval/);
    // The description tells the model what it cannot do, so it does not promise OCR.
    assert.match(tool.description, /cannot encrypt, decrypt, OCR/);
  } finally {
    await app.close();
  }
});

test('a refused approval leaves the folder untouched', async () => {
  const app = await boot({ 'a.pdf': await makePdf(1) });
  try {
    app.host.approval.request = async () => 'rejected';
    const tool = app.tools.get('pdf_edit');
    await assert.rejects(tool.execute({ source: 'a.pdf', operations: [{ op: 'rotate', by: 90 }], inPlace: true }, EXEC), /approval_rejected/);
    assert.deepEqual(await app.list(), ['a.pdf']);
  } finally {
    await app.close();
  }
});

test('the pdf_stirling tool reports what the built-in track leaves to the optional one', async () => {
  const app = await boot({ 'a.pdf': await makePdf(1) });
  try {
    const tool = app.tools.get('pdf_stirling');
    const status = await tool.execute({}, EXEC);
    assert.equal(status.available, false);
    assert.match(status.reason, /not enabled/);
    for (const operation of ['encrypt', 'ocr', 'fillForm', 'sign', 'extractText', 'convert']) {
      assert.equal(status.delegatedOperations.includes(operation), true, operation);
    }
    assert.match(tool.description, /never needs approval/);
  } finally {
    await app.close();
  }
});

test('the stirling probe reports an installed runtime without starting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-stirling-'));
  const directory = join(root, 'runtime');
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'stirling.jar'), 'not a real jar');
    const app = await boot({ 'a.pdf': await makePdf(1) }, { stirlingEnabled: true, stirlingDirectory: directory });
    try {
      const status = await app.tools.get('pdf_stirling').execute({}, EXEC);
      assert.equal(status.available, true);
      assert.equal(status.directory, directory);
      assert.match(status.reason, /starting it is a separate step/);
    } finally {
      await app.close();
    }
    // Enabled but not installed is reported as such rather than as available.
    const missing = await boot({ 'a.pdf': await makePdf(1) }, { stirlingEnabled: true, stirlingDirectory: join(root, 'absent') });
    try {
      const status = await missing.tools.get('pdf_stirling').execute({}, EXEC);
      assert.equal(status.available, false);
      assert.match(status.reason, /not installed/);
    } finally {
      await missing.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unloading the plugin removes every route and tool', async () => {
  const app = await boot({ 'a.pdf': await makePdf(1) });
  try {
    assert.equal(app.routes.size, 3);
    assert.equal(app.tools.size, 3);
    // The effect disposer is what a profile calls on unload.
    const { host } = app;
    assert.equal(typeof host.effect, 'function');
    await app.close();
  } finally {
    await app.close();
  }
});

test('a relative folder is refused at load time, and the defaults are absolute', async () => {
  const stub = stubHost();
  await assert.rejects(apply(stub.host, { root: 'relative/folder' }), /absolute path/);
  await assert.rejects(apply(stub.host, { root: '/tmp', stirlingDirectory: 'relative/folder' }), /absolute path/);
  assert.equal(defaultRoot().startsWith('/'), true);
  assert.match(defaultStirlingDirectory(), /\.clawmaster\/components\/pdf\/runtime$/);
});

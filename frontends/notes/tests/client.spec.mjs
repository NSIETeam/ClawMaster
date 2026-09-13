/** Actual compiled Notes UI preserves drafts and never deletes on a revision conflict. */
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import * as JSX from 'react/jsx-runtime';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const disposers = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const revision = text => `sha256-${createHash('sha256').update(text).digest('hex')}`;
const note = (id, text) => ({ id, text, title: id.slice(0, -3), revision: revision(text), links: [], embeds: [], tags: [] });

async function fixture(locale = 'zh') {
  const old = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__');
  disposers.push(() => { if (old) Object.defineProperty(window, '__ModuleLoader__', old); else Reflect.deleteProperty(window, '__ModuleLoader__'); });
  let factory;
  window.__ModuleLoader__ = { load: entry => { factory = entry.factory; } };
  vm.runInThisContext(await readFile('frontends/notes/dist/client.js', 'utf8'));
  const modules = { react: React, 'react/jsx-runtime': JSX };
  const plugin = factory(id => { if (!(id in modules)) throw new Error(`Unexpected client dependency: ${id}`); return modules[id]; });
  const disk = new Map([['Alpha.md', '# Alpha\n'], ['Beta.md', '# Beta\n']]);
  const requests = [];
  let delayRead;
  const request = vi.fn(async (path, init) => {
    expect(init.credentials).toBe('same-origin');
    const url = new URL(path, 'http://localhost');
    requests.push({ path: url.pathname, command: init.body ? JSON.parse(init.body).request : undefined });
    if (url.pathname.endsWith('/tree')) return Response.json({ vault: '/synthetic/notes', notes: [...disk].map(([id, text]) => ({ id, title: id.slice(0, -3), dir: '', size: text.length, mtimeMs: 1 })) });
    if (url.pathname.endsWith('/tags')) return Response.json({ tags: [] });
    if (url.pathname.endsWith('/backlinks')) return Response.json({ id: url.searchParams.get('id'), notes: [] });
    if (url.pathname.endsWith('/note')) {
      const id = url.searchParams.get('id');
      if (delayRead) await delayRead(id);
      if (!disk.has(id)) return Response.json({ error: { code: 'not_found', message: 'Missing' } }, { status: 404 });
      return Response.json(note(id, disk.get(id)));
    }
    if (url.pathname.endsWith('/command')) {
      const command = JSON.parse(init.body).request;
      const previous = disk.has(command.id) ? revision(disk.get(command.id)) : null;
      if ((command.action === 'save' && command.expectedRevision !== previous) || (command.action === 'create' && previous !== null)) {
        return Response.json({ error: { code: 'conflict', message: 'Changed', currentRevision: previous } }, { status: 409 });
      }
      if (command.action === 'delete') disk.delete(command.id);
      else disk.set(command.id, command.text);
      return Response.json({ action: command.action, id: command.id, revision: command.action === 'delete' ? null : revision(command.text), previousRevision: previous });
    }
    throw new Error(`Unexpected Notes request: ${path}`);
  });
  vi.stubGlobal('fetch', request);
  let tab;
  plugin.apply({
    locale: { getSnapshot: () => ({ active: locale }), subscribe: () => () => {} },
    betterSidebar: { registerTab: value => { tab = value; return () => { tab = undefined; }; } },
    effect: install => disposers.push(install()),
  });
  expect(tab.id).toBe('clawmaster:notes');
  expect(tab.single).toBe(true);
  const mount = () => render(React.createElement(tab.component, { scope: { sessionId: 'synthetic-session' }, visible: true }));
  const view = mount();
  await screen.findByRole('button', { name: 'Alpha' });
  const copy = locale === 'zh' ? { edit: '编辑', save: '保存', reload: '重新载入', cancel: '取消', delete: '删除', dirty: '未保存' }
    : { edit: 'Edit', save: 'Save', reload: 'Reload', cancel: 'Cancel', delete: 'Delete', dirty: 'Unsaved' };
  const open = async id => { fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${id}( |$)`) })); await screen.findByRole('heading', { name: id }); };
  const editor = () => screen.getByRole('textbox', { name: copy.edit });
  return { disk, requests, view, mount, copy, open, editor, delay: handler => { delayRead = handler; } };
}

for (const locale of ['zh', 'en']) {
  it(`keeps draft and newer file on save conflict without read or delete (${locale})`, async () => {
    const f = await fixture(locale);
    await f.open('Alpha');
    fireEvent.change(f.editor(), { target: { value: 'local unsaved draft' } });
    f.disk.set('Alpha.md', 'newer external text');
    const before = f.requests.length;
    fireEvent.click(screen.getByRole('button', { name: f.copy.save }));
    await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('conflict'));
    expect(f.editor().value).toBe('local unsaved draft');
    expect(f.disk.get('Alpha.md')).toBe('newer external text');
    expect(f.requests.slice(before).map(item => item.command?.action ?? item.path)).toEqual(['save']);
    expect(f.requests.some(item => item.command?.action === 'delete')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: f.copy.reload }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: f.copy.cancel }));
    expect(f.editor().value).toBe('local unsaved draft');
    fireEvent.click(screen.getByRole('button', { name: f.copy.reload }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: f.copy.reload }));
    await waitFor(() => expect(f.editor().value).toBe('newer external text'));
    expect(f.disk.get('Alpha.md')).toBe('newer external text');
  });

  it(`retains dirty notes across note navigation and tab close/reopen (${locale})`, async () => {
    const f = await fixture(locale);
    await f.open('Alpha');
    fireEvent.change(f.editor(), { target: { value: 'retained draft' } });
    await f.open('Beta');
    await f.open('Alpha');
    expect(f.editor().value).toBe('retained draft');
    f.view.unmount();
    const reopened = f.mount();
    await waitFor(() => expect(f.editor().value).toBe('retained draft'));
    expect(f.editor().readOnly).toBe(false);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(f.requests.some(item => item.command)).toBe(false);
    reopened.unmount();
  });

  it(`requires an in-panel confirmation before deleting a note (${locale})`, async () => {
    const f = await fixture(locale);
    await f.open('Alpha');
    fireEvent.click(screen.getByRole('button', { name: f.copy.delete }));
    expect(f.disk.has('Alpha.md')).toBe(true);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: f.copy.cancel }));
    expect(f.requests.some(item => item.command?.action === 'delete')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: f.copy.delete }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: f.copy.delete }));
    await waitFor(() => expect(f.disk.has('Alpha.md')).toBe(false));
    expect(f.requests.filter(item => item.command?.action === 'delete')).toHaveLength(1);
  });
}

it('ignores an earlier note read that completes after a newer selection', async () => {
  const f = await fixture();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  f.delay(id => id === 'Alpha.md' ? pending : undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
  await f.open('Beta');
  await act(async () => { release(); await pending; });
  expect(screen.getByRole('heading', { name: 'Beta' })).toBeDefined();
  expect(f.editor().value).toBe('# Beta\n');
});

it('saves the edited text with its read revision and releases the draft warning', async () => {
  const f = await fixture();
  await f.open('Alpha');
  fireEvent.change(f.editor(), { target: { value: '# Updated title\nSaved text' } });
  fireEvent.click(screen.getByRole('button', { name: f.copy.save }));
  await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('saved'));
  expect(f.disk.get('Alpha.md')).toBe('# Updated title\nSaved text');
  expect(f.editor().value).toBe('# Updated title\nSaved text');
  expect(f.requests.find(item => item.command?.action === 'save').command.expectedRevision).toBe(revision('# Alpha\n'));
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});

it('uses actual backlinks rather than listing all other notes', async () => {
  const f = await fixture();
  await f.open('Alpha');
  await waitFor(() => expect(f.requests.some(item => item.path.endsWith('/backlinks'))).toBe(true));
  expect(screen.getAllByRole('button', { name: 'Beta' })).toHaveLength(1);
  expect(screen.getByText('暂无反向链接')).toBeDefined();
});

it('keeps the open draft when creating a duplicate note is rejected', async () => {
  const f = await fixture();
  await f.open('Alpha');
  fireEvent.change(f.editor(), { target: { value: 'unrelated draft' } });
  fireEvent.click(screen.getByRole('button', { name: '新建笔记' }));
  fireEvent.change(screen.getByRole('textbox', { name: '笔记名称' }), { target: { value: 'Beta' } });
  fireEvent.click(screen.getByRole('button', { name: '创建' }));
  await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('conflict'));
  expect(f.editor().value).toBe('unrelated draft');
  expect(f.disk.get('Alpha.md')).toBe('# Alpha\n');
  expect(f.disk.get('Beta.md')).toBe('# Beta\n');
  expect(f.requests.some(item => item.command?.action === 'delete')).toBe(false);
});

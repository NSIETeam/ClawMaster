/** Actual compiled Notes UI preserves drafts and never deletes on a revision conflict. */
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import * as JSX from 'react/jsx-runtime';
// The shipped bundle is pulled in as text so this spec stays free of `node:` imports and
// can run under the jsdom environment the UI needs.
import clientSource from '../dist/client.js?raw';

const disposers = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
/**
 * Deterministic stand-in for a content revision.
 * The client validates the `sha256-<64 hex>` shape rather than the algorithm, and real
 * content hashing is covered against the actual implementation by the vault and service
 * suites. Keeping it here avoids a `node:crypto` import in a browser-environment spec.
 */
const revision = text => {
  let left = 0x811c9dc5;
  let right = 0x01000193;
  for (const byte of new TextEncoder().encode(text)) {
    left = Math.imul(left ^ byte, 0x01000193) >>> 0;
    right = Math.imul(right + byte, 0x85ebca6b) >>> 0;
  }
  const hex = value => value.toString(16).padStart(8, '0');
  return `sha256-${`${hex(left)}${hex(right)}`.repeat(4)}`;
};
const bare = id => id.replace(/\.(md|canvas)$/, '');
const note = (id, text) => ({ id, text, title: bare(id), revision: revision(text), links: [], embeds: [], tags: [] });

async function fixture(locale = 'zh', extra = {}, pendingProposals = [], marks = []) {
  const old = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__');
  disposers.push(() => { if (old) Object.defineProperty(window, '__ModuleLoader__', old); else Reflect.deleteProperty(window, '__ModuleLoader__'); });
  let factory;
  window.__ModuleLoader__ = { load: entry => { factory = entry.factory; } };
  new Function('window', clientSource)(window);
  const modules = { react: React, 'react/jsx-runtime': JSX };
  const plugin = factory(id => { if (!(id in modules)) throw new Error(`Unexpected client dependency: ${id}`); return modules[id]; });
  // Seed before mount: the panel lists the vault once, on mount.
  const disk = new Map([['Alpha.md', '# Alpha\n'], ['Beta.md', '# Beta\n'], ...Object.entries(extra)]);
  const requests = [];
  let delayRead;
  // Marks live beside the note; the panel must render them and must not require the route.
  let annotationsFail = false;
  const request = vi.fn(async (path, init) => {
    expect(init.credentials).toBe('same-origin');
    const url = new URL(path, 'http://localhost');
    requests.push({ path: url.pathname, command: init.body ? JSON.parse(init.body).request : undefined });
    if (url.pathname.endsWith('/tree')) return Response.json({ vault: '/synthetic/notes', notes: [...disk].map(([id, text]) => ({ id, title: bare(id), dir: '', size: text.length, mtimeMs: 1 })) });
    if (url.pathname.endsWith('/tags')) return Response.json({ tags: [] });
    if (url.pathname.endsWith('/backlinks')) return Response.json({ id: url.searchParams.get('id'), notes: [] });
    if (url.pathname.endsWith('/annotations')) {
      if (annotationsFail) return Response.json({ error: { code: 'storage_unavailable', message: 'No annotations' } }, { status: 503 });
      const id = url.searchParams.get('id');
      return Response.json({ id, annotations: marks.filter(mark => mark.id === id) });
    }
    if (url.pathname.endsWith('/note')) {
      const id = url.searchParams.get('id');
      if (delayRead) await delayRead(id);
      if (!disk.has(id)) return Response.json({ error: { code: 'not_found', message: 'Missing' } }, { status: 404 });
      return Response.json(note(id, disk.get(id)));
    }
    if (url.pathname.endsWith('/search')) {
      const needle = (url.searchParams.get('q') ?? '').toLowerCase();
      const matches = [];
      for (const [id, text] of disk) {
        const lines = text.split('\n');
        const at = lines.findIndex(line => line.toLowerCase().includes(needle));
        if (at >= 0) matches.push({ id, title: bare(id), lineNumber: at + 1, line: lines[at] });
      }
      return Response.json({ query: needle, matches });
    }
    if (url.pathname.endsWith('/revision')) return Response.json({ version: revision([...disk].map(([id, text]) => `${id}:${text}`).join('|')) });
    if (url.pathname.endsWith('/proposals')) return Response.json({ proposals: pendingProposals });
    if (url.pathname.endsWith('/command')) {
      const command = JSON.parse(init.body).request;
      const id = command.action === 'rename' ? command.id : command.action === 'daily' ? '日记/2026-09-13.md' : command.id;
      const previous = disk.has(id) ? revision(disk.get(id)) : null;
      if ((command.action === 'save' && command.expectedRevision !== previous) || (command.action === 'create' && previous !== null)) {
        return Response.json({ error: { code: 'conflict', message: 'Changed', currentRevision: previous } }, { status: 409 });
      }
      if (command.action === 'apply-proposal' || command.action === 'discard-proposal') {
        const index = pendingProposals.findIndex(entry => entry.proposal.proposalId === command.proposalId);
        if (index < 0) return Response.json({ error: { code: 'not_found', message: 'Missing' } }, { status: 404 });
        const entry = pendingProposals[index];
        // The real service refuses to apply a proposal whose note moved on.
        const current = disk.has(entry.proposal.id) ? revision(disk.get(entry.proposal.id)) : null;
        if (current !== entry.proposal.baseRevision) {
          return Response.json({ error: { code: 'conflict', message: 'Changed', currentRevision: current } }, { status: 409 });
        }
        pendingProposals.splice(index, 1);
        if (command.action === 'discard-proposal') {
          return Response.json({ action: 'discard-proposal', id: entry.proposal.id, revision: null, previousRevision: null });
        }
        disk.set(entry.proposal.id, entry.proposal.text);
        return Response.json({
          action: 'apply-proposal', id: entry.proposal.id,
          revision: revision(entry.proposal.text), previousRevision: entry.proposal.baseRevision,
        });
      }
      if (command.action === 'rename') {
        if (disk.has(command.to)) return Response.json({ error: { code: 'conflict', message: 'Exists', currentRevision: revision(disk.get(command.to)) } }, { status: 409 });
        disk.set(command.to, disk.get(command.id));
        disk.delete(command.id);
        return Response.json({ action: 'rename', id: command.to, revision: revision(disk.get(command.to)), previousRevision: previous });
      }
      if (command.action === 'daily') {
        if (!disk.has(id)) disk.set(id, `---\ntags: [日记]\n---\n\n# 2026-09-13\n`);
        return Response.json({ action: 'daily', id, revision: revision(disk.get(id)), previousRevision: previous });
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
  return { disk, requests, view, mount, copy, open, editor, tab: () => tab, delay: handler => { delayRead = handler; }, failAnnotations: value => { annotationsFail = value; } };
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
    expect(f.requests.slice(before).filter(item => item.command).map(item => item.command.action)).toEqual(['save']);
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

/** One stored mark, shaped exactly as the annotation route returns it. */
const mark = (overrides = {}) => ({
  annotationId: '22222222-2222-4222-8222-222222222222', id: 'Alpha.md', line: null, quote: null,
  kind: 'comment', source: 'human', author: null, body: 'a mark', createdAt: '2026-09-13T00:00:00.000Z',
  ...overrides,
});

for (const locale of ['zh', 'en']) {
  it(`shows who left a mark, its kind and the line it points at (${locale})`, async () => {
    const f = await fixture(locale, {}, [], [mark({
      annotationId: '33333333-3333-4333-8333-333333333333', kind: 'risk', source: 'ai', author: 'watchdog',
      line: 4, quote: 'rm -rf', body: locale === 'zh' ? '这条命令会删除主目录' : 'This deletes the home directory',
    })]);
    await f.open('Alpha');
    await waitFor(() => expect(document.querySelectorAll('.cm-notes-mark')).toHaveLength(1));
    const card = document.querySelector('.cm-notes-mark');
    // The kind and the author both ride on the card, so a reader can tell them apart without colour.
    expect(card.dataset.kind).toBe('risk');
    expect(card.dataset.source).toBe('ai');
    expect(within(card).getByText(locale === 'zh' ? '风险' : 'Risk')).toBeDefined();
    expect(within(card).getByText('AI')).toBeDefined();
    expect(within(card).getByText('watchdog')).toBeDefined();
    expect(within(card).getByText('rm -rf')).toBeDefined();
    expect(card.textContent).toContain(locale === 'zh' ? '第 4' : 'line 4');
    expect(within(card).getByText(locale === 'zh' ? '这条命令会删除主目录' : 'This deletes the home directory')).toBeDefined();
  });
}

it('never shows one note the marks of another, and says when a note has none', async () => {
  const f = await fixture('zh', {}, [], [mark({ id: 'Beta.md', body: '只有 Beta 才有', source: 'ai' })]);
  await f.open('Alpha');
  await waitFor(() => expect(screen.getByText('这篇笔记还没有批注')).toBeDefined());
  expect(document.querySelectorAll('.cm-notes-mark')).toHaveLength(0);
  await f.open('Beta');
  await waitFor(() => expect(screen.getByText('只有 Beta 才有')).toBeDefined());
  // A person's mark and an agent's mark must never read as the same thing.
  expect(document.querySelector('.cm-notes-mark').dataset.source).toBe('ai');
});

it('keeps the note readable when only the annotation route fails', async () => {
  const f = await fixture();
  f.failAnnotations(true);
  await f.open('Alpha');
  expect(f.requests.some(item => item.path.endsWith('/annotations'))).toBe(true);
  expect(f.editor().value).toBe('# Alpha\n');
  expect(screen.getByRole('status').dataset.state).toBe('idle');
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

it('renames the open note and opens the new path', async () => {
  const f = await fixture();
  await f.open('Alpha');
  fireEvent.click(screen.getByRole('button', { name: '重命名' }));
  fireEvent.change(screen.getByRole('textbox', { name: '新名称' }), { target: { value: 'Gamma' } });
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '重命名' }));
  await waitFor(() => expect(f.disk.has('Gamma.md')).toBe(true));
  expect(f.disk.has('Alpha.md')).toBe(false);
  expect(screen.getByRole('heading', { name: 'Gamma' })).toBeDefined();
});

it('offers to create the note a missing wiki link points at', async () => {
  const f = await fixture();
  f.disk.set('Alpha.md', 'see [[Gamma]]\n');
  await f.open('Alpha');
  fireEvent.click(screen.getByRole('button', { name: '预览' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Gamma' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText('这个链接指向的笔记还不存在。')).toBeDefined();
  fireEvent.click(within(dialog).getByRole('button', { name: '创建这篇笔记' }));
  await waitFor(() => expect(f.disk.has('Gamma.md')).toBe(true));
  expect(f.disk.get('Gamma.md')).toBe('# Gamma\n');
});

it('asks which note an ambiguous wiki link means instead of guessing', async () => {
  const f = await fixture('zh', { 'one/Note.md': '# One\n', 'two/Note.md': '# Two\n' });
  f.disk.set('Alpha.md', 'see [[Note]]\n');
  await f.open('Alpha');
  fireEvent.click(screen.getByRole('button', { name: '预览' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Note' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText('有多篇笔记匹配这个链接，请选择：')).toBeDefined();
  expect(within(dialog).getAllByRole('button', { name: /Note/ })).toHaveLength(2);
});

it('shows a canvas file read-only with saving disabled', async () => {
  const f = await fixture('zh', { 'Board.canvas': '{"nodes":[]}' });
  await f.open('Board');
  expect(screen.getByText('画布文件以只读方式显示（本版本尚无画布编辑器）。')).toBeDefined();
  expect(screen.queryByRole('textbox', { name: '编辑' })).toBeNull();
  expect(screen.getByRole('button', { name: '保存' }).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: '重命名' })).toBeNull();
});

it('renders the matching line for search hits', async () => {
  const f = await fixture();
  fireEvent.change(screen.getByRole('textbox', { name: '搜索笔记' }), { target: { value: 'Beta' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: '搜索笔记' }), { key: 'Enter' });
  await waitFor(() => expect(screen.getByText('# Beta')).toBeDefined());
  expect(f.requests.some(item => item.path.endsWith('/search'))).toBe(true);
});

it("opens today's daily note, creating it once", async () => {
  const f = await fixture();
  fireEvent.click(screen.getByRole('button', { name: '今日笔记' }));
  await waitFor(() => expect(f.disk.has('日记/2026-09-13.md')).toBe(true));
  expect(screen.getByRole('heading', { name: '日记/2026-09-13' })).toBeDefined();
  expect(f.requests.filter(item => item.command?.action === 'daily')).toHaveLength(1);
});

/** One proposal fixture with a diff that adds a single line. */
const proposalFixture = () => ({
  proposal: {
    proposalId: '11111111-1111-4111-8111-111111111111', id: 'Alpha.md',
    text: '# Alpha\nreviewed\n', baseRevision: revision('# Alpha\n'), createdAt: '2026-09-13T00:00:00.000Z',
  },
  diff: {
    lines: [{ kind: 'context', text: '# Alpha' }, { kind: 'add', text: 'reviewed' }],
    added: 1, removed: 0, truncated: false,
  },
});

it('shows a pending proposal with its diff and applies it', async () => {
  const f = await fixture('zh', {}, [proposalFixture()]);
  await f.open('Alpha');
  expect(screen.getByText('待审建议')).toBeDefined();
  expect(screen.getByText(/\+ reviewed/)).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: '应用' }));
  await waitFor(() => expect(f.disk.get('Alpha.md')).toBe('# Alpha\nreviewed\n'));
  await waitFor(() => expect(screen.queryByRole('button', { name: '应用' })).toBeNull());
  expect(f.requests.some(item => item.command?.action === 'apply-proposal')).toBe(true);
});

it('discards a proposal without touching the note', async () => {
  const f = await fixture('zh', {}, [proposalFixture()]);
  await f.open('Alpha');
  fireEvent.click(screen.getByRole('button', { name: '丢弃' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '丢弃' })).toBeNull());
  expect(f.disk.get('Alpha.md')).toBe('# Alpha\n');
  expect(f.requests.some(item => item.command?.action === 'apply-proposal')).toBe(false);
});

it('shows a proposal conflict instead of overwriting the note', async () => {
  const f = await fixture('zh', {}, [proposalFixture()]);
  f.disk.set('Alpha.md', 'changed underneath\n');
  await f.open('Alpha');
  fireEvent.click(screen.getByRole('button', { name: '应用' }));
  await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('conflict'));
  expect(f.disk.get('Alpha.md')).toBe('changed underneath\n');
  // The proposal survives a refused apply, so it can be retried after a reload.
  expect(screen.getByRole('button', { name: '应用' })).toBeDefined();
});

it('gives the sidebar tab an inline SVG icon rather than a raster asset', async () => {
  const f = await fixture();
  const descriptor = f.tab();
  expect(typeof descriptor.icon).toBe('function');
  const { container } = render(React.createElement(React.Fragment, null, descriptor.icon(18)));
  const svg = container.querySelector('svg');
  expect(svg).toBeTruthy();
  expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
  expect(svg.getAttribute('stroke')).toBe('currentColor');
  // One rounded body rect, a spine and two text lines — all vector, no raster fallback.
  expect(svg.querySelectorAll('rect').length).toBe(1);
  expect(svg.querySelectorAll('path').length).toBe(2);
  expect(container.querySelector('img')).toBeNull();
});

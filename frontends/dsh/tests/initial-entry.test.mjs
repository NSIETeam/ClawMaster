import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialEntry } from '../src/initial-entry.ts';

function observable(snapshot) {
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set(value) { snapshot = value; for (const listener of [...listeners]) listener(); },
    get listenerCount() { return listeners.size; },
  };
}

function fixture() {
  const sessions = observable({ ids: [], byId: {}, phase: 'pending' });
  const workspaces = observable({ items: [], archivedSessionIds: [], phase: 'pending' });
  const lifetime = new AbortController();
  const selected = [];
  let navigation;
  let starts = 0;
  const layout = {
    beginNavigation() { starts++; navigation?.abort(); navigation = new AbortController(); return navigation.signal; },
    selectPanel(panel) { navigation?.abort(); selected.push(panel); },
  };
  const entry = createInitialEntry({ sessions: { list: sessions }, workspaces: { list: workspaces }, layout }, lifetime.signal);
  return { sessions, workspaces, lifetime, selected, layout, entry, get starts() { return starts; } };
}

function ready(f) {
  f.sessions.set({ ...f.sessions.getSnapshot(), phase: 'ready' });
  f.workspaces.set({ ...f.workspaces.getSnapshot(), phase: 'ready' });
}

test('a fresh user reaches WatchDog only after both history lists are ready, once', t => {
  const f = fixture();
  t.after(f.entry.dispose);
  f.entry.start(null);
  f.entry.start(null);
  assert.equal(f.starts, 1);
  assert.deepEqual(f.selected, []);
  f.sessions.set({ ids: [], byId: {}, phase: 'ready' });
  assert.deepEqual(f.selected, []);
  f.workspaces.set({ items: [], archivedSessionIds: [], phase: 'ready' });
  assert.deepEqual(f.selected, ['clawmaster']);
  assert.equal(f.sessions.listenerCount + f.workspaces.listenerCount, 0);
  f.layout.selectPanel(null);
  ready(f);
  f.entry.start(null);
  assert.deepEqual(f.selected, ['clawmaster', null]);
});

test('selected panels, current Sessions and every form of existing history retain their entry', t => {
  for (const scenario of ['panel', 'current', 'session', 'workspace', 'archived']) {
    const f = fixture();
    t.after(f.entry.dispose);
    if (scenario === 'current') f.sessions.set({ ids: [], byId: {}, current: 'current', phase: 'pending' });
    if (scenario === 'session') f.sessions.set({ ids: ['blank'], byId: { blank: { blank: true } }, phase: 'ready' });
    if (scenario === 'workspace') f.workspaces.set({ items: [{ workspaceId: 'existing' }], archivedSessionIds: [], phase: 'ready' });
    if (scenario === 'archived') f.workspaces.set({ items: [], archivedSessionIds: ['archived'], phase: 'ready' });
    f.entry.start(scenario === 'panel' ? 'settings' : null);
    ready(f);
    assert.deepEqual(f.selected, [], scenario);
    assert.equal(f.starts, 0, scenario);
    assert.equal(f.sessions.listenerCount + f.workspaces.listenerCount, 0, scenario);
  }
});

test('history arriving during startup permanently cancels the default entry', t => {
  const f = fixture();
  t.after(f.entry.dispose);
  f.entry.start(null);
  f.workspaces.set({ items: [{ workspaceId: 'restored' }], archivedSessionIds: [], phase: 'ready' });
  f.workspaces.set({ items: [], archivedSessionIds: [], phase: 'ready' });
  ready(f);
  assert.deepEqual(f.selected, []);
  assert.equal(f.sessions.listenerCount + f.workspaces.listenerCount, 0);
});

test('later user navigation wins even when it keeps the conversation panel selected', t => {
  for (const navigate of [f => f.layout.selectPanel('clawmaster'), f => f.layout.selectPanel(null), f => f.layout.beginNavigation()]) {
    const f = fixture();
    t.after(f.entry.dispose);
    f.entry.start(null);
    navigate(f);
    const userSelection = [...f.selected];
    ready(f);
    f.entry.start(null);
    assert.deepEqual(f.selected, userSelection);
    assert.equal(f.sessions.listenerCount + f.workspaces.listenerCount, 0);
  }
});

test('slot removal and plugin shutdown detach pending observers and prevent late navigation', () => {
  for (const dispose of [f => f.entry.dispose(), f => f.lifetime.abort()]) {
    for (const started of [false, true]) {
      const f = fixture();
      if (started) f.entry.start(null);
      dispose(f);
      ready(f);
      f.entry.start(null);
      assert.deepEqual(f.selected, []);
      assert.equal(f.sessions.listenerCount + f.workspaces.listenerCount, 0);
    }
  }
});

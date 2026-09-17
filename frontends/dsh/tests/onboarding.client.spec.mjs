/** Compiled tutorial acceptance through the product's registered DSH slots. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as JSX from 'react/jsx-runtime';
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { resolve } from 'node:path';

const cleanups = [];
let loader;
let showModal;
let closeDialog;
beforeEach(() => {
  loader = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__');
  showModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  closeDialog = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
});
afterEach(() => {
  cleanup();
  for (const dispose of cleanups.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
  for (const [key, value] of [['showModal', showModal], ['close', closeDialog]]) {
    if (value) Object.defineProperty(HTMLDialogElement.prototype, key, value);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, key);
  }
  if (loader) Object.defineProperty(window, '__ModuleLoader__', loader);
  else Reflect.deleteProperty(window, '__ModuleLoader__');
});
function source(initial) {
  let snapshot = initial;
  const listeners = new Set();
  return { getSnapshot: () => snapshot, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    publish(value) { snapshot = value; for (const listener of listeners) listener(); },
  };
}
async function fixture({ history = false, acknowledgedVersion = 0, mode = 'host', phase = 'ready', locale = 'zh' } = {}) {
  let factory;
  window.__ModuleLoader__ = { load(value) { factory = value.factory; } };
  vm.runInThisContext(await readFile(resolve('frontends/dsh/dist/client.js'), 'utf8'));
  const externals = { react: React, 'react-dom': ReactDOM, 'react/jsx-runtime': JSX };
  const plugin = factory(id => { if (!(id in externals)) throw new Error(`Unexpected runtime import: ${id}`); return externals[id]; });
  const scope = source({ status: phase === 'pending' ? 'loading' : 'ready', mode, value: { acknowledgedVersion } });
  scope.set = vi.fn(async (field, value) => { scope.publish({ ...scope.getSnapshot(), value: { [field]: value } }); });
  const sessions = source({ phase, ids: history ? ['existing'] : [], byId: {}, current: undefined });
  const workspaces = source({ phase, items: [], archivedSessionIds: [] });
  const slots = new Map();
  const disposers = [];
  cleanups.push(() => { for (const dispose of disposers.reverse()) dispose(); });
  const actions = { create: vi.fn(() => { throw new Error('Tutorial must not create Sessions'); }),
    refresh: vi.fn(), openSession: vi.fn(), selectPanel: vi.fn(), openSection: vi.fn() };
  plugin.apply({
    slots: { inject(_name, setup) { disposers.push(setup()); }, register(options, component) {
      slots.set(`${options.name}:${options.id ?? options.key ?? ''}`, component); return () => {};
    } },
    theme: { overrideTokens: () => () => {} },
    sessions: { list: sessions, create: actions.create, refresh: actions.refresh }, workspaces: { list: workspaces },
    connection: { state: source('connected') }, locale: source({ active: locale }),
    settingsScope: { bind(spec) { expect(spec.namespace).toBe('clawmaster-watchdog-onboarding'); return scope; } },
    layout: { selectPanel: actions.selectPanel }, uiWorkspace: { openSession: actions.openSession },
    betterSidebar: { registerTab: () => () => {} },
    get(name) { return name === 'betterSidebar' ? this.betterSidebar : undefined; }, on() { return () => true; },
    effect(setup) { disposers.push(setup()); },
  });
  const Automatic = slots.get('settings.onboarding:clawmaster-watchdog');
  const Settings = slots.get('settings.section:clawmaster-watchdog');
  const complete = vi.fn();
  const closed = vi.fn();
  const props = { complete, openSection: actions.openSection };
  const view = render(React.createElement(Automatic, props));
  return { scope, sessions, workspaces, actions, complete, closed, view,
    remount() { view.unmount(); return render(React.createElement(Automatic, props)); },
    review() { view.unmount(); return render(React.createElement(Settings, { close: closed })); },
    dispose() { for (const dispose of disposers.splice(0).reverse()) dispose(); },
  };
}

it('waits for real settings and history answers, then shows the first-run guide without creating a task', async () => {
  const f = await fixture({ phase: 'pending' });
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => {
    f.scope.publish({ ...f.scope.getSnapshot(), status: 'ready' });
    f.sessions.publish({ ...f.sessions.getSnapshot(), phase: 'ready' });
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => f.workspaces.publish({ ...f.workspaces.getSnapshot(), phase: 'ready' }));
  expect(screen.getByRole('dialog', { name: '用 WatchDog 管好企业日常' })).toBeDefined();
  expect(screen.getByRole('heading', { name: '确定本周要管的范围' })).toBeDefined();
  expect(f.scope.set).not.toHaveBeenCalled();
  for (const action of Object.values(f.actions)) expect(action).not.toHaveBeenCalled();
});

it.each(['button', 'escape'])('explicit %s skip persists and stays dismissed after a client remount', async method => {
  const f = await fixture();
  if (method === 'button') fireEvent.click(screen.getByRole('button', { name: '跳过教程' }));
  else fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: false, cancelable: true }));
  await waitFor(() => expect(f.complete).toHaveBeenCalled());
  expect(f.scope.set).toHaveBeenCalledWith('acknowledgedVersion', 1);
  f.remount();
  expect(screen.queryByRole('dialog')).toBeNull();
  for (const action of Object.values(f.actions)) expect(action).not.toHaveBeenCalled();
});

it('finishing opens management without starting a review or changing setup', async () => {
  const f = await fixture();
  for (let index = 0; index < 4; index++) {
    expect(screen.queryByRole('button', { name: '模型设置（按需）' })).toBeNull();
    expect(screen.queryByRole('button', { name: '聊天连接（可选）' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  }
  for (const action of Object.values(f.actions)) expect(action).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '进入 WatchDog 管理台' }));
  await waitFor(() => expect(f.complete).toHaveBeenCalledTimes(1));
  expect(f.scope.set).toHaveBeenCalledWith('acknowledgedVersion', 1);
  expect(f.actions.selectPanel).toHaveBeenCalledExactlyOnceWith('clawmaster');
  expect(f.actions.create).not.toHaveBeenCalled();
  expect(f.actions.openSession).not.toHaveBeenCalled();
  expect(f.actions.openSection).not.toHaveBeenCalled();
});

it.each([['模型设置', 'models'], ['聊天工具', 'xmanrui-dsh-im']])('the final auxiliary %s action uses the existing settings section', async (_label, section) => {
  const f = await fixture();
  for (let index = 0; index < 4; index++) fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  fireEvent.click(screen.getByRole('button', { name: section === 'models' ? '模型设置（按需）' : '聊天连接（可选）' }));
  await waitFor(() => expect(f.actions.openSection).toHaveBeenCalledWith(section));
  expect(f.scope.set).toHaveBeenCalledTimes(1);
  expect(f.actions.create).not.toHaveBeenCalled();
  expect(f.actions.openSession).not.toHaveBeenCalled();
});

it.each(['refused', 'rejected'])('a %s progress write keeps the guide open and exposes retry', async mode => {
  const f = await fixture();
  f.scope.set.mockImplementationOnce(async () => { if (mode === 'rejected') throw new Error('offline'); });
  fireEvent.click(screen.getByRole('button', { name: '跳过教程' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('教程进度未能保存'));
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.actions.openSection).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '跳过教程' }));
  await waitFor(() => expect(f.complete).toHaveBeenCalled());
});

it('existing users can replay all steps from Settings without resetting acknowledgement or credentials', async () => {
  const f = await fixture({ history: true, acknowledgedVersion: 8 });
  expect(screen.queryByRole('dialog')).toBeNull();
  f.review();
  expect(screen.getByRole('heading', { name: '确定本周要管的范围' })).toBeDefined();
  for (let index = 0; index < 4; index++) fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  fireEvent.click(screen.getByRole('button', { name: '从头再看' }));
  expect(screen.getByRole('heading', { name: '确定本周要管的范围' })).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: '跟踪任务，复核结果并落实整改' }));
  fireEvent.click(screen.getByRole('button', { name: '进入 WatchDog 管理台' }));
  await waitFor(() => expect(f.actions.selectPanel).toHaveBeenCalledWith('clawmaster'));
  expect(f.closed).toHaveBeenCalledTimes(1);
  expect(f.scope.set).not.toHaveBeenCalled();
  expect(f.actions.create).not.toHaveBeenCalled();
});

it('plugin disposal during a write prevents late settings navigation', async () => {
  const f = await fixture();
  let settle;
  f.scope.set.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: '跟踪任务，复核结果并落实整改' }));
  fireEvent.click(screen.getByRole('button', { name: '模型设置（按需）' }));
  f.dispose();
  await act(async () => { f.scope.publish({ ...f.scope.getSnapshot(), value: { acknowledgedVersion: 1 } }); settle(); });
  expect(f.actions.openSection).not.toHaveBeenCalled();
});

it('remote memory mode leaves Host settings unchanged', async () => {
  const f = await fixture({ mode: 'memory' });
  fireEvent.click(screen.getByRole('button', { name: '跳过教程' }));
  await waitFor(() => expect(f.complete).toHaveBeenCalled());
  expect(f.scope.set).not.toHaveBeenCalled();
});

it.each(['zh', 'en'])('records the rendered %s tutorial and its real controls', async locale => {
  const f = await fixture({ locale });
  const frames = [];
  for (let index = 0; index < 5; index++) {
    const dialog = screen.getByRole('dialog');
    frames.push({ introduction: dialog.querySelector('header').textContent,
      title: dialog.querySelector('h3').textContent,
      body: dialog.querySelector('.cm-tutorial-step').textContent,
      auxiliary: dialog.querySelector('.cm-tutorial-destinations p')?.textContent ?? null,
      buttons: [...dialog.querySelectorAll('button')].map(button => ({ name: button.getAttribute('aria-label') ?? button.textContent, disabled: button.disabled })) });
    if (index < 4) fireEvent.click(screen.getByRole('button', { name: locale === 'zh' ? '下一步' : 'Next' }));
  }
  const path = resolve(`frontends/dsh/tests/expected/watchdog-tutorial.${locale}.json`);
  if (process.env.DSH_UPDATE_EXPECTED === '1') await writeFile(path, JSON.stringify(frames, null, 2) + '\n');
  expect(frames).toEqual(JSON.parse(await readFile(path, 'utf8')));
  expect(f.actions.create).not.toHaveBeenCalled();
});

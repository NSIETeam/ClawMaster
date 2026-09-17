/** Tool opens cross a real React commit into DSH's Session-bound right Sidebar. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime';
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client';
import { LayoutController } from '../../../packages/client/ui-layout/src/client/service.ts';
import { apply, inject } from '../../../packages/client/ui-sidebar-right/src/client/index.ts';
import { UiWorkspaceService } from '../../../packages/client/ui-workspace/src/client/navigation.ts';
import { createProductActions } from '../src/navigation.ts';
import { observeBetterSidebar, type FrontendServices, type SessionId } from '../src/services.ts';

const runtimes: SlotTestRuntime[] = [];
let animations: PropertyDescriptor | undefined;
beforeEach(() => {
  animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
});
afterEach(async () => {
  try { for (const runtime of runtimes.splice(0)) await runtime.dispose(); }
  finally {
    vi.restoreAllMocks();
    if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
    else Reflect.deleteProperty(Element.prototype, 'getAnimations');
  }
});

async function fixture(existing: boolean) {
  const runtime = await SlotTestRuntime.create();
  runtimes.push(runtime);
  const layout = new LayoutController({
    selectPanel: activePanelId => runtime.panelInfo.set({ activePanelId }),
    openRightbar: () => {}, closeRightbar: () => {},
  } as ConstructorParameters<typeof LayoutController>[0], () => true);
  runtime.ctx.provide('layout', layout);
  runtime.ctx.effect(() => () => layout.dispose());
  runtime.ctx.provide('resources', { pin: () => {} } as never);
  const locale = new LocaleRuntime(runtime.ctx);
  runtime.ctx.provide('locale', locale);
  runtime.slots.installLocale(locale);
  await runtime.declare({
    rightbar: { kind: 'single', scope: 'root' },
    'conversation.session.header.corner': { kind: 'single', scope: 'session' },
  });
  await act(async () => { layout.selectPanel('clawmaster' as never); });
  if (existing) await runtime.sessions.add({ id: 'existing', summary: { cwd: '/existing', blank: true } });
  runtime.sessions.stubCreate(async () => runtime.sessions.add({
    id: 'created', summary: { cwd: '/managed/desk', blank: true },
  }, { current: false }));
  await runtime.mount({ inject: [...inject], apply });
  for (const kind of ['files', 'browser']) {
    runtime.ctx.sidebarRightTabs.register({ id: `acceptance/${kind}`, kind, title: () => kind });
    runtime.slots.register({ name: 'sidebar.right.pane.tab', key: `acceptance/${kind}` }, () => <div data-acceptance-kind={kind} />);
  }
  const view = runtime.renderSlot('rightbar', { width: 420, viewportWidth: 1440, canShow: true });
  const trace: string[] = [];
  let afterBind: (() => void) | undefined;
  const controller = runtime.ctx.sidebarRight;
  const bind = controller.bind.bind(controller);
  vi.spyOn(controller, 'bind').mockImplementation(binding => {
    trace.push(`bind:${binding.sessionId}`);
    const release = bind(binding);
    afterBind?.();
    return release;
  });
  const uiWorkspace = new UiWorkspaceService(runtime.ctx, {} as never, runtime.workspaces, runtime.sessions);
  const betterSidebar = {
    isTabEnabled: () => true,
    openTab(seed: { type: string; target?: string }, scope: { sessionId: SessionId; cwd: string }) {
      trace.push(`open:${scope.sessionId}:${seed.type}:${seed.target}`);
      if (seed.target !== 'bottom') controller.openTab(seed.type === 'editor' ? 'files' : seed.type);
    },
  };
  const lifetime = new AbortController();
  runtime.ctx.effect(() => () => lifetime.abort());
  const services = { sessions: runtime.sessions, workspaces: runtime.workspaces, layout, uiWorkspace, betterSidebar, get(name: string) { return name === 'betterSidebar' ? betterSidebar : undefined; } } as unknown as FrontendServices;
  const actions = createProductActions(services, lifetime.signal, async () => Response.json({ workspaceId: 'managed', path: '/managed/desk' }));
  return { runtime, layout, controller, uiWorkspace, trace, actions, lifetime, view,
    onBind(callback: () => void) { afterBind = callback; },
  };
}

it('the original same-turn open fails before the real RightbarSeat effect binds', async () => {
  const f = await fixture(true);
  expect(f.controller.active()).toBeUndefined();
  act(() => {
    f.uiWorkspace.openSession('existing' as never);
    expect(() => f.controller.openTab('files')).toThrow('no session surface is mounted');
  });
  expect(f.trace).toContain('bind:existing');
});

it('uses Cordis optional service lookup and registers tabs when Better Sidebar activates later', async () => {
  const runtime = await SlotTestRuntime.create();
  runtimes.push(runtime);
  let actions: ReturnType<typeof createProductActions> | undefined;
  const registered: string[] = [];
  const unregistered: string[] = [];
  await runtime.mount({
    inject: [],
    apply(ctx) {
      expect(() => Reflect.get(ctx, 'betterSidebar')).toThrow(/cannot get property "betterSidebar" without inject/);
      actions = createProductActions(ctx as unknown as FrontendServices, new AbortController().signal);
      observeBetterSidebar(ctx as unknown as FrontendServices, service => {
        registered.push(String(service));
        return () => { unregistered.push(String(service)); };
      });
    },
  });
  await expect(actions!.open('editor', 'en-US')).rejects.toMatchObject({ code: 'toolDisabled' });
  expect(registered).toEqual([]);

  const sidebarService = {};
  await runtime.mount({ inject: [], apply(ctx) { ctx.provide('betterSidebar', sidebarService); } });
  expect(registered).toEqual(['[object Object]']);
  expect(unregistered).toEqual([]);
});

it.each([false, true])('commits the native Session seat before opening editor (existing=%s)', async existing => {
  const f = await fixture(existing);
  const id = existing ? 'existing' : 'created';
  if (existing) expect(f.view.container.querySelector<HTMLElement>('[data-sidebar-right-panel]')?.hidden).toBe(true);
  else expect(f.view.container.querySelector('[data-sidebar-right-panel]')).toBeNull();
  await act(async () => { await f.actions.open('editor', 'en-US'); });
  expect(f.trace.indexOf(`bind:${id}`)).toBeLessThan(f.trace.indexOf(`open:${id}:editor:right`));
  expect(f.controller.active()?.kind).toBe('files');
  expect(f.controller.isExpanded()).toBe(true);
  expect(f.view.container.querySelector('[data-acceptance-kind="files"]')).not.toBeNull();
  if (!existing) expect(f.runtime.sessions.calls.filter(call => call.method === 'create')).toHaveLength(1);
});

it('reopens browser after a global-panel visit and preserves the existing Session', async () => {
  const f = await fixture(true);
  await act(async () => { await f.actions.open('editor', 'en-US'); });
  act(() => { f.layout.selectPanel('clawmaster' as never); });
  expect(f.controller.active()).toBeUndefined();
  f.trace.length = 0;
  await act(async () => { await f.actions.open('browser', 'en-US'); });
  expect(f.trace.indexOf('bind:existing')).toBeLessThan(f.trace.indexOf('open:existing:browser:right'));
  expect(f.controller.active()?.kind).toBe('browser');
  expect(f.runtime.sessions.calls.filter(call => call.method === 'create')).toHaveLength(0);
});

it('terminal keeps its bottom target after the conversation commits', async () => {
  const f = await fixture(true);
  await act(async () => { await f.actions.open('terminal', 'en-US'); });
  expect(f.trace.indexOf('bind:existing')).toBeLessThan(f.trace.indexOf('open:existing:terminal:bottom'));
  expect(f.controller.isExpanded()).toBe(false);
});

it.each(['navigate', 'dispose'])('a %s during the Session commit prevents a late tool open', async mode => {
  const f = await fixture(true);
  f.onBind(() => {
    if (mode === 'navigate') f.layout.selectPanel('clawmaster' as never);
    else f.lifetime.abort();
  });
  await act(async () => { await f.actions.open('editor', 'en-US'); });
  expect(f.trace.some(event => event.startsWith('bind:'))).toBe(true);
  expect(f.trace.some(event => event.startsWith('open:'))).toBe(false);
  if (mode === 'navigate') expect(f.runtime.panelInfo.getSnapshot().activePanelId).toBe('clawmaster');
});

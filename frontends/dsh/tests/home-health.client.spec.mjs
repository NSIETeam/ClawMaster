import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { HomeHealth } from '../src/HomeHealth.tsx';
import { hasRecordedModelResponse, observeModelResponses } from '../src/home-model-evidence.ts';

// Each case must read its own render: without cleanup a later case sees the text of every earlier one.
afterEach(cleanup);

it('counts only durable assistant messages as model-response evidence', () => {
  expect(hasRecordedModelResponse({ entries: [{ type: 'event', event: { type: 'assistant/message', data: { interrupted: false } } }] })).toBe(true);
  expect(hasRecordedModelResponse({ entries: [{ type: 'event', event: { type: 'assistant/message', data: { interrupted: true } } }] })).toBe(false);
  expect(hasRecordedModelResponse({ entries: [{ type: 'event', event: { type: 'assistant/attempt' } }] })).toBe(false);
  expect(hasRecordedModelResponse({ entries: [{ type: 'transient', event: { type: 'assistant/live-chunk' } }] })).toBe(false);
});

it('observes newly recorded responses on loaded Session event sources and unsubscribes', () => {
  let snapshot = { entries: [] };
  const listeners = new Set();
  const source = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  let observed = 0;
  const dispose = observeModelResponses([source], () => observed++);
  expect(observed).toBe(0);
  snapshot = { entries: [{ type: 'event', event: { type: 'assistant/message', data: { interrupted: false } } }] };
  for (const listener of listeners) listener();
  expect(observed).toBe(1);
  dispose();
  expect(listeners.size).toBe(0);
});

it('shows app, model, schedule and business health as separate observations', () => {
  render(createElement(HomeHealth, { locale: 'en-US', state: {
    app: 'connected', model: 'unverified',
    schedule: { error: false, observedAt: 1_800_000_000_000, total: 1, online: 1, offline: 0, degraded: 0, failed: 2, uncertain: 1 },
    business: { total: 7, review: 2, failed: 1, overdue: 1, error: false },
    components: { observed: true, available: true, components: 9, disabled: 0, refused: false, observedAt: '2026-09-22T00:00:00.000Z' },
  } }));
  expect(screen.getByRole('region', { name: 'Business outcomes' })).toBeTruthy();
  expect(screen.getByText('7 loaded; 2 awaiting review, 1 failed, 1 overdue')).toBeTruthy();
  expect(screen.getByText('App service connected').closest('details').open).toBe(false);
  fireEvent.click(screen.getAllByText('Runtime and service details').at(-1));
  expect(screen.getByText('App service connected').getAttribute('data-health')).toBe('connected');
  expect(screen.getByText('No successful response observed in loaded Sessions').getAttribute('data-health')).toBe('unverified');
  expect(screen.getByText('Workers online', { selector: 'dd' }).getAttribute('data-health')).toBe('attention');
  expect(screen.getByRole('alert').textContent).toContain('2 failed, 1 delivery outcomes uncertain');
  expect(screen.getByText('7 loaded; 2 awaiting review, 1 failed, 1 overdue').getAttribute('data-health')).toBe('attention');
});

it('reports missing worker observations and unavailable business data without inventing health', () => {
  render(createElement(HomeHealth, { locale: 'zh-CN', state: {
    app: 'disconnected', model: 'unverified',
    schedule: { error: true, observedAt: null, total: null, online: 0, offline: 0, degraded: 0, failed: 0, uncertain: 0 },
    business: { total: 0, review: 0, failed: 0, overdue: 0, error: true },
    components: { observed: true, available: true, components: 9, disabled: 0, refused: false, observedAt: '2026-09-22T00:00:00.000Z' },
  } }));
  expect(screen.getByText('业务任务暂不可读取，请刷新后核对。')).toBeTruthy();
  expect(screen.getByText('应用服务连接已断开').closest('details').open).toBe(false);
  fireEvent.click(screen.getByText('运行与服务详情'));
  expect(screen.getByText('应用服务连接已断开').getAttribute('data-health')).toBe('disconnected');
  expect(screen.getByText('尚未在已载入会话中观察到成功响应').getAttribute('data-health')).toBe('unverified');
  expect(screen.getByText('读取失败，请刷新巡检状态').getAttribute('data-health')).toBe('attention');
  expect(screen.getByText('业务任务暂不可读取，请刷新后核对。').getAttribute('data-health')).toBe('attention');
});

it('names the layers that need attention without being expanded', () => {
  render(createElement(HomeHealth, { locale: 'en-US', state: {
    app: 'connected', model: 'verified',
    schedule: { error: false, observedAt: null, total: 2, online: 1, offline: 1, degraded: 0, failed: 0, uncertain: 0 },
    business: { total: 3, review: 1, failed: 0, overdue: 0, error: false },
    components: { observed: true, available: true, components: 9, disabled: 0, refused: false, observedAt: '2026-09-22T00:00:00.000Z' },
  } }));
  const line = screen.getByText(/Needs attention: .+/);
  expect(line.closest('details')).toBe(null);
  expect(line.getAttribute('data-health')).toBe('attention');
  expect(line.textContent).toContain('Scheduled execution');
  expect(line.textContent).toContain('Business outcomes');
  expect(line.textContent).toContain('does not replace checking the records');
});

it('states that each layer is observed separately when nothing needs attention', () => {
  render(createElement(HomeHealth, { locale: 'en-US', state: {
    app: 'connected', model: 'unverified',
    schedule: { error: false, observedAt: null, total: 1, online: 1, offline: 0, degraded: 0, failed: 0, uncertain: 0 },
    business: { total: 0, review: 0, failed: 0, overdue: 0, error: false },
    components: { observed: true, available: true, components: 9, disabled: 0, refused: false, observedAt: '2026-09-22T00:00:00.000Z' },
  } }));
  const line = screen.getByText(/Each layer is observed separately/);
  expect(line.closest('details')).toBe(null);
  expect(line.getAttribute('data-health')).toBe('observed');
});

it('does not treat an unobserved model as a layer that needs attention', () => {
  render(createElement(HomeHealth, { locale: 'zh-CN', state: {
    app: 'connected', model: 'unverified',
    schedule: { error: false, observedAt: null, total: null, online: 0, offline: 0, degraded: 0, failed: 0, uncertain: 0 },
    business: { total: 0, review: 0, failed: 0, overdue: 0, error: false },
    components: { observed: true, available: true, components: 9, disabled: 0, refused: false, observedAt: '2026-09-22T00:00:00.000Z' },
  } }));
  const line = screen.getByText(/各层状态分别观测/);
  expect(line.textContent).not.toContain('模型');
  expect(line.getAttribute('data-health')).toBe('observed');
});

it('reports a recorded model response without claiming current provider availability', () => {
  render(createElement(HomeHealth, { locale: 'en-US', state: {
    app: 'connected', model: 'verified',
    schedule: { error: false, observedAt: null, total: null, online: 0, offline: 0, degraded: 0, failed: 0, uncertain: 0 },
    business: { total: 0, review: 0, failed: 0, overdue: 0, error: false },
    components: { observed: true, available: true, components: 9, disabled: 0, refused: false, observedAt: '2026-09-22T00:00:00.000Z' },
  } }));
  expect(screen.getByText('Successful model response recorded').closest('details').open).toBe(false);
  fireEvent.click(screen.getAllByText('Runtime and service details').at(-1));
  expect(screen.getByText('Successful model response recorded').getAttribute('data-health')).toBe('verified');
  expect(screen.getByText('No worker heartbeat observed').getAttribute('data-health')).toBe('unobserved');
  expect(screen.getByText('This proves a Session response succeeded before; it does not prove current availability.')).toBeTruthy();
});

it('shows component health as its own layer and names it when a plugin is disabled', () => {
  render(createElement(HomeHealth, { locale: 'en-US', state: {
    app: 'connected', model: 'verified',
    schedule: { error: false, observedAt: null, total: 1, online: 1, offline: 0, degraded: 0, failed: 0, uncertain: 0 },
    business: { total: 0, review: 0, failed: 0, overdue: 0, error: false },
    components: { observed: true, available: true, components: 9, disabled: 2, refused: false, observedAt: '2026-09-22T00:00:00.000Z' },
  } }));
  const line = screen.getByText(/Needs attention: .+/);
  expect(line.textContent).toContain('Component health');
  expect(line.textContent).not.toContain('Scheduled execution');
  fireEvent.click(screen.getAllByText('Runtime and service details').at(-1));
  expect(screen.getByText('2 plugins disabled on this Host', { selector: 'dd' }).getAttribute('data-health')).toBe('attention');
  expect(screen.getByText('This records the Host runtime record; it does not verify each component works.')).toBeTruthy();
});

it('reports a refused or unread component route as unobserved rather than healthy', () => {
  render(createElement(HomeHealth, { locale: 'zh-CN', state: {
    app: 'connected', model: 'verified',
    schedule: { error: false, observedAt: null, total: 1, online: 1, offline: 0, degraded: 0, failed: 0, uncertain: 0 },
    business: { total: 0, review: 0, failed: 0, overdue: 0, error: false },
    components: { observed: false, available: false, components: null, disabled: 0, refused: true, observedAt: null },
  } }));
  expect(screen.getByText(/各层状态分别观测/).getAttribute('data-health')).toBe('observed');
  fireEvent.click(screen.getByText('运行与服务详情'));
  expect(screen.getByText('组件状态只在本地桌面提供，未在此提供').getAttribute('data-health')).toBe('unobserved');
  expect(screen.getByText('组件状态只在本地桌面提供，未在此提供').closest('div').querySelector('dd').textContent).not.toContain('已载入');
});

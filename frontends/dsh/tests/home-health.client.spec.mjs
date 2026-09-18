import { expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { HomeHealth } from '../src/HomeHealth.tsx';
import { hasRecordedModelResponse, observeModelResponses } from '../src/home-model-evidence.ts';

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
  } }));
  expect(screen.getByText('业务任务暂不可读取，请刷新后核对。')).toBeTruthy();
  expect(screen.getByText('应用服务连接已断开').closest('details').open).toBe(false);
  fireEvent.click(screen.getByText('运行与服务详情'));
  expect(screen.getByText('应用服务连接已断开').getAttribute('data-health')).toBe('disconnected');
  expect(screen.getByText('尚未在已载入会话中观察到成功响应').getAttribute('data-health')).toBe('unverified');
  expect(screen.getByText('读取失败，请刷新巡检状态').getAttribute('data-health')).toBe('attention');
  expect(screen.getByText('业务任务暂不可读取，请刷新后核对。').getAttribute('data-health')).toBe('attention');
});

it('reports a recorded model response without claiming current provider availability', () => {
  render(createElement(HomeHealth, { locale: 'en-US', state: {
    app: 'connected', model: 'verified',
    schedule: { error: false, observedAt: null, total: null, online: 0, offline: 0, degraded: 0, failed: 0, uncertain: 0 },
    business: { total: 0, review: 0, failed: 0, overdue: 0, error: false },
  } }));
  expect(screen.getByText('Successful model response recorded').closest('details').open).toBe(false);
  fireEvent.click(screen.getAllByText('Runtime and service details').at(-1));
  expect(screen.getByText('Successful model response recorded').getAttribute('data-health')).toBe('verified');
  expect(screen.getByText('No worker heartbeat observed').getAttribute('data-health')).toBe('unobserved');
  expect(screen.getByText('This proves a Session response succeeded before; it does not prove current availability.')).toBeTruthy();
});

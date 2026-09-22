/** A throwing panel must leave a readable alert in place, and only that panel. */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { RenderBoundary } from '../src/RenderBoundary.tsx';

afterEach(cleanup);

/** A panel that throws while its module flag is set, so a retry can succeed. */
let broken = true;
function Fragile() {
  if (broken) throw new Error('panel exploded');
  return createElement('p', null, 'panel recovered');
}

it('replaces a throwing panel with an alert that names the failure', () => {
  // React reports the caught error to the console; the boundary's own report is expected.
  const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
  broken = true;
  render(createElement(RenderBoundary, { locale: 'en-US', scope: 'main' }, createElement(Fragile)));
  const alert = screen.getByRole('alert');
  expect(alert.getAttribute('data-scope')).toBe('main');
  expect(alert.textContent).toContain('This panel failed to render and was isolated in place');
  expect(alert.textContent).toContain('panel exploded');
  expect(screen.queryByText('panel recovered')).toBe(null);
  expect(reported).toHaveBeenCalled();
  reported.mockRestore();
});

it('keeps the failure local so a sibling panel still renders', () => {
  const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
  broken = true;
  render(createElement('div', null,
    createElement(RenderBoundary, { locale: 'en-US', scope: 'main' }, createElement(Fragile)),
    createElement(RenderBoundary, { locale: 'en-US', scope: 'sidebar' }, createElement('p', null, 'sidebar is fine'))));
  expect(screen.getByText('sidebar is fine')).toBeTruthy();
  expect(screen.getByRole('alert').getAttribute('data-scope')).toBe('main');
  reported.mockRestore();
});

it('recovers the panel on retry once the cause is gone', () => {
  const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
  broken = true;
  render(createElement(RenderBoundary, { locale: 'zh-CN', scope: 'main' }, createElement(Fragile)));
  expect(screen.getByText(/这块面板渲染失败/)).toBeTruthy();
  broken = false;
  fireEvent.click(screen.getByText('重试'));
  expect(screen.getByText('panel recovered')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBe(null);
  reported.mockRestore();
});

it('renders its children untouched while nothing throws', () => {
  render(createElement(RenderBoundary, { locale: 'zh-CN', scope: 'main' }, createElement('p', null, '正文')));
  expect(screen.getByText('正文')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBe(null);
});

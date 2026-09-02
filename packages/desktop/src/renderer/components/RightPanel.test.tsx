/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModuleDefinition } from '../moduleCatalog.js';
import type { ModuleWorkspaceLayout } from '../moduleWorkspace.js';
import { RightPanel } from './RightPanel.js';

const layout: ModuleWorkspaceLayout = {
  version: 1,
  groups: [{ id: 'daily', name: '日常办公', rows: 2, moduleIds: ['agent-ppt'] }],
};
const modules: ModuleDefinition[] = [{
  id: 'agent-ppt', label: 'PPT 创作专家', category: 'common', icon: 'agent',
  activation: { kind: 'agent', profileId: 'ppt' }, availability: 'available',
}];
const layoutWithPlatform: ModuleWorkspaceLayout = {
  version: 1,
  groups: [
    ...layout.groups,
    { id: 'business-platforms', name: '业务平台', rows: 2, moduleIds: ['platform-zhifang'] },
  ],
};

function renderPanel(overrides: Partial<React.ComponentProps<typeof RightPanel>> = {}) {
  const props: React.ComponentProps<typeof RightPanel> = {
    busy: false, ready: true, scopeKey: 'scope', layout, modules,
    onActivate: vi.fn(), onOpenMarketplace: vi.fn(), onLayoutChange: vi.fn(), ...overrides,
  };
  return { ...render(<RightPanel {...props}/>), props };
}

describe('RightPanel module workspace boundary', () => {
  beforeEach(() => {
    (window as unknown as { otto: unknown }).otto = {
      extractEditableDocument: vi.fn(async (filePath: string) => ({
        filePath,
        fileName: '方案.md',
        sourceFormat: 'markdown',
        content: '# 方案',
        message: '已打开文件。',
      })),
    };
  });

  it('renders functional groups instead of legacy tabs', () => {
    renderPanel();
    expect(screen.getByRole('heading', { name: '日常办公' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开 PPT 创作专家' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '功能' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '文件' })).toBeNull();
    expect(screen.queryByRole('tab', { name: '专家' })).toBeNull();
    expect(screen.queryByRole('tab', { name: '企业记忆' })).toBeNull();
  });

  it('reveals the file editor only after a generated file is opened', () => {
    renderPanel();
    fireEvent(window, new CustomEvent('clawmaster:edit-local-file', { detail: { path: '/tmp/方案.md' } }));
    expect(screen.getByRole('region', { name: '文件编辑器' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '文件' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '功能' }));
    expect(screen.getByRole('heading', { name: '日常办公' })).toBeTruthy();
  });

  it('opens a selected business platform directly inside the right sidebar', () => {
    renderPanel({ layout: layoutWithPlatform });
    fireEvent(window, new CustomEvent('clawmaster:open-platform', { detail: { id: 'platform-zhifang', label: '知访', url: 'https://47.116.30.60/' } }));
    expect(screen.getByRole('region', { name: '知访平台工作区' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '知访' }).getAttribute('aria-selected')).toBe('true');
  });

  it('removes a platform tab when the platform is closed or removed from the layout', () => {
    const { rerender, props } = renderPanel({ layout: layoutWithPlatform });
    fireEvent(window, new CustomEvent('clawmaster:open-platform', { detail: { id: 'platform-zhifang', label: '知访', url: 'https://47.116.30.60/' } }));
    fireEvent.click(screen.getByRole('button', { name: '关闭平台' }));
    expect(screen.queryByRole('tab', { name: '知访' })).toBeNull();

    fireEvent(window, new CustomEvent('clawmaster:open-platform', { detail: { id: 'platform-zhifang', label: '知访', url: 'https://47.116.30.60/' } }));
    rerender(<RightPanel {...props} layout={layout} />);
    expect(screen.queryByRole('tab', { name: '知访' })).toBeNull();
  });

  it('delegates module activation and marketplace opening', () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '打开 PPT 创作专家' }));
    fireEvent.click(screen.getByRole('button', { name: '向日常办公添加模块' }));
    expect(props.onActivate).toHaveBeenCalledWith(modules[0]);
    expect(props.onOpenMarketplace).toHaveBeenCalledWith('daily');
  });

  it('preserves collapsed panel state but never collapses page presentation', () => {
    const { rerender, container } = renderPanel({ collapsed: true });
    expect(container.querySelector('aside')?.getAttribute('aria-hidden')).toBe('true');
    rerender(<RightPanel busy={false} ready scopeKey="scope" layout={layout} modules={modules} presentation="page" collapsed onActivate={vi.fn()} onOpenMarketplace={vi.fn()} onLayoutChange={vi.fn()}/>);
    expect(container.querySelector('aside')?.hasAttribute('aria-hidden')).toBe(false);
  });

  it('shows a non-actionable readiness state before capabilities resolve', () => {
    renderPanel({ ready: false });
    expect(screen.getByRole('status').textContent).toContain('正在加载可用模块');
    expect(screen.queryByRole('button', { name: '打开 PPT 创作专家' })).toBeNull();
  });

  it('shows an explicit retry state when capability loading fails', () => {
    const retry = vi.fn();
    renderPanel({ ready: false, readiness: 'failed', onRetryCapabilities: retry });
    expect(screen.getByRole('status').textContent).toContain('暂时无法加载');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

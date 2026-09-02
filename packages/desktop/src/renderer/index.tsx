/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer 入口。挂载 App 到 #root。
 *
 * 对照 webview src/index.tsx：那边先 acquireVsCodeApi() 存 window.vscode；
 * 这边的等价物是 preload 注入的 window.otto（见 ../preload/index.ts），
 * renderer 经 ./transport 使用，无需在此初始化。
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { installTauriHostBridge } from './hostBridge.js';
import { startRendererThemeSync } from './themeSync.js';

declare const __CLAWMASTER_BROWSER_PREVIEW__: boolean;

class RendererErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('[clawmaster] renderer crashed', error);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main style={{ padding: 24, color: '#ffb4ab', whiteSpace: 'pre-wrap' }}>
        <h1 style={{ fontSize: 20 }}>ClawMaster 界面启动失败</h1>
        <p>{this.state.error.message}</p>
      </main>
    );
  }
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 容器');
}

async function bootstrap(): Promise<void> {
  startRendererThemeSync();
  installTauriHostBridge();
  if (!window.otto) {
    if (!__CLAWMASTER_BROWSER_PREVIEW__) {
      throw new Error('ClawMaster 桌面宿主桥未就绪');
    }
    await import('./browserPreviewBridge.js');
  }
  const { App } = await import('./App.js');
  createRoot(container!).render(
    <React.StrictMode>
      <RendererErrorBoundary>
        <App />
      </RendererErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  container.textContent = `ClawMaster 启动失败：${message}`;
  container.style.padding = '24px';
  container.style.boxSizing = 'border-box';
  container.style.color = '#ffb4ab';
  console.error('[clawmaster] renderer bootstrap failed', error);
});

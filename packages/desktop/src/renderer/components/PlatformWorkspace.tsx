/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import React, { useLayoutEffect, useRef, useState } from 'react';
import type { PlatformWebviewBounds } from '../../preload/index.js';

export interface PlatformWorkspaceTarget {
  id: string;
  label: string;
  url: string | null;
}

export function PlatformWorkspace({
  target,
  onClose,
}: {
  target: PlatformWorkspaceTarget;
  onClose?: () => void;
}): React.JSX.Element {
  const [configuredUrl, setConfiguredUrl] = useState(target.url ?? '');
  const [browserState, setBrowserState] = useState<'idle' | 'loading' | 'embedded' | 'external' | 'failed'>('idle');
  const browserHostRef = useRef<HTMLDivElement>(null);
  const insecure = target.url?.startsWith('http://') === true;

  useLayoutEffect(() => {
    const host = browserHostRef.current;
    const url = target.url;
    if (!host || !url) return undefined;
    const bridge = window.clawmaster;
    const openEmbedded = bridge?.platformWebviewOpen;
    if (!openEmbedded) {
      setBrowserState('external');
      void bridge?.openExternal?.(url);
      return undefined;
    }

    let disposed = false;
    let opened = false;
    const measure = (): PlatformWebviewBounds | null => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;
      return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    const initialBounds = measure();
    if (!initialBounds) return undefined;
    setBrowserState('loading');
    void openEmbedded(url, initialBounds).then(() => {
      opened = true;
      if (disposed) {
        void bridge.platformWebviewClose?.();
        return;
      }
      setBrowserState('embedded');
      const latest = measure();
      if (latest) void bridge.platformWebviewSetBounds?.(latest);
    }).catch(() => {
      if (disposed) return;
      setBrowserState('failed');
      void bridge.openExternal(url);
    });

    const updateBounds = (): void => {
      if (!opened) return;
      const bounds = measure();
      if (bounds) void bridge.platformWebviewSetBounds?.(bounds);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateBounds);
    observer?.observe(host);
    window.addEventListener('resize', updateBounds);
    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener('resize', updateBounds);
      void bridge.platformWebviewClose?.();
    };
  }, [target.id, target.url]);

  const saveEndpoint = (): void => {
    try {
      const url = new URL(configuredUrl.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid');
      window.localStorage.setItem(`clawmaster.platform.${target.id}.url`, url.toString());
      window.location.reload();
    } catch {
      setConfiguredUrl('');
    }
  };

  return (
    <section className="claw-platform-workspace" aria-label={`${target.label}平台工作区`}>
      <header>
        <div><strong>{target.label}</strong><small>平台控制工作区</small></div>
        <div className="claw-platform-workspace__actions">
          {browserState === 'embedded' ? <button type="button" onClick={() => void window.clawmaster.platformWebviewReload?.()}>刷新</button> : null}
          <button type="button" disabled={!target.url} onClick={() => target.url && void window.clawmaster.openExternal(target.url)}>系统浏览器</button>
          {onClose ? <button type="button" onClick={onClose}>关闭平台</button> : null}
        </div>
      </header>
      <code className="claw-platform-workspace__url">{target.url ?? '尚未配置平台地址'}</code>
      {!target.url ? <div className="claw-platform-workspace__config" role="group" aria-label="平台地址配置">
        <label>平台地址（优先 HTTPS）<input value={configuredUrl} onChange={(event) => setConfiguredUrl(event.target.value)} placeholder="https://your-platform.example" /></label>
        <button type="button" onClick={saveEndpoint}>保存并连接</button>
        <div role="status">ClawMaster 不会内置或猜测生产地址，也不会要求在对话中发送凭据。</div>
      </div> : null}
      {insecure ? <div className="claw-platform-workspace__warning" role="alert">该平台当前使用 HTTP，登录和业务数据传输未加密。建议平台尽快启用 HTTPS。</div> : null}
      {target.url ? <div ref={browserHostRef} className="claw-platform-workspace__browser" aria-label={`${target.label}内置浏览器`}>
        {browserState === 'loading' ? '正在启动内置浏览器…' : null}
        {browserState === 'external' ? '当前桌面壳不支持内置浏览器，已使用系统浏览器打开。' : null}
        {browserState === 'failed' ? '内置浏览器启动失败，已回退系统浏览器。' : null}
      </div> : null}
      {target.url ? <div role="status">{browserState === 'embedded' ? `已在 ClawMaster 内打开 ${target.label}。` : `正在连接 ${target.label}。`}</div> : null}
    </section>
  );
}

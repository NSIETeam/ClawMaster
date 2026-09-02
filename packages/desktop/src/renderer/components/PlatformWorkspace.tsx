/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React from 'react';

export interface PlatformWorkspaceTarget {
  id: string;
  label: string;
  url: string;
}

export function PlatformWorkspace({
  target,
  onClose,
}: {
  target: PlatformWorkspaceTarget;
  onClose?: () => void;
}): React.JSX.Element {
  const insecure = target.url.startsWith('http://');

  return (
    <section className="otto-platform-workspace" aria-label={`${target.label}平台工作区`}>
      <header>
        <div><strong>{target.label}</strong><small>平台控制工作区</small></div>
        <div className="otto-platform-workspace__actions">
          <button type="button" onClick={() => void window.otto.openExternal(target.url)}>系统浏览器</button>
          {onClose ? <button type="button" onClick={onClose}>关闭平台</button> : null}
        </div>
      </header>
      <code className="otto-platform-workspace__url">{target.url}</code>
      {insecure ? <div className="otto-platform-workspace__warning" role="alert">该平台当前使用 HTTP，登录和业务数据传输未加密。建议平台尽快启用 HTTPS。</div> : null}
      <iframe title={`${target.label}工作台`} src={target.url} sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-downloads" referrerPolicy="strict-origin-when-cross-origin" />
      <div role="status">已按平台登记地址加载 {target.label}；高风险写操作仍需 ClawMaster 确认。</div>
    </section>
  );
}

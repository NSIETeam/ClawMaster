/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import React, { useState } from 'react';

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
  const [configuredUrl, setConfiguredUrl] = useState(target.url ?? '');
  const insecure = target.url?.startsWith('http://') === true;

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
          <button type="button" disabled={!target.url} onClick={() => target.url && void window.clawmaster.openExternal(target.url)}>系统浏览器</button>
          {onClose ? <button type="button" onClick={onClose}>关闭平台</button> : null}
        </div>
      </header>
      <code className="claw-platform-workspace__url">{target.url ?? '尚未配置平台地址'}</code>
      {!target.url ? <div className="claw-platform-workspace__config" role="group" aria-label="平台地址配置">
        <label>平台 HTTPS 地址<input value={configuredUrl} onChange={(event) => setConfiguredUrl(event.target.value)} placeholder="https://your-platform.example" /></label>
        <button type="button" onClick={saveEndpoint}>保存并连接</button>
        <div role="status">ClawMaster 不会内置或猜测生产地址，也不会要求在对话中发送凭据。</div>
      </div> : null}
      {insecure ? <div className="claw-platform-workspace__warning" role="alert">该平台当前使用 HTTP，登录和业务数据传输未加密。建议平台尽快启用 HTTPS。</div> : null}
      {target.url ? <iframe title={`${target.label}工作台`} src={target.url} sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-downloads" referrerPolicy="strict-origin-when-cross-origin" /> : null}
      {target.url ? <div role="status">已按平台登记地址加载 {target.label}；高风险写操作仍需 ClawMaster 确认。</div> : null}
    </section>
  );
}

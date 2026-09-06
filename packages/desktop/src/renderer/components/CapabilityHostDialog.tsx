import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  NativeCapabilityResources,
  NativeInstalledCapability,
} from '../../preload/index.js';
import { useModalDialog } from './useModalDialog.js';

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

const HEAVY_CAPABILITIES = ['Office 转换', 'OCR 识别', '语音处理', '视频处理', '复杂分析'];

export function CapabilityHostDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose(): void;
}): React.JSX.Element | null {
  const [installed, setInstalled] = useState<NativeInstalledCapability[]>([]);
  const [resources, setResources] = useState<NativeCapabilityResources | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const modal = useModalDialog(open, onClose, !busy);

  const refresh = useCallback((): void => {
    const list = window.clawmaster.capabilityList;
    const snapshot = window.clawmaster.capabilityResources;
    if (!list || !snapshot) {
      setStatus('当前桌面壳尚未启用 Dawn 原生能力宿主。');
      return;
    }
    setBusy(true);
    setStatus('正在读取原生能力状态…');
    void Promise.all([list(), snapshot()])
      .then(([nextInstalled, nextResources]) => {
        setInstalled(nextInstalled);
        setResources(nextResources);
        setStatus('');
      })
      .catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  if (!open) return null;
  return createPortal(
    <div className="claw-module-marketplace-overlay" onMouseDown={modal.onBackdropMouseDown}>
      <div ref={modal.dialogRef} className="claw-module-marketplace claw-customer-module-market" role="dialog" aria-modal="true" aria-label="Dawn 能力运行时" onKeyDown={modal.onKeyDown}>
        <header className="claw-module-marketplace__header">
          <div><h2>Dawn 能力运行时</h2><p>重型实现按需加载，空闲时保持零 worker</p></div>
          <button ref={modal.closeRef} type="button" aria-label="关闭能力运行时" disabled={busy} onClick={onClose}>×</button>
        </header>
        <div className="claw-module-marketplace__catalog">
          {resources ? <section className="claw-customer-module-market__section" aria-label="资源预算">
            <h3>当前资源</h3>
            <p>已加载实现 {resources.loadedImplementations} · worker {resources.activeWorkers} · 活跃 Agent {resources.activeAgents} · 排队 {resources.queuedAgents}</p>
            <p>受信任签名源 {resources.trustedKeyCount} · 输出上限 {formatBytes(resources.maxOutputBytes)} · 事件队列 {resources.maxEventQueue} · 超时 {resources.maxTimeoutSeconds} 秒</p>
          </section> : null}
          {resources?.trustedKeyCount === 0 ? <section className="claw-customer-module-market__section" aria-label="按需能力可用性">
            <h3>按需能力</h3>
            <p role="status">未配置第一方签名信任根，重型能力当前不可安装。ClawMaster 不会静默下载或绕过验签。</p>
            {HEAVY_CAPABILITIES.map((name) => <article key={name} className="claw-customer-module-market__card">
              <span className="claw-module-marketplace__module-copy"><strong>{name}</strong><small>等待可信第一方能力包</small></span>
              <span className="claw-customer-module-market__actions"><button type="button" disabled>不可安装</button></span>
            </article>)}
          </section> : null}
          <section className="claw-customer-module-market__section" aria-label="已安装能力包">
            <h3>已安装能力包</h3>
            {installed.length === 0 && !busy ? <p>暂无重型能力包。首次需要时会先展示来源、大小和权限，再由你确认安装。</p> : null}
            {installed.map((capability) => <article key={capability.manifest.id} className="claw-customer-module-market__card">
              <span className="claw-module-marketplace__module-copy">
                <strong>{capability.manifest.id}</strong>
                <small>{capability.manifest.version} · {formatBytes(capability.manifest.installedSize)} · {capability.manifest.permissions.join('、') || '无权限'}</small>
              </span>
              <span className="claw-customer-module-market__actions">
                {capability.previousVersion ? <button type="button" disabled={busy} onClick={() => {
                  if (!window.confirm(`回滚 ${capability.manifest.id} 到上一完整版本？`)) return;
                  setBusy(true);
                  void window.clawmaster.capabilityRollback?.(capability.manifest.id)
                    .then(refresh)
                    .catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error)))
                    .finally(() => setBusy(false));
                }}>回滚</button> : null}
                <button type="button" disabled={busy} onClick={() => {
                  if (!window.confirm(`卸载 ${capability.manifest.id}？此操作不会静默重装。`)) return;
                  setBusy(true);
                  void window.clawmaster.capabilityUninstall?.(capability.manifest.id, true)
                    .then(refresh)
                    .catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error)))
                    .finally(() => setBusy(false));
                }}>卸载</button>
              </span>
            </article>)}
          </section>
          {status ? <p role="status">{status}</p> : null}
        </div>
        <footer className="claw-module-marketplace__footer">
          <button type="button" disabled={busy} onClick={refresh}>{busy ? '读取中…' : '刷新状态'}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

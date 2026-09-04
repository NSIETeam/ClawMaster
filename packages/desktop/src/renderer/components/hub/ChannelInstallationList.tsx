/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import React, { useCallback, useEffect, useState } from 'react';
import type {
  ChannelHealth,
  ChannelInstallation,
  ChannelProvider,
} from '../../../preload/index.js';
import { Badge, Card, Empty } from './HubUI.js';

const REFRESH_MS = 10_000;

export function ChannelInstallationList({
  provider,
}: {
  provider: ChannelProvider;
}): React.JSX.Element {
  const [installations, setInstallations] = useState<ChannelInstallation[]>([]);
  const [health, setHealth] = useState<Record<string, ChannelHealth>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      if (typeof window.clawmaster?.channelInstallations !== 'function') {
        setUnsupported(true);
        return;
      }
      const listed = await window.clawmaster.channelInstallations();
      if (!listed?.ok || !listed.data) {
        if (listed?.error) setError(listed.error);
        return;
      }
      const matching = listed.data.filter((item) => item.provider === provider);
      setInstallations(matching);
      const states = await Promise.all(matching.map(async (installation) => {
        if (typeof window.clawmaster?.channelInstallationAction !== 'function') return null;
        const response = await window.clawmaster.channelInstallationAction(
          installation.installationId,
          'health',
        );
        return response?.ok && response.data && 'state' in response.data
          ? [installation.installationId, response.data as ChannelHealth] as const
          : null;
      }));
      setHealth(Object.fromEntries(states.filter((state) => state !== null)));
      setUnsupported(false);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '渠道状态读取失败。');
    }
  }, [provider]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
      await load();
      if (!cancelled) timer = setTimeout(() => void refresh(), REFRESH_MS);
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const act = async (
    installation: ChannelInstallation,
    action: 'start' | 'stop' | 'revoke',
  ): Promise<void> => {
    if (busy) return;
    if (action === 'revoke' && confirmRevoke !== installation.installationId) {
      setConfirmRevoke(installation.installationId);
      return;
    }
    setBusy(installation.installationId);
    setError(null);
    try {
      if (typeof window.clawmaster?.channelInstallationAction !== 'function') {
        setError('当前 Desktop 版本不支持渠道安装管理。');
        return;
      }
      const response = await window.clawmaster.channelInstallationAction(
        installation.installationId,
        action,
      );
      if (!response?.ok) setError(response?.error ?? '渠道操作失败。');
      else await load();
    } finally {
      setBusy(null);
      setConfirmRevoke(null);
    }
  };

  return (
    <div className="claw-channel-installations">
      <div className="claw-hub__section-title">已安装机器人</div>
      {installations.length === 0 ? (
        <Empty>尚未安装此渠道的机器人。</Empty>
      ) : installations.map((installation) => {
        const state = health[installation.installationId];
        const working = busy === installation.installationId;
        return (
          <Card className="claw-hub__card--pad" key={installation.installationId}>
            <div className="claw-channel-pairing__header">
              <div>
                <div className="claw-hub__row-name">{installation.botName}</div>
                <div className="claw-hub__field-hint">{installation.tenantName}</div>
              </div>
              <Badge>{state?.state ?? '状态未知'}</Badge>
            </div>
            <div className="claw-hub__field-hint">
              权限：{installation.grantedScopes.join('、') || '无'} · 重连 {state?.reconnectCount ?? 0} 次
            </div>
            <div className="claw-hub__feishu-actions">
              {state?.running ? (
                <button type="button" className="claw-hub__btn" disabled={working} onClick={() => void act(installation, 'stop')}>停止</button>
              ) : (
                <button type="button" className="claw-hub__btn claw-hub__btn--primary" disabled={working} onClick={() => void act(installation, 'start')}>启动</button>
              )}
              <button
                type="button"
                className="claw-hub__btn claw-hub__btn--danger"
                disabled={working}
                onClick={() => void act(installation, 'revoke')}
              >
                {confirmRevoke === installation.installationId ? '再次点击确认注销' : '注销连接'}
              </button>
            </div>
          </Card>
        );
      })}
      {error ? <div role="alert" className="claw-hub__feishu-message">{error}</div> : null}
      {unsupported ? (
        <div className="claw-hub__field-hint">当前 Desktop 版本不支持渠道安装管理。</div>
      ) : null}
    </div>
  );
}

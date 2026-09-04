/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import type { ChannelPairingPublic, ChannelProvider } from '../../../preload/index.js';
import { QrCode } from '../QrCode.js';
import { Card, Badge } from './HubUI.js';

const PROVIDER_LABEL: Record<ChannelProvider, string> = {
  feishu: '飞书',
  lark: 'Lark',
  wecom: '企业微信',
};

const TERMINAL = new Set(['connected', 'expired', 'denied', 'failed', 'revoked']);

function pairingMessage(pairing: ChannelPairingPublic): string {
  switch (pairing.status) {
    case 'waiting_scan': return `请使用${PROVIDER_LABEL[pairing.provider]}扫码并确认授权。`;
    case 'waiting_admin': return '平台要求企业管理员批准，批准后才能安装。';
    case 'user_authorized': return '授权已验证。请核对权限后手动确认安装。';
    case 'installing': return '正在安装机器人连接…';
    case 'verifying': return '正在验证消息收发能力…';
    case 'connected': return '机器人连接成功。';
    case 'expired': return '二维码已过期，请重新生成。';
    case 'denied': return '本次授权已拒绝。';
    case 'revoked': return '连接授权已撤销。';
    case 'failed': return pairing.failureReason ?? '连接失败。';
    default: return '正在读取连接状态…';
  }
}

export function ChannelPairingCard({ provider }: { provider: ChannelProvider }): React.JSX.Element {
  const [pairing, setPairing] = useState<ChannelPairingPublic | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pairing || TERMINAL.has(pairing.status)) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const response = await window.clawmaster?.channelPairingStatus(pairing.pairingId);
      if (cancelled) return;
      if (response?.ok && response.data) setPairing(response.data);
      else if (response?.error) setError(response.error);
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pairing]);

  const begin = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await window.clawmaster?.channelPairingBegin(provider);
      if (response?.ok && response.pairing) setPairing(response.pairing);
      else if (response?.error?.startsWith('channel_connector_unavailable:')) {
        setError(`${PROVIDER_LABEL[provider]}扫码服务尚未安装，未创建任何假连接。可继续使用下方高级配置。`);
      } else {
        setError(response?.error ?? '本地连接服务未就绪。');
      }
    } catch (cause) {
      setError(`连接服务不可用：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const action = async (kind: 'install' | 'cancel'): Promise<void> => {
    if (!pairing || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = kind === 'install'
          ? await window.clawmaster?.channelPairingInstall(pairing.pairingId)
          : await window.clawmaster?.channelPairingCancel(pairing.pairingId);
      if (!response?.ok) {
        setError(response?.error ?? '操作失败。');
        return;
      }
      if (kind === 'install') {
        setPairing({ ...pairing, status: 'connected', qrPayload: '' });
      } else if (response.data && typeof response.data === 'object' && 'status' in response.data) {
        setPairing(response.data as ChannelPairingPublic);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="claw-hub__card--pad claw-channel-pairing">
      <div className="claw-channel-pairing__header">
        <div>
          <div className="claw-hub__row-name">扫码连接机器人</div>
          <p className="claw-hub__field-hint">一次扫码完成租户识别、权限核对和机器人安装；安装仍需你手动确认。</p>
        </div>
        <Badge>{PROVIDER_LABEL[provider]}</Badge>
      </div>

      {!pairing ? (
        <button type="button" className="claw-hub__btn claw-hub__btn--primary" disabled={busy} onClick={() => void begin()}>
          {busy ? '正在创建安全二维码…' : `生成${PROVIDER_LABEL[provider]}连接二维码`}
        </button>
      ) : (
        <div className="claw-channel-pairing__body">
          {pairing.status === 'waiting_scan' && pairing.qrPayload ? (
            <QrCode
              value={pairing.qrPayload}
              label={`${PROVIDER_LABEL[provider]}连接二维码`}
              className="claw-channel-pairing__qr"
            />
          ) : null}
          <div className="claw-channel-pairing__details">
            <strong>{pairingMessage(pairing)}</strong>
            <span className="claw-hub__field-hint">权限：{pairing.requestedScopes.join('、')}</span>
            {pairing.tenantName ? <span className="claw-hub__field-hint">企业：{pairing.tenantName}</span> : null}
            <div className="claw-hub__feishu-actions">
              {pairing.status === 'waiting_scan' && pairing.qrPayload ? (
                <button type="button" className="claw-hub__btn" onClick={() => void window.clawmaster?.openExternal(pairing.qrPayload)}>在浏览器打开</button>
              ) : null}
              {pairing.status === 'user_authorized' ? (
                <button type="button" className="claw-hub__btn claw-hub__btn--primary" disabled={busy} onClick={() => void action('install')}>确认权限并安装</button>
              ) : null}
              {!TERMINAL.has(pairing.status) ? (
                <button type="button" className="claw-hub__btn" disabled={busy} onClick={() => void action('cancel')}>取消</button>
              ) : null}
              {TERMINAL.has(pairing.status) && pairing.status !== 'connected' ? (
                <button type="button" className="claw-hub__btn" disabled={busy} onClick={() => { setPairing(null); setError(null); }}>重新连接</button>
              ) : null}
            </div>
          </div>
        </div>
      )}
      {error ? <div className="claw-hub__feishu-message" role="alert">{error}</div> : null}
    </Card>
  );
}

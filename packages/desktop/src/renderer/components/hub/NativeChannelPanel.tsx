/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import React, { useEffect, useState } from 'react';
import type { NativeChannelConfig, NativeChannelProvider } from '../../../preload/index.js';
import { Card, Panel } from './HubUI.js';

const LABEL: Record<NativeChannelProvider, string> = {
  feishu: '飞书', lark: 'Lark', wecom: '企业微信', dingtalk: '钉钉',
};

export function NativeChannelPanel({ provider }: { provider: NativeChannelProvider }): React.JSX.Element {
  const [config, setConfig] = useState<NativeChannelConfig | null>(null);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [agentId, setAgentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const label = LABEL[provider];

  useEffect(() => {
    void window.clawmaster.nativeChannelConfigGet?.(provider).then((value) => {
      setConfig(value ?? null);
      setAppId(value?.appId ?? '');
      setAgentId(value?.agentId ?? '');
    }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)));
  }, [provider]);

  const save = async (): Promise<void> => {
    if (!window.clawmaster.nativeChannelConfigSave || busy) return;
    setBusy(true); setMessage('');
    try {
      const next = await window.clawmaster.nativeChannelConfigSave({
        provider, appId: appId.trim(), appSecret: appSecret.trim(),
        ...(agentId.trim() ? { agentId: agentId.trim() } : {}),
      });
      setConfig(next); setAppSecret('');
      setMessage('官方鉴权通过，凭据已保存到系统钥匙串。消息流连接尚未启用。');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const clear = async (): Promise<void> => {
    if (!window.clawmaster.nativeChannelConfigClear || busy) return;
    setBusy(true); setMessage('');
    try {
      await window.clawmaster.nativeChannelConfigClear(provider);
      setConfig(null); setAppId(''); setAppSecret(''); setAgentId('');
      setMessage('凭据已从系统钥匙串清除。');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const complete = appId.trim() && appSecret.trim() && (provider !== 'wecom' || agentId.trim());
  return <Panel title={`${label}接入`} desc={`使用 ${label} 企业自建应用凭据，由 Rust 直接完成官方鉴权验证。`}>
    <Card className="claw-hub__card--pad">
      <div className="claw-hub__row-name">{config ? '凭据已验证' : '尚未验证凭据'}</div>
      <p className="claw-hub__field-hint">{config ? `最近验证：${new Date(config.verifiedAt).toLocaleString('zh-CN')}` : 'Secret 不会写入配置文件或发送给模型。'}</p>
    </Card>
    <Card><div className="claw-hub__setting claw-hub__setting--stack">
      <input className="claw-hub__input" aria-label={`${label} App ID`} placeholder={provider === 'wecom' ? 'Corp ID' : 'App ID / App Key'} value={appId} onChange={(event) => setAppId(event.target.value)} />
      {provider === 'wecom' ? <input className="claw-hub__input" aria-label="企业微信 Agent ID" placeholder="Agent ID" value={agentId} onChange={(event) => setAgentId(event.target.value)} /> : null}
      <input className="claw-hub__input" type="password" aria-label={`${label} App Secret`} placeholder="App Secret" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} />
      <div className="claw-hub__feishu-actions">
        <button type="button" className="claw-hub__btn claw-hub__btn--primary" disabled={busy || !complete} onClick={() => void save()}>{busy ? '验证中…' : '保存并验证'}</button>
        {config ? <button type="button" className="claw-hub__btn claw-hub__btn--danger" disabled={busy} onClick={() => void clear()}>清除凭据</button> : null}
      </div>
    </div></Card>
    {message ? <div className="claw-hub__feishu-message" role="status">{message}</div> : null}
  </Panel>;
}

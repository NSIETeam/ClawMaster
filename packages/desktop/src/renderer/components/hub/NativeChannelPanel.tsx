/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import React, { useEffect, useState } from 'react';
import type { NativeChannelConfig, NativeChannelProvider, NativeChannelStatus } from '../../../preload/index.js';
import { Card, Panel } from './HubUI.js';

const LABEL: Record<NativeChannelProvider, string> = {
  feishu: '飞书', lark: 'Lark', wecom: '企业微信', dingtalk: '钉钉',
};

export function NativeChannelPanel({ provider }: { provider: NativeChannelProvider }): React.JSX.Element {
  const [config, setConfig] = useState<NativeChannelConfig | null>(null);
  const [status, setStatus] = useState<NativeChannelStatus | null>(null);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [agentId, setAgentId] = useState('');
  const [wecomMode, setWecomMode] = useState<'bot' | 'agent'>('bot');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [targetId, setTargetId] = useState('');
  const [testText, setTestText] = useState('ClawMaster 连接测试');
  const label = LABEL[provider];

  useEffect(() => {
    void window.clawmaster.nativeChannelConfigGet?.(provider).then((value) => {
      setConfig(value ?? null);
      setAppId(value?.appId ?? '');
      setAgentId(value?.agentId ?? '');
      setWecomMode(value?.connectionMode ?? (value?.agentId ? 'agent' : 'bot'));
    }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)));
  }, [provider]);

  useEffect(() => {
    if (!window.clawmaster.nativeChannelStatusGet) return;
    let active = true;
    const refresh = (): void => {
      void window.clawmaster.nativeChannelStatusGet?.(provider).then((value) => {
        if (active) setStatus(value);
      }).catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [provider]);

  const save = async (): Promise<void> => {
    if (!window.clawmaster.nativeChannelConfigSave || busy) return;
    setBusy(true); setMessage('');
    try {
      const next = await window.clawmaster.nativeChannelConfigSave({
        provider, appId: appId.trim(), appSecret: appSecret.trim(),
        ...(agentId.trim() ? { agentId: agentId.trim() } : {}),
        ...(provider === 'wecom' ? { connectionMode: wecomMode } : {}),
      });
      setConfig(next); setAppSecret('');
      setMessage(provider === 'feishu' || provider === 'lark' || provider === 'dingtalk' || (provider === 'wecom' && wecomMode === 'bot')
        ? '官方鉴权与长连接端点验证通过，Rust 正在建立消息流。'
        : '官方鉴权通过，凭据已保存到系统钥匙串。入站消息流尚未启用。');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const clear = async (): Promise<void> => {
    if (!window.clawmaster.nativeChannelConfigClear || busy) return;
    setBusy(true); setMessage('');
    try {
      await window.clawmaster.nativeChannelConfigClear(provider);
      setConfig(null); setAppId(''); setAppSecret(''); setAgentId('');
      setWecomMode('bot');
      setMessage('凭据已从系统钥匙串清除。');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const sendTest = async (): Promise<void> => {
    if (!window.clawmaster.nativeChannelSendTest || busy) return;
    const target = targetId.trim();
    const text = testText.trim();
    if (!target || !text || !window.confirm(`确认通过${label}向 ${target} 发送：\n\n${text}`)) return;
    setBusy(true); setMessage('');
    try {
      await window.clawmaster.nativeChannelSendTest({ provider, targetId: target, text });
      setMessage(`平台确认消息已发送给 ${target}。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const configuredWecomMode = config?.connectionMode ?? (config?.agentId ? 'agent' : 'bot');
  const hasLongConnection = provider === 'feishu' || provider === 'lark' || provider === 'dingtalk'
    || (provider === 'wecom' && configuredWecomMode === 'bot');
  const complete = appId.trim() && appSecret.trim() && (provider !== 'wecom' || wecomMode === 'bot' || agentId.trim());
  const description = provider === 'wecom'
    ? '智能机器人模式使用 Rust 官方 WebSocket 双向对话；自建应用模式保留主动通知能力。'
    : `使用 ${label} 企业自建应用凭据，由 Rust 直接完成官方鉴权验证。`;
  return <Panel title={`${label}接入`} desc={description}>
    <Card className="claw-hub__card--pad">
      <div className="claw-hub__row-name">{config ? '凭据已验证' : '尚未验证凭据'}</div>
      <p className="claw-hub__field-hint">{config ? `最近验证：${new Date(config.verifiedAt).toLocaleString('zh-CN')}` : 'Secret 不会写入配置文件或发送给模型。'}</p>
      {config && hasLongConnection ? <p className="claw-hub__field-hint">
        长连接：{status?.state === 'connected' ? '已连接' : status?.state === 'connecting' ? '连接中' : status?.state === 'failed' ? `失败：${status.lastError ?? '未知错误'}` : '未启动'}
        {status?.lastEventAt ? `；最近事件：${new Date(status.lastEventAt).toLocaleString('zh-CN')}` : ''}
        {status?.state === 'connected' && status.lastError ? `；最近处理错误：${status.lastError}` : ''}
      </p> : null}
    </Card>
    <Card><div className="claw-hub__setting claw-hub__setting--stack">
      {provider === 'wecom' ? <select className="claw-hub__input" aria-label="企业微信连接模式" value={wecomMode} onChange={(event) => {
        const mode = event.target.value === 'agent' ? 'agent' : 'bot';
        setWecomMode(mode);
        if (mode === 'bot') setAgentId('');
      }}>
        <option value="bot">智能机器人长连接（推荐）</option>
        <option value="agent">自建应用主动通知</option>
      </select> : null}
      <input className="claw-hub__input" aria-label={provider === 'wecom' && wecomMode === 'bot' ? '企业微信 Bot ID' : `${label} App ID`} placeholder={provider === 'wecom' ? (wecomMode === 'bot' ? 'Bot ID' : 'Corp ID') : 'App ID / App Key'} value={appId} onChange={(event) => setAppId(event.target.value)} />
      {provider === 'wecom' && wecomMode === 'agent' ? <input className="claw-hub__input" aria-label="企业微信 Agent ID" placeholder="Agent ID" value={agentId} onChange={(event) => setAgentId(event.target.value)} /> : null}
      <input className="claw-hub__input" type="password" aria-label={provider === 'wecom' && wecomMode === 'bot' ? '企业微信 Bot Secret' : `${label} App Secret`} placeholder={provider === 'wecom' && wecomMode === 'bot' ? 'Bot Secret' : 'App Secret'} value={appSecret} onChange={(event) => setAppSecret(event.target.value)} />
      <div className="claw-hub__feishu-actions">
        <button type="button" className="claw-hub__btn claw-hub__btn--primary" disabled={busy || !complete} onClick={() => void save()}>{busy ? '验证中…' : '保存并验证'}</button>
        {config ? <button type="button" className="claw-hub__btn claw-hub__btn--danger" disabled={busy} onClick={() => void clear()}>清除凭据</button> : null}
      </div>
    </div></Card>
    {config ? <Card><div className="claw-hub__setting claw-hub__setting--stack">
      <div className="claw-hub__row-name">发送真实测试消息</div>
      <input className="claw-hub__input" aria-label={`${label} 接收方 ID`} placeholder={provider === 'feishu' || provider === 'lark' ? '接收方 open_id' : '接收方用户 ID'} value={targetId} onChange={(event) => setTargetId(event.target.value)} />
      <textarea className="claw-hub__input" aria-label={`${label} 测试消息`} value={testText} onChange={(event) => setTestText(event.target.value)} />
      <button type="button" className="claw-hub__btn" disabled={busy || !targetId.trim() || !testText.trim()} onClick={() => void sendTest()}>确认后发送测试消息</button>
    </div></Card> : null}
    {message ? <div className="claw-hub__feishu-message" role="status">{message}</div> : null}
  </Panel>;
}

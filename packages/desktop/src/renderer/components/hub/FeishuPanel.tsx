/**
 * @license
 * Copyright 2025 ClawMaster
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 「飞书接入」面板（设置与诊断中心 · 设置组）。
 *
 * 这是飞书配置的正经 GUI 入口——凭证表单 + 真实连接状态 + 一键启停，
 * 全部走确定性通路（preload → main → server REST），不发提示词给 AI 代办：
 *   - 凭证：feishuGetConfig / feishuSaveConfig / feishuClearConfig
 *     （GET 永远是脱敏视图，appSecret 只进不出）；
 *   - 状态：feishuStatus 轮询（server /health 的守护详情，诚实透传）；
 *   - 启停：feishuStart / feishuStop（server 运行期端点）。
 *
 * 配置闭环（面板内文案引导，全程不需要终端）：
 *   1. 在飞书开放平台建应用，拿 App ID / App Secret 填进来保存；
 *   2. 保存即自动拉起守护，状态卡看到「已连接」；
 *   3. 在飞书给 Bot 发一句话 → Bot 回你的 open_id → 填进「授权用户」再保存。
 */

import React, { useEffect, useRef, useState } from 'react';
import type { FeishuConfigPublic } from '../../../preload/index.js';
import {
  deriveFeishuBadgeState,
  FeishuStatusIcon,
  type FeishuStatusResult,
} from '../FeishuStatusBadge.js';
import { IconExternalLink } from '../icons.js';
import { Panel, Card, Badge, Empty } from './HubUI.js';
import { ChannelPairingCard } from './ChannelPairingCard.js';
import { ChannelInstallationList } from './ChannelInstallationList.js';
import { NativeChannelPanel } from './NativeChannelPanel.js';

/** 状态轮询周期：面板打开时用户正在等连接结果，比常驻徽标（5s）稍勤。 */
const POLL_INTERVAL_MS = 3_000;

const DOMAIN_OPTIONS: Array<{ id: 'feishu' | 'lark'; label: string }> = [
  { id: 'feishu', label: '飞书（feishu.cn）' },
  { id: 'lark', label: 'Lark 国际版' },
];

export function FeishuPanel(): React.JSX.Element {
  return window.clawmaster.nativeChannelConfigSave
    ? <NativeChannelPanel provider="feishu" />
    : <LegacyFeishuPanel />;
}

function LegacyFeishuPanel(): React.JSX.Element {
  // ── 真实连接状态（轮询）──
  const [status, setStatus] = useState<FeishuStatusResult | null>(null);
  // ── 凭证脱敏视图 + 表单草稿 ──
  const [cfg, setCfg] = useState<FeishuConfigPublic | null>(null);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [domain, setDomain] = useState<'feishu' | 'lark'>('feishu');
  const [ownerOpenId, setOwnerOpenId] = useState('');
  // ── 操作反馈 ──
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadConfig = async (): Promise<void> => {
    const res = await window.clawmaster?.feishuGetConfig();
    if (!res) return;
    setCfg(res.config);
    if (res.config?.configured) {
      setAppId(res.config.appId ?? '');
      setDomain(res.config.domain ?? 'feishu');
      setOwnerOpenId(res.config.ownerOpenId ?? '');
    }
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void loadConfig();
    const poll = async (): Promise<void> => {
      try {
        const res = await window.clawmaster?.feishuStatus();
        if (!cancelled && res) setStatus(res);
      } catch {
        // 查询失败保留上一帧，下轮再试。
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await window.clawmaster?.feishuSaveConfig({
        appId: appId.trim(),
        ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
        domain,
        ...(ownerOpenId.trim() ? { ownerOpenId: ownerOpenId.trim() } : {}),
      });
      if (!res) {
        setMessage('ClawMaster 本地引擎未就绪，凭证未保存。');
      } else if (!res.ok) {
        setMessage(res.error ?? '保存失败。');
      } else {
        setMessage('凭证已保存，守护已启动——状态见上方（连接通常在几秒内建立）。');
        setAppSecret('');
        setCfg(res.config);
      }
    } catch (e) {
      setMessage(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  /** 清除凭证：两击确认（第一击变「确认清除？」，3s 内不点第二击自动复原）。 */
  const clear = async (): Promise<void> => {
    if (busy) return;
    if (!confirmClear) {
      setConfirmClear(true);
      confirmTimer.current = setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmClear(false);
    setBusy(true);
    setMessage(null);
    try {
      const res = await window.clawmaster?.feishuClearConfig();
      if (!res || !res.ok) {
        setMessage(res?.error ?? '清除失败：ClawMaster 本地引擎未就绪。');
      } else {
        setMessage('凭证已清除，守护已停止。');
        setCfg(res.config);
        setAppId('');
        setAppSecret('');
        setOwnerOpenId('');
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleDaemon = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = status?.running
        ? await window.clawmaster?.feishuStop()
        : await window.clawmaster?.feishuStart();
      if (res?.text) setMessage(res.text);
    } catch (e) {
      setMessage(`操作失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const view = deriveFeishuBadgeState(status);
  const configured = cfg?.configured === true;

  return (
    <Panel
      title="飞书接入"
      desc="把 ClawMaster 接进飞书 / Lark：填好应用凭证，在飞书里直接和 ClawMaster 对话。"
      actions={
        <button
          type="button"
          className={
            'claw-hub__btn' + (status?.running ? '' : ' claw-hub__btn--primary')
          }
          onClick={() => void toggleDaemon()}
          disabled={busy || (!configured && !status?.running)}
          title={
            !configured && !status?.running
              ? '先在下方保存凭证，保存即自动启动'
              : undefined
          }
        >
          {status?.running ? '停止网关' : '启动网关'}
        </button>
      }
    >
      <ChannelPairingCard provider={domain} />
      <ChannelInstallationList provider={domain} />

      {/* 连接状态：与徽标同一套推导（诚实：重连中/锁冲突/离线各是各）。 */}
      <Card className="claw-hub__card--pad">
        <div className="claw-hub__feishu-status" data-feishu-state={view.kind}>
          <FeishuStatusIcon view={view} size={20} />
          <span className="claw-hub__row-name">{view.label}</span>
          {cfg?.botName ? <Badge>Bot · {cfg.botName}</Badge> : null}
          {cfg?.tenantName ? <Badge>{cfg.tenantName}</Badge> : null}
        </div>
        <div className="claw-hub__field-hint">
          {status?.text ?? '正在查询飞书连接状态…'}
        </div>
      </Card>

      {message ? <div className="claw-hub__feishu-message">{message}</div> : null}

      <div className="claw-hub__section-title">高级配置与兼容模式</div>
      {/* 凭证表单：真配置，不发提示词。 */}
      {cfg?.corrupted ? (
        <Empty>
          凭证文件已损坏（无法解密），请点击下方「清除凭证」后重新填写。
        </Empty>
      ) : null}
      <Card>
        <div className="claw-hub__setting claw-hub__setting--stack">
          <div className="claw-hub__setting-text">
            <div className="claw-hub__field-label">应用凭证</div>
            <div className="claw-hub__field-hint">
              在飞书开放平台「创建企业自建应用」后，从「凭证与基础信息」页复制。
              需开启机器人能力并授予 im:message 相关权限。
            </div>
          </div>
          <div className="claw-hub__feishu-form">
            <input
              className="claw-hub__input"
              placeholder="App ID（形如 cli_xxx）"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
            />
            <input
              className="claw-hub__input"
              type="password"
              placeholder={
                configured
                  ? 'App Secret（已保存；留空沿用，填新值覆盖）'
                  : 'App Secret'
              }
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
            />
            <div className="claw-hub__chiprow">
              {DOMAIN_OPTIONS.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={'claw-hub__chip' + (domain === d.id ? ' is-active' : '')}
                  onClick={() => setDomain(d.id)}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="claw-hub__setting claw-hub__setting--stack">
          <div className="claw-hub__setting-text">
            <div className="claw-hub__field-label">授权用户 open_id</div>
            <div className="claw-hub__field-hint">
              安全白名单：只有这个 open_id 能指挥 Bot。连接成功后在飞书里给 Bot
              发一句话，Bot 会回复你的 open_id（ou_ 开头），填进来再保存即可。
            </div>
          </div>
          <input
            className="claw-hub__input"
            placeholder="ou_xxx（首次可留空，连上后按提示补填）"
            value={ownerOpenId}
            onChange={(e) => setOwnerOpenId(e.target.value)}
          />
        </div>

        <div className="claw-hub__setting">
          <div className="claw-hub__feishu-actions">
            <button
              type="button"
              className="claw-hub__btn claw-hub__btn--primary"
              onClick={() => void save()}
              disabled={busy || !appId.trim()}
            >
              {busy ? '处理中…' : '保存并连接'}
            </button>
            {configured ? (
              <button
                type="button"
                className={
                  'claw-hub__btn' + (confirmClear ? ' claw-hub__btn--danger' : '')
                }
                onClick={() => void clear()}
                disabled={busy}
              >
                {confirmClear ? '确认清除？' : '清除凭证'}
              </button>
            ) : null}
            <button
              type="button"
              className="claw-hub__btn"
              onClick={() => void window.clawmaster?.openExternal('https://open.feishu.cn')}
            >
              <span>打开飞书开放平台</span>
              <IconExternalLink size={12} />
            </button>
          </div>
        </div>
      </Card>
    </Panel>
  );
}

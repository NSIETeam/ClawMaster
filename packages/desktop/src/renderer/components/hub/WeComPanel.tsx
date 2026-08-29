/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { IconExternalLink } from '../icons.js';
import { Card, Panel } from './HubUI.js';

export const WECOM_ADMIN_URL = 'https://work.weixin.qq.com/wework_admin/frame#apps';
export const WECOM_API_GUIDE_URL = 'https://developer.work.weixin.qq.com/document/path/90665';

type WeComDestination = 'admin' | 'guide';

const DESTINATIONS: Record<WeComDestination, string> = {
  admin: WECOM_ADMIN_URL,
  guide: WECOM_API_GUIDE_URL,
};

/** Keep external navigation closed over an allowlist; callers cannot inject a URL. */
export async function openWeComDestination(destination: WeComDestination): Promise<void> {
  if (!window.otto?.openExternal) throw new Error('桌面外部链接服务未就绪');
  await window.otto.openExternal(DESTINATIONS[destination]);
}

export function WeComPanel(): React.JSX.Element {
  const [opening, setOpening] = useState<WeComDestination | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const open = async (destination: WeComDestination): Promise<void> => {
    if (opening) return;
    setOpening(destination);
    setMessage(null);
    try {
      await openWeComDestination(destination);
    } catch (error) {
      setMessage(`无法打开企业微信页面：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setOpening(null);
    }
  };

  return (
    <Panel
      title="企业微信接入"
      desc="从 Otto 直接进入企业微信管理后台，创建自建应用并准备 Corp ID、AgentId 和 Secret。"
    >
      <Card className="otto-hub__card--pad">
        <div className="otto-hub__row-name">连接准备</div>
        <p className="otto-hub__field-hint">
          企业微信只支持企业自建应用。请在管理后台创建应用并配置可见范围；Secret 不会通过链接传递，也不要粘贴到普通对话中。
        </p>
        <div className="otto-hub__feishu-actions">
          <button
            type="button"
            className="otto-hub__btn otto-hub__btn--primary"
            disabled={opening !== null}
            onClick={() => void open('admin')}
          >
            <span>{opening === 'admin' ? '正在打开…' : '打开企业微信管理后台'}</span>
            <IconExternalLink size={12} />
          </button>
          <button
            type="button"
            className="otto-hub__btn"
            disabled={opening !== null}
            onClick={() => void open('guide')}
          >
            <span>{opening === 'guide' ? '正在打开…' : '查看官方接入说明'}</span>
            <IconExternalLink size={12} />
          </button>
        </div>
        {message ? <div className="otto-hub__feishu-message" role="alert">{message}</div> : null}
      </Card>

      <Card className="otto-hub__card--pad">
        <div className="otto-hub__row-name">当前能力边界</div>
        <p className="otto-hub__field-hint">
          Otto 已有受确认保护的企业微信消息发送能力；凭证绑定仍应走专用安全配置通路。此页面不会把 Secret 交给模型，也不会在后台自动发送消息。
        </p>
      </Card>
    </Panel>
  );
}

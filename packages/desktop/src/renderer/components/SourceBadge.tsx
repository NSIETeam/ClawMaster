/**
 * @license
 * Copyright 2025 ClawMaster
 * SPDX-License-Identifier: Apache-2.0
 */

/** 来源徽章：Feishu（蓝青 + 花瓣）/ Local（绿 + 方块勾）。spec §左侧栏 4。 */

import React from 'react';
import type { MessageSource } from 'clawmaster-server';
import { IconFeishuPetal, IconLocalMark } from './icons.js';

export function SourceBadge({
  source,
}: {
  source: MessageSource;
}): React.JSX.Element {
  if (source === 'feishu') {
    return (
      <span className="claw-badge claw-badge--feishu">
        <IconFeishuPetal size={11} />
        飞书
      </span>
    );
  }
  if (source === 'atoa') {
    return (
      <span className="claw-badge claw-badge--atoa">
        <IconLocalMark size={11} />
        企业协作
      </span>
    );
  }
  if (source === 'enterprise') {
    return (
      <span className="claw-badge claw-badge--enterprise">
        <IconLocalMark size={11} />
        企业通知
      </span>
    );
  }
  if (source === 'park') {
    return (
      <span className="claw-badge claw-badge--park">
        <IconLocalMark size={11} />
        园区服务
      </span>
    );
  }
  // 旧版本可能留下 source=tui 的历史消息；统一按本地来源展示。
  return (
    <span className="claw-badge claw-badge--local">
      <IconLocalMark size={11} />
      本地
    </span>
  );
}

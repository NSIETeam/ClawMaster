/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClawMasterClient } from '../core/client.js';
import { ClawMasterChat } from '../core/clawmasterChat.js';


export interface NextSpeakerResponse {
  reasoning: string;
  next_speaker: 'user' | 'model';
}

export async function checkNextSpeaker(
  _chat: ClawMasterChat,
  _geminiClient: ClawMasterClient,
  _abortSignal: AbortSignal,
): Promise<NextSpeakerResponse | null> {
  // 不在调用模型判断是否该谁说话，节省token
  return null;
}

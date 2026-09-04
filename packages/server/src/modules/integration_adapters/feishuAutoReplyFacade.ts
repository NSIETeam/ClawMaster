/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 */

import {
  isFeishuAutoReplyEnabledForOpenIdInPolicy,
  type FeishuAutoReplyPolicyDependencies,
} from './feishuAutoReplyPolicy.js';

export interface FeishuAutoReplyFacade {
  isFeishuAutoReplyEnabledForOpenId(openId: string): boolean;
}

export function createFeishuAutoReplyFacade(
  dependencies: FeishuAutoReplyPolicyDependencies,
): FeishuAutoReplyFacade {
  return {
    isFeishuAutoReplyEnabledForOpenId(openId) {
      return isFeishuAutoReplyEnabledForOpenIdInPolicy(dependencies, openId);
    },
  };
}

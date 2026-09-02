/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 可逆的内部测试通道。
 *
 * ClawMaster 的本地工作区不依赖企业会话。真实企业账号仍通过邀请码或设置内
 * 的连接入口建立；本地身份不创建服务端会话，也不伪造管理员权限。
 */

import type { EnterpriseAccount } from '../preload/index.js';

export { INTERNAL_TEST_ACCESS_ENABLED } from '../main/internal-test-access.js';

declare const __OTTO_INTERNAL_TEST_ADMIN__: boolean | undefined;

/** 仅供显式内部构建展示企业管理员前端；不能代表服务端授权。 */
export const INTERNAL_TEST_ADMIN_ENABLED =
  typeof __OTTO_INTERNAL_TEST_ADMIN__ !== 'undefined'
  && __OTTO_INTERNAL_TEST_ADMIN__ === true;

export const INTERNAL_TEST_ACCOUNT: EnterpriseAccount = Object.freeze({
  id: 'local_internal_test',
  accountType: 'personal',
  organizationId: 'local-internal-test',
  organizationName: '本地',
  employeeId: null,
  username: 'internal-test',
  phone: null,
  name: '本地用户',
  role: '成员',
  department: '',
  positionId: null,
  positionTitle: null,
  isAdmin: false,
  status: 'active',
  tags: ['本地身份'],
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
});

export const INTERNAL_TEST_ADMIN_ACCOUNT: EnterpriseAccount = Object.freeze({
  ...INTERNAL_TEST_ACCOUNT,
  id: 'local_internal_admin_preview',
  accountType: 'enterprise',
  username: 'internal-admin-preview',
  name: '本地管理员',
  role: '企业管理员',
  isAdmin: true,
  tags: ['本地身份', '管理员 UI 预览'],
});

export type EnterpriseAccessMode =
  | 'local-workspace'
  | 'registration'
  | 'authenticated-workspace';

/**
 * ClawMaster 采用本地优先入口，不把企业认证作为启动门禁：
 * - 无真实会话时直接进入本地工作区；
 * - 邀请链接到达时进入注册；
 * - 已注册账号恢复真实会话并连接企业服务；
 * - 旧的内测开关仅保留构建兼容性，不再改变入口行为。
 */
export function resolveEnterpriseAccessMode(input: {
  internalTestAccessEnabled: boolean;
  authStatus: 'loading' | 'signed-out' | 'signed-in';
  hasAccount: boolean;
  hasRegistrationIntent: boolean;
}): EnterpriseAccessMode {
  if (input.hasAccount && input.authStatus === 'signed-in') {
    return 'authenticated-workspace';
  }
  if (input.hasRegistrationIntent) return 'registration';
  return 'local-workspace';
}

export function isAuthenticatedEnterpriseAccount(
  account: EnterpriseAccount | undefined,
): account is EnterpriseAccount {
  return Boolean(
    account
      && account.id !== INTERNAL_TEST_ACCOUNT.id
      && account.organizationId !== INTERNAL_TEST_ACCOUNT.organizationId,
  );
}

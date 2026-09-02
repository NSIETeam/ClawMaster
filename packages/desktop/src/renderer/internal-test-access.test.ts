/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  INTERNAL_TEST_ACCESS_ENABLED,
  INTERNAL_TEST_ACCOUNT,
  INTERNAL_TEST_ADMIN_ACCOUNT,
  isAuthenticatedEnterpriseAccount,
  resolveEnterpriseAccessMode,
} from './internal-test-access.js';
import { resolveCentralEnterpriseIdentity } from './state/centralEnterpriseIdentity.js';

describe('ClawMaster 本地优先访问模式', () => {
  it('交付版保留本地身份，不要求先登录企业账号', () => {
    expect(INTERNAL_TEST_ACCESS_ENABLED).toBe(false);
    expect(INTERNAL_TEST_ACCOUNT).toMatchObject({
      id: 'local_internal_test',
      username: 'internal-test',
      name: '本地用户',
      status: 'active',
    });
  });

  it('测试身份永远不是服务端管理员，不能露出账号和邀请码管理入口', () => {
    expect(INTERNAL_TEST_ACCOUNT.isAdmin).toBe(false);
    expect(INTERNAL_TEST_ACCOUNT.organizationId).toBe('local-internal-test');
    expect(INTERNAL_TEST_ACCOUNT.phone).toBeNull();
  });

  it('独立的管理员预览身份只用于展示企业版前端入口', () => {
    expect(INTERNAL_TEST_ADMIN_ACCOUNT).toMatchObject({
      id: 'local_internal_admin_preview',
      accountType: 'enterprise',
      name: '本地管理员',
      role: '企业管理员',
      isAdmin: true,
    });
    expect(isAuthenticatedEnterpriseAccount(INTERNAL_TEST_ADMIN_ACCOUNT)).toBe(false);
  });

  it('未连接企业账号时直接进入本地工作区，邀请注册和真实会话仍单独分流', () => {
    expect(resolveEnterpriseAccessMode({
      internalTestAccessEnabled: false,
      authStatus: 'loading',
      hasAccount: false,
      hasRegistrationIntent: false,
    })).toBe('local-workspace');
    expect(resolveEnterpriseAccessMode({
      internalTestAccessEnabled: false,
      authStatus: 'signed-out',
      hasAccount: false,
      hasRegistrationIntent: false,
    })).toBe('local-workspace');
    expect(resolveEnterpriseAccessMode({
      internalTestAccessEnabled: false,
      authStatus: 'signed-out',
      hasAccount: false,
      hasRegistrationIntent: true,
    })).toBe('registration');
    expect(resolveEnterpriseAccessMode({
      internalTestAccessEnabled: false,
      authStatus: 'signed-in',
      hasAccount: true,
      hasRegistrationIntent: false,
    })).toBe('authenticated-workspace');
  });

  it('旧内测开关不改变本地优先入口', () => {
    expect(resolveEnterpriseAccessMode({
      internalTestAccessEnabled: true,
      authStatus: 'loading',
      hasAccount: false,
      hasRegistrationIntent: false,
    })).toBe('local-workspace');
  });

  it('合成本地身份永远不能冒充真实企业账号', () => {
    expect(isAuthenticatedEnterpriseAccount(INTERNAL_TEST_ACCOUNT)).toBe(false);
    expect(resolveCentralEnterpriseIdentity(INTERNAL_TEST_ACCOUNT).edition).toBe('personal');
  });
});

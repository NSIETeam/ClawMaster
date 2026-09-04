/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


/**
 * ClawMaster统一认证处理器
 * 处理ClawMaster统一认证系统的认证流程
 */

export interface ClawMasterAuthConfig {
  authUrl: string;
  redirectUri: string;
}

export interface ClawMasterAuthResult {
  success: boolean;
  token?: string;
  user_id?: string;
  error?: string;
}

/**
 * ClawMaster统一认证处理器
 */
export class ClawMasterAuthHandler {
  private config: ClawMasterAuthConfig;

  constructor(config: ClawMasterAuthConfig) {
    this.config = config;
  }

  /**
   * 构建ClawMaster认证URL
   */
  buildAuthUrl(): string {
    // BYO-key: 未配置认证服务地址时该登录流不可用，抛错由调用方 catch 优雅处理，
    // 避免生成以 '?redirect_to=' 开头的无效 URL。
    if (!this.config.authUrl) {
      throw new Error('未配置认证服务地址（CLAWMASTER_AUTH_URL），账号登录不可用');
    }
    // 直接构建完整的认证URL，避免重定向问题
    const authUrl = `${this.config.authUrl}?redirect_to=${encodeURIComponent(this.config.redirectUri)}&redirect_mode=same_window`;
    console.log('🔗 ClawMaster 认证 URL 已生成');

    return authUrl;
  }

  /**
   * 处理ClawMaster认证回调
   */
  handleCallback(url: URL): ClawMasterAuthResult {
    console.log('🔄 [ClawMaster Auth] 处理认证回调');

    const allParams = Object.fromEntries(url.searchParams.entries());
    console.log('🔄 [ClawMaster Auth] 回调参数已接收:', Object.keys(allParams));

    // 提取token和user_id参数
    const token = url.searchParams.get('token');
    const user_id = url.searchParams.get('user_id');
    const error = url.searchParams.get('error');

    if (error) {
      console.error('❌ [ClawMaster Auth] 认证错误:', error);
      return {
        success: false,
        error: `ClawMaster 认证失败: ${error}`
      };
    }

    if (!token) {
      console.error('❌ [ClawMaster Auth] 缺少 token 参数');
      return {
        success: false,
        error: 'ClawMaster 认证回调中缺少 token 参数'
      };
    }

    if (!user_id) {
      console.error('❌ [ClawMaster Auth] 缺少 user_id 参数');
      return {
        success: false,
        error: 'ClawMaster 认证回调中缺少 user_id 参数'
      };
    }

    // 打印token和user_id（按要求）
    console.log('✅ [ClawMaster Auth] 认证成功');
    return {
      success: true,
      token,
      user_id
    };
  }
}

/**
 * 创建ClawMaster认证处理器的便捷函数
 */
export function createClawMasterAuthHandler(callbackPort?: number): ClawMasterAuthHandler {
  const actualPort = callbackPort || 7863;
  const config: ClawMasterAuthConfig = {
    // BYO-key: 不再硬编码 otto 登录地址；可由 CLAWMASTER_AUTH_URL 配置，未配置则该登录流不可用。
    authUrl: process.env.CLAWMASTER_AUTH_URL || '',
    redirectUri: `http://localhost:${actualPort}/callback?plat=otto`,
  };

  return new ClawMasterAuthHandler(config);
}

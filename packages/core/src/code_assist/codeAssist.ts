/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, ContentGenerator } from '../core/contentGenerator.js';
import { Config } from '../config/config.js';

export async function createCodeAssistContentGenerator(
  _httpOptions: unknown,
  _authType: AuthType,
  _config: Config,
  _sessionId?: string,
): Promise<ContentGenerator> {
  // Code Assist Content Generator is no longer supported
  // Only ClawMaster Server authentication is supported
  throw new Error(
    'Code Assist Content Generator has been deprecated. Use the ClawMaster local engine instead.'
  );
}

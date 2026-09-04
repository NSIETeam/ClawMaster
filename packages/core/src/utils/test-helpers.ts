/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Test helpers for ClawMaster tool unit tests.
 * Provides a shared mock Config factory to eliminate boilerplate.
 *
 * Usage:
 *   import { createMockConfig } from '../utils/test-helpers.js';
 *   const config = createMockConfig({ getTargetDir: () => '/tmp/test' });
 */

import { vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  ApprovalMode,
  type DocumentIdentity,
} from '../config/config.js';

export interface MockConfigOverrides {
  getTargetDir?: () => string;
  getApprovalMode?: () => ApprovalMode;
  setApprovalMode?: (mode: ApprovalMode) => void;
  getDocumentIdentity?: () => DocumentIdentity | undefined;
}

/**
 * Create a mock Config instance for tool testing.
 * All methods return sensible defaults; override via `overrides`.
 */
export function createMockConfig(overrides?: MockConfigOverrides): Config {
  const defaults = {
    getTargetDir: () => process.cwd(),
    getApprovalMode: vi.fn(() => ApprovalMode.DEFAULT),
    setApprovalMode: vi.fn(),
    getDocumentIdentity: vi.fn(() => undefined),
  };

  return { ...defaults, ...overrides } as unknown as Config;
}

/**
 * @license
 * Copyright 2026 ClawMaster contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import {
  resolveExternalAgentSpec,
  type ExternalAgentType,
} from './externalAgentRegistry.js';

export interface LocalAgentAvailability {
  claudeCode: boolean;
  codex: boolean;
}

export interface DetectLocalAgentsDeps {
  lookup?: (binary: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
}

const TARGET_BINARIES: Record<ExternalAgentType, string> = {
  'claude-code': 'claude',
  codex: 'codex',
};

const OVERRIDE_ENV: Record<ExternalAgentType, string> = {
  'claude-code': 'CLAWMASTER_CLAUDE_CODE_ACP_CMD',
  codex: 'CLAWMASTER_CODEX_ACP_CMD',
};

export async function detectLocalAgents(
  deps: DetectLocalAgentsDeps = {},
): Promise<LocalAgentAvailability> {
  const lookup = deps.lookup ?? defaultLookup;
  const env = deps.env ?? process.env;
  const [claudeCode, codex] = await Promise.all([
    isAgentAvailable('claude-code', lookup, env),
    isAgentAvailable('codex', lookup, env),
  ]);
  return { claudeCode, codex };
}

export async function hasAnyLocalAgent(
  deps: DetectLocalAgentsDeps = {},
): Promise<boolean> {
  const availability = await detectLocalAgents(deps);
  return availability.claudeCode || availability.codex;
}

export async function isAgentAvailable(
  type: ExternalAgentType,
  lookup: (binary: string) => Promise<boolean> = defaultLookup,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const spec = resolveExternalAgentSpec(type, env);
  const hasOverride = Boolean(env[OVERRIDE_ENV[type]]?.trim());

  if (hasOverride) {
    return safeLookup(lookup, spec.command);
  }

  const [launcherReady, targetReady] = await Promise.all([
    safeLookup(lookup, spec.command),
    safeLookup(lookup, TARGET_BINARIES[type]),
  ]);
  return launcherReady && targetReady;
}

async function safeLookup(
  lookup: (binary: string) => Promise<boolean>,
  binary: string,
): Promise<boolean> {
  try {
    return await lookup(binary);
  } catch {
    return false;
  }
}

async function defaultLookup(binary: string): Promise<boolean> {
  if (path.isAbsolute(binary) || binary.includes('/') || binary.includes('\\')) {
    try {
      await access(binary, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(
      lookupCommand,
      [binary],
      { timeout: 1500, windowsHide: true },
      (error, stdout) => {
        resolve(!error && typeof stdout === 'string' && stdout.trim().length > 0);
      },
    );
  });
}

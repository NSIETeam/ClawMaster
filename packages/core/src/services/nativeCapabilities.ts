import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface NativeCapability {
  id: string;
  provider: string;
  status: 'ready' | 'unavailable';
  description: string;
}

interface NativeCapabilityManifest {
  schemaVersion: number;
  runtime: string;
  capabilities: NativeCapability[];
}

export function loadNativeCapabilities(): NativeCapability[] {
  const file = process.env['CLAWMASTER_NATIVE_CAPABILITIES_FILE'];
  if (!file || !fs.existsSync(file)) return [];
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as NativeCapabilityManifest;
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.capabilities)) return [];
    return manifest.capabilities.filter(
      (capability) =>
        capability &&
        typeof capability.id === 'string' &&
        typeof capability.provider === 'string' &&
        capability.status === 'ready',
    );
  } catch {
    return [];
  }
}

export function nativeHelperPath(): string | undefined {
  const helper = process.env['CLAWMASTER_NATIVE_HELPER'];
  return helper && fs.existsSync(helper) ? helper : undefined;
}

export function resolveRuntimeModule(moduleName: string): string {
  const agentRoot = process.env['CLAWMASTER_AGENT_ROOT'];
  const resolver = createRequire(
    agentRoot ? path.join(agentRoot, 'server.mjs') : import.meta.url,
  );
  return resolver.resolve(moduleName);
}

export function buildNativeCapabilityPrompt(): string {
  const capabilities = loadNativeCapabilities();
  if (capabilities.length === 0) return '';
  return [
    '━━━ ClawMaster 本机能力提供者 ━━━',
    ...capabilities.map(
      (capability) =>
        `- ${capability.id} [${capability.provider}]：${capability.description}`,
    ),
    '',
    '能力使用规则：以上能力已经由当前 ClawMaster 运行时提供。不得把对应外部 CLI 当作前置条件，也不得建议用户重复安装；只有请求超出描述范围时，才可把外部组件说明为可选增强。',
  ].join('\n');
}

export async function runNativeHelper(args: string[]): Promise<string> {
  const helper = nativeHelperPath();
  if (!helper) throw new Error('ClawMaster native helper is unavailable');
  const { stdout } = await execFileAsync(helper, ['--native-tool', ...args], {
    timeout: 60_000,
    maxBuffer: 100 * 1024 * 1024,
  });
  return stdout.trim();
}

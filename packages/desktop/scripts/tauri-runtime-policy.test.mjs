import { describe, expect, it } from 'vitest';
import {
  assertDownloadPackageTarget,
  assertNoRuntimeDownload,
  evaluateAgentPrivateBytes,
  evaluateArtifactSize,
  evaluateRuntimeSize,
  resolveTauriRuntimePlatform,
  resolveTauriRuntimeTarget,
  resolveTauriPackagingMode,
  summarizeRuntimeComponents,
} from './tauri-runtime-policy.mjs';

describe('Tauri native-local release policy', () => {
  it('supports every required desktop target', () => {
    expect(resolveTauriRuntimeTarget('darwin', 'arm64')).toBe('darwin-arm64');
    expect(resolveTauriRuntimePlatform('win32', 'x64')).toMatchObject({
      target: 'win32-x64',
      targetTriple: 'x86_64-pc-windows-msvc',
      executableSuffix: '.exe',
    });
    expect(() => resolveTauriRuntimeTarget('darwin', 'x64')).toThrow('not packaged');
    expect(() => resolveTauriRuntimeTarget('linux', 'x64')).toThrow('not packaged');
    expect(() => resolveTauriRuntimeTarget('linux', 'arm64')).toThrow('not packaged');
  });

  it('requires a local runtime and disallows silent runtime downloads', () => {
    const policy = resolveTauriPackagingMode();
    expect(policy).toMatchObject({
      mode: 'native-local',
      embedsLocalExecution: true,
      allowsRuntimeDownload: false,
    });
    expect(assertNoRuntimeDownload(policy)).toBe(policy);
  });

  it('enforces format-specific artifact limits', () => {
    expect(evaluateArtifactSize(9 * 1024 * 1024, 'nsis').withinTarget).toBe(true);
    expect(evaluateArtifactSize(19 * 1024 * 1024, 'dmg').withinTarget).toBe(false);
    expect(evaluateArtifactSize(59 * 1024 * 1024, 'appimage').withinTarget).toBe(false);
    expect(() => evaluateArtifactSize(21 * 1024 * 1024, 'deb')).toThrow('hard limit');
    const overTarget = evaluateArtifactSize(19 * 1024 * 1024, 'dmg');
    expect(() => assertDownloadPackageTarget(overTarget)).toThrow('product target');
    expect(assertDownloadPackageTarget(overTarget, { allowOverTarget: true })).toBe(overTarget);
  });

  it('enforces the per-agent private state budget', () => {
    expect(evaluateAgentPrivateBytes(1024 * 1024).withinLimit).toBe(true);
    expect(() => evaluateAgentPrivateBytes(1024 * 1024 + 1)).toThrow('hard limit');
  });

  it('keeps a temporary hard ceiling while reporting the 20 MiB runtime target', () => {
    expect(evaluateRuntimeSize(20 * 1024 * 1024).withinTarget).toBe(true);
    expect(evaluateRuntimeSize(24 * 1024 * 1024).withinTarget).toBe(false);
    expect(() => evaluateRuntimeSize(33 * 1024 * 1024)).toThrow('hard limit');
  });

  it('reports components in descending order under the selected format', () => {
    expect(summarizeRuntimeComponents({
      renderer: 3 * 1024 * 1024,
      native: 6 * 1024 * 1024,
      manifest: 1024 * 1024,
    }, 'nsis')).toMatchObject({
      totalBytes: 10 * 1024 * 1024,
      withinTarget: true,
      components: [
        { name: 'native', bytes: 6 * 1024 * 1024 },
        { name: 'renderer', bytes: 3 * 1024 * 1024 },
        { name: 'manifest', bytes: 1024 * 1024 },
      ],
    });
  });

  it('rejects unsupported packaging modes', () => {
    expect(() => resolveTauriPackagingMode('legacy')).toThrow('unsupported');
  });
});

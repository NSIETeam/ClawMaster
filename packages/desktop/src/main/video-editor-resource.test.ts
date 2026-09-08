/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveVideoEditorIndex } from './video-editor-resource.js';

describe('video editor packaged resource', () => {
  it('打包后只从 Electron resourcesPath 读取内置编辑器', () => {
    expect(resolveVideoEditorIndex({
      isPackaged: true,
      resourcesPath: '/Applications/ClawMaster.app/Contents/Resources',
      moduleDir: '/Applications/ClawMaster.app/Contents/Resources/app.asar/dist/main',
    })).toBe(join(
      '/Applications/ClawMaster.app/Contents/Resources',
      'video-editor',
      'index.html',
    ));
  });

  it('开发态仍从仓库 resources/video-editor 读取', () => {
    expect(resolveVideoEditorIndex({
      isPackaged: false,
      resourcesPath: '/unused',
      moduleDir: '/workspace/packages/desktop/dist/main',
    })).toBe(resolve(
      '/workspace/packages/desktop/dist/main',
      '..',
      '..',
      '..',
      '..',
      'resources',
      'video-editor',
      'index.html',
    ));
  });

  it('macOS 与 Windows 使用同一 Tauri 配置且不捆绑视频编辑器', () => {
    const config = JSON.parse(
      readFileSync(resolve(__dirname, '../../src-tauri/tauri.conf.json'), 'utf8'),
    ) as { bundle: { resources: Record<string, string>; externalBin?: string[] } };
    expect(config.bundle.resources).toEqual({});
    expect(config.bundle.externalBin ?? []).toEqual([]);
  });
});

/**
 * @license Copyright 2026 NSIETeam SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(import.meta.dirname);

describe('Core historical-code contract', () => {
  it('keeps removed duplicate and unregistered runtime paths absent', () => {
    for (const relative of [
      'core/confirmationBridge.ts',
      'core/modelConfig.ts',
      'hooks/index.ts',
      'services/semanticRetention.ts',
      'sessions/midTurnDrain.ts',
      'skills/script-executor.test.ts',
      'skills/script-executor.ts',
      'skills/skills-context-builder.ts',
      'skills/skills-compat.ts',
      'telemetry/file-exporters.ts',
      'tools/image-generator.ts',
      'utils/LruCache.ts',
      'utils/editCorrector.ts',
      'utils/testUtils.ts',
      'utils/fetch.ts',
    ]) {
      expect(fs.existsSync(path.join(sourceRoot, relative)), relative).toBe(false);
    }
  });

  it('retains the canonical implementations used by the product runtime', () => {
    for (const relative of [
      'core/imageGenerator.ts',
      'hooks/hookSystem.ts',
      'services/compressionService.ts',
      'skills/skills-catalog-adapter.ts',
      'core/toolExecutionEngine.ts',
    ]) {
      expect(fs.existsSync(path.join(sourceRoot, relative)), relative).toBe(true);
    }
  });

  it('does not restore the obsolete todo snapshot accessor', () => {
    const todoTool = fs.readFileSync(path.join(sourceRoot, 'tools/todo-write.ts'), 'utf8');
    expect(todoTool).not.toContain('getMemoryTodos');
  });

  it('does not restore the obsolete custom-model id generator', () => {
    const customModels = fs.readFileSync(path.join(sourceRoot, 'types/customModel.ts'), 'utf8');
    expect(customModels).not.toContain('generateLegacyCustomModelId');
  });

  it('keeps model skill context on the canonical injector path', () => {
    const catalog = fs.readFileSync(
      path.join(sourceRoot, 'skills/skills-catalog-adapter.ts'),
      'utf8',
    );
    const integration = fs.readFileSync(
      path.join(sourceRoot, 'skills/skills-integration.ts'),
      'utf8',
    );
    const injector = fs.readFileSync(
      path.join(sourceRoot, 'skills/skill-context-injector.ts'),
      'utf8',
    );
    expect(catalog).not.toContain('buildContext');
    expect(integration).toContain('injectStartupContext');
    expect(injector).not.toContain('skillContextInjector =');
    expect(injector).not.toContain('formatContextString');
  });

  it('does not expose unconfigured skill service singletons', () => {
    const obsoleteSingletons = [
      ['skills/settings-manager.ts', 'export const settingsManager'],
      ['skills/marketplace-manager.ts', 'export const marketplaceManager'],
      ['skills/plugin-installer.ts', 'export const pluginInstaller'],
      ['skills/skill-loader.ts', 'export const skillLoader'],
    ] as const;

    for (const [relative, declaration] of obsoleteSingletons) {
      const source = fs.readFileSync(path.join(sourceRoot, relative), 'utf8');
      expect(source, relative).not.toContain(declaration);
    }

    const loader = fs.readFileSync(path.join(sourceRoot, 'skills/skill-loader.ts'), 'utf8');
    expect(loader).not.toContain('_marketplaceManager');
  });

  it('keeps dangerous-command policy immutable at runtime', () => {
    const detector = fs.readFileSync(
      path.join(sourceRoot, 'utils/dangerous-command-detector.ts'),
      'utf8',
    );
    expect(detector).not.toContain('addCustomDangerousCommandRule');
    expect(detector).not.toContain('getAllDangerousCommandRules');
  });
});

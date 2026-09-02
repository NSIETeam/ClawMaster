/**
 * Copyright 2025 Felix
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillsCatalogAdapter } from './skills-catalog-adapter.js';
import { SkillLoader } from './skill-loader.js';
import { SettingsManager } from './settings-manager.js';
import { MarketplaceManager } from './marketplace-manager.js';
import { SkillLoadLevel, SkillSource } from './skill-types.js';
import type { Skill } from './skill-types.js';

// Mock dependencies
vi.mock('./skill-loader.js');
vi.mock('./settings-manager.js');
vi.mock('./marketplace-manager.js');

describe('SkillsCatalogAdapter', () => {
  let adapter: SkillsCatalogAdapter;
  type MockFn = ReturnType<typeof vi.fn>;
  let mockLoader: { loadEnabledSkills: MockFn; loadSkill: MockFn };
  let mockSettings: { initialize: MockFn };
  let mockMarketplace: Record<string, unknown>;

  // Mock skill data
  const createMockSkill = (id: string, marketplaceId: string): Skill => {
    // 根据 marketplaceId 推断 SkillSource 类型
    let sourceType: SkillSource = SkillSource.MARKETPLACE;
    if (marketplaceId === 'user-global' || marketplaceId.startsWith('user:')) {
      sourceType = SkillSource.USER_GLOBAL;
    } else if (marketplaceId === 'user-project' || marketplaceId.startsWith('project:')) {
      sourceType = SkillSource.USER_PROJECT;
    }

    return {
      id,
      name: `Skill ${id}`,
      description: `Description for ${id}`,
      pluginId: 'test-plugin',
      marketplaceId,
      path: `/path/to/${id}`,
      skillFilePath: `/path/to/${id}/skill.md`,
      metadata: {
        name: `Skill ${id}`,
        description: `Description for ${id}`,
      },
      enabled: true,
      loadLevel: SkillLoadLevel.METADATA,
      isBuiltIn: false,
      isCustom: marketplaceId.startsWith('user'),
      // 添加 location 信息以支持新的分组逻辑
      location: {
        type: sourceType,
        path: `/path/to/${id}`,
        rootPath: '/path/to',
        relativePath: id,
      },
    };
  };

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Mock SettingsManager
    mockSettings = {
      initialize: vi.fn().mockResolvedValue(undefined),
    };
    (SettingsManager as unknown as { mockImplementation: (factory: () => unknown) => unknown }).mockImplementation(() => mockSettings);

    // Mock MarketplaceManager
    mockMarketplace = {};
    (MarketplaceManager as unknown as { mockImplementation: (factory: () => unknown) => unknown }).mockImplementation(() => mockMarketplace);

    // Mock SkillLoader
    mockLoader = {
      loadEnabledSkills: vi.fn(),
      loadSkill: vi.fn(),
    };
    (SkillLoader as unknown as { mockImplementation: (factory: () => unknown) => unknown }).mockImplementation(() => mockLoader);

    // Create adapter instance
    adapter = new SkillsCatalogAdapter('/mock/project/root');
  });

  describe('initialize', () => {
    it('should initialize settings on first call', async () => {
      await adapter.initialize();

      expect(mockSettings.initialize).toHaveBeenCalledTimes(1);
    });

    it('should not initialize again on subsequent calls', async () => {
      await adapter.initialize();
      await adapter.initialize();
      await adapter.initialize();

      expect(mockSettings.initialize).toHaveBeenCalledTimes(1);
    });
  });

  describe('listSkills', () => {
    it('should return empty array when no skills are available', async () => {
      mockLoader.loadEnabledSkills.mockResolvedValue([]);

      const result = await adapter.listSkills();

      expect(result).toEqual([]);
      expect(mockLoader.loadEnabledSkills).toHaveBeenCalledWith(SkillLoadLevel.METADATA);
    });

    it('should convert Skill objects to SkillInfo format', async () => {
      const mockSkills = [
        createMockSkill('skill1', 'marketplace1'),
        createMockSkill('skill2', 'marketplace2'),
      ];
      mockLoader.loadEnabledSkills.mockResolvedValue(mockSkills);

      const result = await adapter.listSkills();

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 'skill1',
        name: 'Skill skill1',
        description: 'Description for skill1',
        pluginId: 'test-plugin',
        marketplaceId: 'marketplace1',
        path: '/path/to/skill1',
        skillFilePath: '/path/to/skill1/skill.md',
        enabled: true,
      });
      expect(result[1]).toMatchObject({
        id: 'skill2',
        name: 'Skill skill2',
        description: 'Description for skill2',
        pluginId: 'test-plugin',
        marketplaceId: 'marketplace2',
        path: '/path/to/skill2',
        skillFilePath: '/path/to/skill2/skill.md',
        enabled: true,
      });
    });

    it('should return empty array on error and log warning', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockLoader.loadEnabledSkills.mockRejectedValue(new Error('Load failed'));

      const result = await adapter.listSkills();

      expect(result).toEqual([]);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[SkillsCatalogAdapter] Failed to load skills:',
        expect.any(Error)
      );

      consoleWarnSpy.mockRestore();
    });

    it('should auto-initialize if not initialized', async () => {
      mockLoader.loadEnabledSkills.mockResolvedValue([]);

      await adapter.listSkills();

      expect(mockSettings.initialize).toHaveBeenCalled();
    });
  });

  describe('getSkillDetails', () => {
    it('should return null when skill is not found', async () => {
      mockLoader.loadSkill.mockResolvedValue(null);

      const result = await adapter.getSkillDetails('non-existent');

      expect(result).toBeNull();
      expect(mockLoader.loadSkill).toHaveBeenCalledWith('non-existent', SkillLoadLevel.METADATA);
    });

    it('should return SkillInfo when skill is found', async () => {
      const mockSkill = createMockSkill('test-skill', 'test-marketplace');
      mockLoader.loadSkill.mockResolvedValue(mockSkill);

      const result = await adapter.getSkillDetails('test-skill');

      expect(result).toMatchObject({
        id: 'test-skill',
        name: 'Skill test-skill',
        description: 'Description for test-skill',
        pluginId: 'test-plugin',
        marketplaceId: 'test-marketplace',
        path: '/path/to/test-skill',
        skillFilePath: '/path/to/test-skill/skill.md',
        enabled: true,
      });
    });

    it('should return null on error and log warning', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockLoader.loadSkill.mockRejectedValue(new Error('Load failed'));

      const result = await adapter.getSkillDetails('error-skill');

      expect(result).toBeNull();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[SkillsCatalogAdapter] Failed to get skill details for error-skill:',
        expect.any(Error)
      );

      consoleWarnSpy.mockRestore();
    });

    it('should auto-initialize if not initialized', async () => {
      mockLoader.loadSkill.mockResolvedValue(null);

      await adapter.getSkillDetails('test-skill');

      expect(mockSettings.initialize).toHaveBeenCalled();
    });
  });

});

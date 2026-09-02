/**
 * Skills catalog query facade.
 *
 * Tools and the local server use this adapter when they need the compact
 * SkillInfo projection rather than the complete Skill model.
 */

import { SkillLoader } from './skill-loader.js';
import { SettingsManager } from './settings-manager.js';
import { SkillLoadLevel } from './skill-types.js';
import type { Skill, SkillInfo } from './skill-types.js';

/** Compact read facade over SkillLoader. */
export class SkillsCatalogAdapter {
  private loader: SkillLoader;
  private settings: SettingsManager;
  private initialized = false;

  constructor(projectRoot?: string) {
    // Pass projectRoot through so project skill discovery does not depend on process cwd.
    this.settings = new SettingsManager();
    this.loader = new SkillLoader(this.settings, { projectRoot });
  }

  /**
   * Initialize the skills system (async)
   * Must be called before using other methods
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.settings.initialize();
    this.initialized = true;
  }

  /** List all enabled skills as the compact catalog projection. */
  async listSkills(): Promise<SkillInfo[]> {
    await this.initialize();

    try {
      // Load skills with METADATA level (lightweight)
      const skills = await this.loader.loadEnabledSkills(SkillLoadLevel.METADATA);

      // Use an arrow callback so the instance conversion method keeps its receiver.
      return skills.map((skill) => this.convertSkillToSkillInfo(skill));
    } catch (error) {
      console.warn('[SkillsCatalogAdapter] Failed to load skills:', error);
      return [];
    }
  }

  /** Get compact details for one enabled skill. */
  async getSkillDetails(skillId: string): Promise<SkillInfo | null> {
    await this.initialize();

    try {
      // Load skill with METADATA level
      const skill = await this.loader.loadSkill(skillId, SkillLoadLevel.METADATA);

      if (!skill) {
        return null;
      }

      return this.convertSkillToSkillInfo(skill);
    } catch (error) {
      console.warn(`[SkillsCatalogAdapter] Failed to get skill details for ${skillId}:`, error);
      return null;
    }
  }

  /**
   * Convert the loader model to the stable catalog projection.
   */
  private convertSkillToSkillInfo(skill: Skill): SkillInfo {
    return {
      id: skill.id,
      name: skill.name,
      pluginId: skill.pluginId,
      marketplaceId: skill.marketplaceId,
      description: skill.description,
      path: skill.path,
      skillFilePath: skill.skillFilePath,
      enabled: skill.enabled,
    };
  }
}

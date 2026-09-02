/**
 * Skills system exports
 *
 * This module provides the complete Skills system for Otto.
 * All skill-related functionality has been consolidated here from cli package
 * to ensure proper bundling and avoid cross-package dynamic imports.
 */

// Skill types (comprehensive types from skill system)
export * from './skill-types.js';

// Models
export * from './models/index.js';

// Parsers
export * from './parsers/index.js';

// Loaders
export * from './loaders/index.js';
import { SettingsManager as SettingsManagerImpl } from './settings-manager.js';
import { MarketplaceManager as MarketplaceManagerImpl } from './marketplace-manager.js';
import { PluginInstaller as PluginInstallerImpl } from './plugin-installer.js';
import { SkillLoader as SkillLoaderImpl } from './skill-loader.js';
import { SkillContextInjector as SkillContextInjectorImpl } from './skill-context-injector.js';

// Core Services
export { SettingsManager, SkillsPaths } from './settings-manager.js';
export { MarketplaceManager } from './marketplace-manager.js';
export { PluginInstaller } from './plugin-installer.js';
export { SkillLoader } from './skill-loader.js';
export { SkillContextInjector } from './skill-context-injector.js';

// Integration
export {
  getSkillsContext,
  initializeSkillsContext,
  clearSkillsContextCache,
} from './skills-integration.js';
export {
  loadBuiltinSkillInstructions,
  seedDefaultSkills,
  shouldRefreshBuiltinSkill,
} from './seed-skills.js';

// Query facade used by tools and the local server.
export { SkillsCatalogAdapter } from './skills-catalog-adapter.js';

/**
 * Initialize Skills System
 *
 * This should be called once at startup to initialize the Skills system
 */
export async function initializeSkillsSystem(): Promise<void> {
  const settings = new SettingsManagerImpl();
  await settings.initialize();
}

/**
 * Create Skills System instances with proper dependency injection
 */
export function createSkillsSystem() {
  const settings = new SettingsManagerImpl();
  const marketplace = new MarketplaceManagerImpl(settings);
  const installer = new PluginInstallerImpl(settings, marketplace);
  const loader = new SkillLoaderImpl(settings);
  const injector = new SkillContextInjectorImpl(loader);

  return {
    settings,
    marketplace,
    installer,
    loader,
    injector,
  };
}

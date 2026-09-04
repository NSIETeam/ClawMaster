/**
 * ClawMaster Skills System - Integration with Core
 *
 * Provides Skills context to the AI system prompt
 */

import path from 'node:path';
import { SkillContextInjector } from './skill-context-injector.js';
import { SkillLoader } from './skill-loader.js';
import { seedDefaultSkills } from './seed-skills.js';
import { SettingsManager } from './settings-manager.js';

let cachedSkillsContext: string | null = null;
let cachedProjectRoot: string | null = null;
let lastCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get Skills context for AI system prompt (synchronous)
 *
 * Returns cached context if available, empty string otherwise.
 * Call initializeSkillsContext() at startup to populate cache.
 */
export function getSkillsContext(): string {
  return cachedSkillsContext || '';
}

/**
 * Initialize Skills context asynchronously
 *
 * This should be called once at startup to load and cache
 * the Skills metadata for injection into the system prompt.
 *
 * @param projectRoot - 项目根目录路径（可选，默认为 process.cwd()）
 */
export async function initializeSkillsContext(projectRoot?: string): Promise<void> {
  const now = Date.now();
  const resolvedProjectRoot = path.resolve(projectRoot ?? process.cwd());
  if (
    cachedSkillsContext !== null
    && cachedProjectRoot === resolvedProjectRoot
    && now - lastCacheTime < CACHE_TTL
  ) {
    return;
  }

  try {
    // 预置内置 skill 到 ~/.otto-user/skills/（幂等），保证开箱即有 skill 可被发现/加载。
    try {
      seedDefaultSkills();
    } catch {
      // 预置失败不影响后续（skills 系统本就可选）
    }

    const settings = new SettingsManager();
    await settings.initialize();

    // 传入 projectRoot 参数，确保 SkillLoader 使用正确的项目根目录
    const loader = new SkillLoader(settings, { projectRoot: resolvedProjectRoot });
    const injector = new SkillContextInjector(loader);

    const result = await injector.injectStartupContext();

    if (!result.context || result.context.trim().length === 0) {
      // No skills available
      cachedSkillsContext = '';
      cachedProjectRoot = resolvedProjectRoot;
      lastCacheTime = now;
      return;
    }

    // Format for system prompt - minimal, since detailed instructions are in use_skill tool
    const formattedContext = `
# Available Skills

You have access to specialized Skills that provide domain knowledge, workflows, and executable scripts.

${result.context}

**Mandatory Skill Usage**:
If a skill's description says it MUST be used for the current task, you MUST call \`use_skill\` before doing any work.
When in doubt, prefer loading the skill first.

**Important**: Skills marked with 📜 or <has_scripts>true</has_scripts> have executable scripts.
You MUST use the \`use_skill\` tool to load their instructions before executing any scripts.
See the \`use_skill\` tool description for complete usage instructions.

**Token cost**: ~${result.estimatedTokens} tokens (metadata only, full instructions loaded on-demand)
`;

    cachedSkillsContext = formattedContext.trim();
    cachedProjectRoot = resolvedProjectRoot;
    lastCacheTime = now;
  } catch (error) {
    // Silently fail - Skills system is optional
    console.warn('[Skills] Failed to load context:', error);
    cachedSkillsContext = '';
    cachedProjectRoot = resolvedProjectRoot;
    lastCacheTime = now;
  }
}

/**
 * Clear the Skills context cache
 *
 * Call this when skills are installed/uninstalled/enabled/disabled
 */
export function clearSkillsContextCache(): void {
  cachedSkillsContext = null;
  cachedProjectRoot = null;
  lastCacheTime = 0;
}

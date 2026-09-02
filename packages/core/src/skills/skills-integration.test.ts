import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initializeSettings: vi.fn(),
  injectStartupContext: vi.fn(),
  seedDefaultSkills: vi.fn(),
}));

class MockSettingsManager {
  initialize = mocks.initializeSettings;
}

class MockMarketplaceManager {}
class MockSkillLoader {}
class MockSkillContextInjector {
  injectStartupContext = mocks.injectStartupContext;
}

vi.mock('./seed-skills.js', () => ({
  seedDefaultSkills: mocks.seedDefaultSkills,
}));
vi.mock('./settings-manager.js', () => ({ SettingsManager: MockSettingsManager }));
vi.mock('./marketplace-manager.js', () => ({ MarketplaceManager: MockMarketplaceManager }));
vi.mock('./skill-loader.js', () => ({ SkillLoader: MockSkillLoader }));
vi.mock('./skill-context-injector.js', () => ({ SkillContextInjector: MockSkillContextInjector }));
vi.mock('./index.js', () => ({
  SettingsManager: MockSettingsManager,
  MarketplaceManager: MockMarketplaceManager,
  SkillLoader: MockSkillLoader,
  SkillContextInjector: MockSkillContextInjector,
}));

describe('skills integration cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.initializeSettings.mockResolvedValue(undefined);
  });

  it('caches an empty startup result instead of rescanning within the TTL', async () => {
    mocks.injectStartupContext.mockResolvedValue({
      context: '',
      estimatedTokens: 0,
      skillCount: 0,
      levelStats: { metadata: 0, full: 0, resources: 0 },
    });
    const integration = await import('./skills-integration.js');

    await integration.initializeSkillsContext('/workspace');
    await integration.initializeSkillsContext('/workspace');

    expect(integration.getSkillsContext()).toBe('');
    expect(mocks.initializeSettings).toHaveBeenCalledTimes(1);
    expect(mocks.injectStartupContext).toHaveBeenCalledTimes(1);
    expect(mocks.seedDefaultSkills).toHaveBeenCalledTimes(1);
  });

  it('reloads only after the cache is explicitly cleared', async () => {
    mocks.injectStartupContext.mockResolvedValue({
      context: '- skill',
      estimatedTokens: 2,
      skillCount: 1,
      levelStats: { metadata: 1, full: 0, resources: 0 },
    });
    const integration = await import('./skills-integration.js');

    await integration.initializeSkillsContext('/workspace');
    await integration.initializeSkillsContext('/workspace');
    integration.clearSkillsContextCache();
    await integration.initializeSkillsContext('/workspace');

    expect(mocks.initializeSettings).toHaveBeenCalledTimes(2);
    expect(mocks.injectStartupContext).toHaveBeenCalledTimes(2);
  });

  it('does not reuse project-specific skills for a different workspace', async () => {
    mocks.injectStartupContext.mockResolvedValue({
      context: '- project skill',
      estimatedTokens: 2,
      skillCount: 1,
      levelStats: { metadata: 1, full: 0, resources: 0 },
    });
    const integration = await import('./skills-integration.js');

    await integration.initializeSkillsContext('/workspace/one');
    await integration.initializeSkillsContext('/workspace/two');

    expect(mocks.initializeSettings).toHaveBeenCalledTimes(2);
    expect(mocks.injectStartupContext).toHaveBeenCalledTimes(2);
  });
});

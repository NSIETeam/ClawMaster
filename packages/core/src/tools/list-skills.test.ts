import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ListSkillsTool } from './list-skills.js';
import { Config } from '../config/config.js';
import { SkillsCatalogAdapter } from '../skills/skills-catalog-adapter.js';

vi.mock('../skills/skills-catalog-adapter.js');
vi.mock('../config/config.js');

describe('ListSkillsTool', () => {
  let tool: ListSkillsTool;
  type MockFn = ReturnType<typeof vi.fn>;
  let mockConfig: Config;
  let mockCatalog: { listSkills: MockFn };

  beforeEach(() => {
    mockConfig = {
      getProjectRoot: vi.fn().mockReturnValue('/mock/root'),
    } as unknown as Config;

    mockCatalog = {
      listSkills: vi.fn(),
    };

    (SkillsCatalogAdapter as unknown as { mockImplementation: (factory: () => unknown) => unknown }).mockImplementation(() => mockCatalog);

    tool = new ListSkillsTool(mockConfig);
  });

  it('should return a specific message when no skills are found without filters', async () => {
    mockCatalog.listSkills.mockResolvedValue([]);

    const result = await tool.execute({}, new AbortController().signal);

    expect(result.llmContent).toBe('No skills are currently installed.');
    expect(result.returnDisplay).toBe('No skills found');
  });

  it('should return a helpful message when no skills match the filter', async () => {
    mockCatalog.listSkills.mockResolvedValue([
      { id: 's1', marketplaceId: 'm1', pluginId: 'p1', name: 'skill1' }
    ]);

    const result = await tool.execute({ marketplaceId: 'non-existent' }, new AbortController().signal);

    expect(result.llmContent).toContain('No skills are currently installed or match the filter criteria');
    expect(result.llmContent).toContain('Try calling this tool without any arguments');
    expect(result.returnDisplay).toBe('No skills found');
  });

  it('should list matching skills when filters are applied', async () => {
    const skills = [
      { id: 's1', marketplaceId: 'm1', pluginId: 'p1', name: 'skill1', description: 'desc1', path: 'path1', skillFilePath: 'md1', enabled: true },
      { id: 's2', marketplaceId: 'm2', pluginId: 'p2', name: 'skill2', description: 'desc2', path: 'path2', skillFilePath: 'md2', enabled: true }
    ];
    mockCatalog.listSkills.mockResolvedValue(skills);

    const result = await tool.execute({ marketplaceId: 'm1' }, new AbortController().signal);

    expect(result.llmContent).toContain('Found 1 skill(s)');
    expect(result.llmContent).toContain('skill1');
    expect(result.llmContent).not.toContain('skill2');
    expect(result.returnDisplay).toBe('Found 1 skill(s)');
  });
});

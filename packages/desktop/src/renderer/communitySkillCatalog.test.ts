import { describe, expect, it } from 'vitest';
import { FEATURED_COMMUNITY_SKILLS, filterCommunitySkills } from './communitySkillCatalog.js';

describe('community skill catalog', () => {
  it('ships an offline snapshot of roughly forty popular skills with GitHub sources', () => {
    expect(FEATURED_COMMUNITY_SKILLS).toHaveLength(41);
    expect(new Set(FEATURED_COMMUNITY_SKILLS.map((item) => item.id)).size).toBe(41);
    expect(FEATURED_COMMUNITY_SKILLS.every((item) => item.installUrl.startsWith('https://github.com/'))).toBe(true);
  });

  it('filters by category and searchable source metadata', () => {
    expect(filterCommunitySkills(FEATURED_COMMUNITY_SKILLS, 'anthropics', 'office').map((item) => item.name))
      .toEqual(expect.arrayContaining(['pptx', 'pdf', 'docx', 'xlsx']));
    expect(filterCommunitySkills(FEATURED_COMMUNITY_SKILLS, 'postgres', 'coding').length).toBeGreaterThan(0);
  });
});

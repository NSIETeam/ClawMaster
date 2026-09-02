import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installCommunitySkill,
  parseCommunitySkillSource,
  selectSkillDirectoryFromTree,
} from './community-skill-installer.js';

afterEach(() => vi.unstubAllGlobals());

describe('community skill installer', () => {
  it('only accepts a two-segment GitHub HTTPS repository', () => {
    expect(parseCommunitySkillSource('https://github.com/anthropics/skills')).toEqual({ owner: 'anthropics', repository: 'skills' });
    expect(() => parseCommunitySkillSource('http://github.com/anthropics/skills')).toThrow();
    expect(() => parseCommunitySkillSource('https://example.com/anthropics/skills')).toThrow();
    expect(() => parseCommunitySkillSource('https://github.com/anthropics/skills/tree/main')).toThrow();
  });

  it('selects the requested skill directory without checking out the whole repository', () => {
    const tree = [
      'README.md',
      'skills/docx/SKILL.md',
      'skills/pdf/SKILL.md',
      'skills/pdf/scripts/render.py',
    ].join('\n');
    expect(selectSkillDirectoryFromTree(tree, 'pdf')).toBe('skills/pdf');
    expect(selectSkillDirectoryFromTree(tree, 'missing')).toBeNull();
  });

  it('downloads only files inside the selected skill directory through GitHub APIs', async () => {
    const treeResponse = JSON.stringify({
        truncated: false,
        tree: [
          { path: 'README.md', mode: '100644', type: 'blob', size: 99 },
          { path: 'skills/pdf/SKILL.md', mode: '100644', type: 'blob', size: 7 },
          { path: 'skills/pdf/scripts/render.js', mode: '100644', type: 'blob', size: 6 },
          { path: 'skills/docx/SKILL.md', mode: '100644', type: 'blob', size: 8 },
        ],
      });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/repos/anthropics/skills')) return new Response(JSON.stringify({ default_branch: 'main' }));
      if (url.includes('/git/trees/')) return new Response(treeResponse);
      if (url.endsWith('/SKILL.md')) return new Response('skill:1');
      if (url.endsWith('/scripts/render.js')) return new Response('render');
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const root = await fs.mkdtemp(join(tmpdir(), 'clawmaster-community-test-'));
    try {
      const result = await installCommunitySkill({
        id: 'pdf', source: 'https://github.com/anthropics/skills', slug: 'pdf',
      }, root);
      expect(await fs.readFile(join(result.installPath, 'SKILL.md'), 'utf8')).toBe('skill:1');
      expect(await fs.readFile(join(result.installPath, 'scripts/render.js'), 'utf8')).toBe('render');
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('docx'))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

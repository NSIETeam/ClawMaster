import { describe, expect, it } from 'vitest';
import type { ProjectModuleInfo } from 'clawmaster-server';
import type { ModuleDefinition } from './moduleCatalog.js';
import { presentProjectModule } from './projectModulePresentation.js';

const tile: ModuleDefinition = {
  id: 'project-module:cad', label: 'CAD', category: 'capability', icon: 'self-development',
  activation: { kind: 'guided-task', taskId: 'cad', instructions: 'refine' }, availability: 'available',
};
const project: ProjectModuleInfo = {
  schemaVersion: 1, id: tile.id, name: 'CAD', description: 'CAD capability',
  sourcePattern: 'render_cad', instructions: 'refine', status: 'draft',
};

describe('project module readiness presentation', () => {
  it.each(['draft', 'refining', 'needs_review', 'blocked'] as const)('keeps %s modules visibly provisional', (status) => {
    expect(presentProjectModule(tile, { ...project, status })).toMatchObject({ proposalCount: 1 });
    expect(presentProjectModule(tile, { ...project, status }).label).not.toBe(tile.label);
  });
  it('leaves unrelated and explicitly ready modules unchanged', () => {
    expect(presentProjectModule(tile)).toBe(tile);
    expect(presentProjectModule(tile, { ...project, status: 'ready' })).toBe(tile);
  });
});

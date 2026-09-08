import type { ProjectModuleInfo } from 'clawmaster-server';
import type { ModuleDefinition } from './moduleCatalog.js';

export function presentProjectModule(module: ModuleDefinition, project?: ProjectModuleInfo): ModuleDefinition {
  if (!project || project.status === 'ready') return module;
  const label = {
    draft: '待完善',
    refining: '正在完善',
    needs_review: '待验收',
    blocked: '需要处理',
  }[project.status];
  return { ...module, label: `${module.label} · ${label}`, description: `${label}：${project.description}`, proposalCount: 1 };
}

/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ModuleCategory, ModuleDefinition } from '../moduleCatalog.js';
import { addOrMoveModules, type ModuleWorkspaceLayout } from '../moduleWorkspace.js';
import { ModuleIcon } from './ModuleIcon.js';
import { IconCommunitySkill } from './CommunitySkillIcon.js';
import {
  FEATURED_COMMUNITY_SKILLS,
  filterCommunitySkills,
  type CommunitySkillCategory,
} from '../communitySkillCatalog.js';

const CATEGORY_LABELS: Readonly<Record<ModuleCategory, string>> = {
  common: '常用',
  park: '园区服务',
  capability: '企业能力',
  platform: '业务平台',
  'custom-agent': '我的专家',
  'customer-module': '客户模块',
};

const CATEGORY_ORDER: readonly ModuleCategory[] = [
  'common',
  'park',
  'capability',
  'custom-agent',
  'customer-module',
];

const SKILL_NAME_ACRONYMS: Readonly<Record<string, string>> = {
  ai: 'AI', api: 'API', cli: 'CLI', css: 'CSS', docx: 'DOCX', html: 'HTML',
  pdf: 'PDF', pptx: 'PPTX', seo: 'SEO', sql: 'SQL', tdd: 'TDD', ui: 'UI',
  ux: 'UX', xlsx: 'XLSX',
};

function formatCommunitySkillName(name: string): string {
  return name.split('-').map((part) => SKILL_NAME_ACRONYMS[part]
    ?? `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`).join(' ');
}

export interface ModuleMarketplaceDialogProps {
  open: boolean;
  targetGroupId: string;
  layout: ModuleWorkspaceLayout;
  modules: readonly ModuleDefinition[];
  onConfirm(next: ModuleWorkspaceLayout): void;
  onClose(): void;
  onManageExperts(): void;
  onCreateModule?(): void;
  onBrowseCustomerModules?(): void;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute('hidden'));
}

export function ModuleMarketplaceDialog({
  open,
  targetGroupId,
  layout,
  modules,
  onConfirm,
  onClose,
  onManageExperts,
  onCreateModule,
  onBrowseCustomerModules,
}: ModuleMarketplaceDialogProps): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const [catalogView, setCatalogView] = useState<'builtin' | 'community'>('builtin');
  const [communityCategory, setCommunityCategory] = useState<CommunitySkillCategory | 'all'>('all');
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null);
  const [installedSkillNames, setInstalledSkillNames] = useState<Set<string>>(() => new Set());
  const [communityStatus, setCommunityStatus] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const titleId = `${useId()}-title`;
  const targetGroup = layout.groups.find((group) => group.id === targetGroupId);

  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setQuery('');
    setCatalogView('builtin');
    setCommunityCategory('all');
    setCommunityStatus(null);
    void window.clawmaster.communitySkillList()
      .then((items) => setInstalledSkillNames(new Set(items.map((item) => item.name))))
      .catch(() => setInstalledSkillNames(new Set()));
    setSelection(new Set());
    closeRef.current?.focus();
    return () => {
      const trigger = triggerRef.current;
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [open, targetGroupId]);

  const moduleLocation = useMemo(() => {
    const result = new Map<string, { groupId: string; groupName: string }>();
    for (const group of layout.groups) {
      for (const moduleId of group.moduleIds) {
        result.set(moduleId, { groupId: group.id, groupName: group.name });
      }
    }
    return result;
  }, [layout]);

  const visibleModules = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return modules.filter((module) => {
      if (module.availability === 'hidden') return false;
      if (!normalizedQuery) return true;
      return `${module.label} ${module.description ?? ''}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [modules, query]);
  const visibleCommunitySkills = useMemo(
    () => filterCommunitySkills(FEATURED_COMMUNITY_SKILLS, query, communityCategory),
    [query, communityCategory],
  );

  if (!open || !targetGroup) return null;

  const toggleSelection = (moduleId: string): void => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(moduleId)) next.delete(moduleId);
      else next.add(moduleId);
      return next;
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = focusableElements(dialogRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="claw-module-marketplace-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="claw-module-marketplace"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="claw-module-marketplace__header">
          <div>
            <h2 id={titleId}>插件广场</h2>
            <p>{catalogView === 'builtin' ? `添加到“${targetGroup.name}”` : '热门 GitHub Skill · 安装量快照'}</p>
          </div>
          <button ref={closeRef} type="button" aria-label="关闭添加模块" onClick={onClose}>×</button>
        </header>
        <div className="claw-module-marketplace__body">
        <nav className="claw-module-marketplace__tabs" aria-label="插件来源">
          <button type="button" className={catalogView === 'builtin' ? 'is-active' : ''} onClick={() => { setCatalogView('builtin'); setQuery(''); }}>
            本机模块
          </button>
          <button type="button" className={catalogView === 'community' ? 'is-active' : ''} onClick={() => { setCatalogView('community'); setQuery(''); }}>
            社区插件 <span>{FEATURED_COMMUNITY_SKILLS.length}</span>
          </button>
        </nav>
        <label className="claw-module-marketplace__search">
          <span className="sr-only">搜索模块</span>
          <input
            type="search"
            aria-label="搜索模块"
            placeholder={catalogView === 'builtin' ? '搜索本机模块……' : '搜索名称、作者或能力……'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {catalogView === 'community' ? <div className="claw-module-marketplace__filters" aria-label="社区插件分类">
          {([
            ['all', '全部'], ['coding', '开发'], ['design', '设计'], ['office', '办公'],
            ['research', '研究'], ['automation', '自动化'],
          ] as const).map(([value, label]) => <button
            key={value}
            type="button"
            className={communityCategory === value ? 'is-active' : ''}
            onClick={() => setCommunityCategory(value)}
          >{label}</button>)}
        </div> : null}
        <div className="claw-module-marketplace__catalog">
          {catalogView === 'builtin' ? <>
          {CATEGORY_ORDER.map((category) => {
            const categoryModules = visibleModules.filter((module) => module.category === category);
            if (categoryModules.length === 0) return null;
            return (
              <section key={category} className="claw-module-marketplace__category">
                <h3>{CATEGORY_LABELS[category]}</h3>
                <div className="claw-module-marketplace__modules">
                  {categoryModules.map((module) => {
                    const location = moduleLocation.get(module.id);
                    const inTargetGroup = location?.groupId === targetGroup.id;
                    const unavailable = module.availability !== 'available';
                    const disabled = inTargetGroup || unavailable;
                    return (
                      <label
                        key={module.id}
                        className={`claw-module-marketplace__module${disabled ? ' is-disabled' : ''}`}
                      >
                        <input
                          type="checkbox"
                          aria-label={module.label}
                          checked={inTargetGroup || selection.has(module.id)}
                          disabled={disabled}
                          onChange={() => toggleSelection(module.id)}
                        />
                        <ModuleIcon icon={module.icon} label={module.label} size={26} />
                        <span className="claw-module-marketplace__module-copy">
                          <strong>{module.label}</strong>
                          <small>
                            {inTargetGroup
                              ? '已添加到当前功能组'
                              : unavailable
                                ? module.disabledReason ?? '当前不可用'
                                : location
                                  ? `将从“${location.groupName}”移动`
                                  : module.description ?? '可添加到当前功能组'}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {visibleModules.length === 0 ? (
            <p className="claw-module-marketplace__empty">没有找到匹配的模块</p>
          ) : null}
          </> : <section className="claw-community-skill-grid" aria-label="社区插件目录">
            {visibleCommunitySkills.map((item) => {
              const installed = installedSkillNames.has(item.name);
              const busy = installingSkillId === item.id;
              return <article key={item.id} className="claw-community-skill-card">
                <div className="claw-community-skill-card__head">
                  <IconCommunitySkill category={item.category} />
                  <span>
                    <strong title={item.name}>{formatCommunitySkillName(item.name)}</strong>
                    <small title={item.source}>{item.source}</small>
                  </span>
                </div>
                <p>{item.description}</p>
                <div className="claw-community-skill-card__meta">
                  <span>{Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(item.installs)} 次安装</span>
                  <span>GitHub</span>
                </div>
                <button type="button" disabled={installed || busy || installingSkillId !== null} onClick={() => {
                  if (!window.confirm(`从 ${item.installUrl} 导入 ${item.name}？\n\nClawMaster 会下载并检查文件数量、体积、路径和符号链接。社区热度不代表安全背书，请只安装你信任的来源。`)) return;
                  setInstallingSkillId(item.id); setCommunityStatus(null);
                  void window.clawmaster.communitySkillInstall({ id: item.id, source: item.installUrl, slug: item.name })
                    .then((result) => {
                      setInstalledSkillNames((current) => new Set(current).add(item.name));
                      setCommunityStatus(`${result.name} 已导入本机；新会话将自动发现该插件。`);
                    })
                    .catch((error) => setCommunityStatus(error instanceof Error ? error.message : String(error)))
                    .finally(() => setInstallingSkillId(null));
                }}>{installed ? '已导入' : busy ? '正在校验…' : '一键导入'}</button>
              </article>;
            })}
            {visibleCommunitySkills.length === 0 ? <p className="claw-module-marketplace__empty">没有找到匹配的社区插件</p> : null}
          </section>}
          {communityStatus ? <p className="claw-community-skill-status" role="status">{communityStatus}</p> : null}
        </div>
        </div>
        <footer className="claw-module-marketplace__footer">
          {catalogView === 'community' ? <span className="claw-module-marketplace__source-note">来源：skills.sh 公开安装量排行快照</span> : null}
          {catalogView === 'builtin' ? <>
          <button type="button" className="claw-module-marketplace__manage" onClick={onManageExperts}>
            创建专家模块
          </button>
          {onCreateModule ? <button type="button" className="claw-module-marketplace__manage" onClick={onCreateModule}>
            包装客户模块
          </button> : null}
          {onBrowseCustomerModules ? <button type="button" className="claw-module-marketplace__manage" onClick={onBrowseCustomerModules}>
            客户模块市场
          </button> : null}
          <button
            type="button"
            className="claw-module-marketplace__confirm"
            disabled={selection.size === 0}
            onClick={() => {
              onConfirm(addOrMoveModules(layout, targetGroupId, [...selection]));
              onClose();
            }}
          >
            添加（{selection.size}）
          </button>
          </> : null}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

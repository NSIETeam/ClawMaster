/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 */

import type { EnterpriseOrganizationFeatures } from '../preload/index.js';
import {
  COMMON_EXPERT_PROFILES,
  type AgentProfile,
} from './agents/departmentAgents.js';
import type { CustomAgentDefinition } from './customAgents.js';
import type { ModuleIconKey, ModuleIconSource } from './components/ModuleIcon.js';

export type ModuleAvailability = 'available' | 'disabled' | 'hidden';
export type ModuleCategory = 'common' | 'park' | 'capability' | 'platform' | 'custom-agent' | 'customer-module';

export interface InstalledCustomerModuleSummary {
  id: string;
  version: string;
  name: string;
  description: string;
  enabled: boolean;
  suspendedReason?: string;
  iconSrc?: string;
}

export type ParkModuleTarget =
  | 'overview'
  | 'announcement'
  | 'satisfaction'
  | 'renovation'
  | 'parking'
  | 'network-phone'
  | 'meeting-room'
  | 'electric-card'
  | 'repair'
  | 'vehicle-visit'
  | 'staff-tasks'
  | 'my-applications';

export type ModuleActivation =
  | { kind: 'dialog'; dialog: 'park'; target: ParkModuleTarget }
  | { kind: 'dialog'; dialog: 'enterprise-memory' | 'auto-skill' }
  | { kind: 'route'; route: 'skill-zone' }
  | { kind: 'agent'; profileId: string; customAgentId?: string }
  | { kind: 'guided-task'; taskId: string; instructions: string }
  | { kind: 'platform'; platformId: string; url: string | null; instructions: string }
  | { kind: 'customer-module'; moduleId: string; version: string };

export interface ParkModuleAuthorization {
  hasParkContext: boolean;
  canViewStatistics: boolean;
  canViewStaffTasks: boolean;
}

export interface ModuleCatalogContext {
  edition: 'personal' | 'enterprise';
  profiles: readonly AgentProfile[];
  organizationFeatures: EnterpriseOrganizationFeatures | null;
  parkAuthorization: ParkModuleAuthorization;
  customAgents: readonly CustomAgentDefinition[];
  customerModules?: readonly InstalledCustomerModuleSummary[];
}

export interface ModuleDefinition {
  id: string;
  label: string;
  description?: string;
  category: ModuleCategory;
  icon: ModuleIconSource;
  activation: ModuleActivation;
  availability: ModuleAvailability;
  disabledReason?: string;
}

export const DEFAULT_PLATFORM_URLS = Object.freeze({
  'platform-zhifang': 'https://47.116.30.60/',
  'platform-trace-code': 'https://8.140.52.117/',
  'platform-zhiliaohou': 'http://47.116.30.60:18787/',
  'platform-zhixin-pigeon': 'http://47.116.30.60:18788/',
  'platform-maotouying': 'http://8.141.8.31/',
} satisfies Record<string, string>);

type StaticAvailabilityRule =
  | 'park'
  | 'park-statistics'
  | 'park-staff'
  | 'enterprise-memory'
  | 'auto-skill'
  | 'always'
  | 'skill-zone';

interface StaticModuleSpec extends Omit<ModuleDefinition, 'availability' | 'disabledReason'> {
  availabilityRule: StaticAvailabilityRule;
}

export const STATIC_MODULE_SPECS: readonly StaticModuleSpec[] = [
  {
    id: 'park-overview', label: '园区服务统计', category: 'park', icon: 'park-overview',
    activation: { kind: 'dialog', dialog: 'park', target: 'overview' },
    availabilityRule: 'park-statistics',
  },
  {
    id: 'park-announcement', label: '园区公告', category: 'park', icon: 'park-announcement',
    activation: { kind: 'dialog', dialog: 'park', target: 'announcement' },
    availabilityRule: 'park',
  },
  {
    id: 'park-satisfaction', label: '满意度调查', category: 'park', icon: 'park-satisfaction',
    activation: { kind: 'dialog', dialog: 'park', target: 'satisfaction' },
    availabilityRule: 'park',
  },
  {
    id: 'park-renovation', label: '装修管理', category: 'park', icon: 'park-renovation',
    activation: { kind: 'dialog', dialog: 'park', target: 'renovation' },
    availabilityRule: 'park',
  },
  {
    id: 'park-parking', label: '停车办理', category: 'park', icon: 'park-parking',
    activation: { kind: 'dialog', dialog: 'park', target: 'parking' },
    availabilityRule: 'park',
  },
  {
    id: 'park-network-phone', label: '网络与固话', category: 'park', icon: 'park-network-phone',
    activation: { kind: 'dialog', dialog: 'park', target: 'network-phone' },
    availabilityRule: 'park',
  },
  {
    id: 'park-meeting-room', label: '会议室预约', category: 'park', icon: 'park-meeting-room',
    activation: { kind: 'dialog', dialog: 'park', target: 'meeting-room' },
    availabilityRule: 'park',
  },
  {
    id: 'park-electric-card', label: '电卡服务', category: 'park', icon: 'park-electric-card',
    activation: { kind: 'dialog', dialog: 'park', target: 'electric-card' },
    availabilityRule: 'park',
  },
  {
    id: 'park-repair', label: '物业报修', category: 'park', icon: 'park-repair',
    activation: { kind: 'dialog', dialog: 'park', target: 'repair' },
    availabilityRule: 'park',
  },
  {
    id: 'park-vehicle-visit', label: '车辆与访客', category: 'park', icon: 'park-vehicle-visit',
    activation: { kind: 'dialog', dialog: 'park', target: 'vehicle-visit' },
    availabilityRule: 'park',
  },
  {
    id: 'park-staff-tasks', label: '园区待办', category: 'park', icon: 'park-staff-tasks',
    activation: { kind: 'dialog', dialog: 'park', target: 'staff-tasks' },
    availabilityRule: 'park-staff',
  },
  {
    id: 'park-my-applications', label: '我的申请', category: 'park', icon: 'park-my-applications',
    activation: { kind: 'dialog', dialog: 'park', target: 'my-applications' },
    availabilityRule: 'park',
  },
  {
    id: 'enterprise-memory', label: '企业记忆', category: 'capability', icon: 'enterprise-memory',
    activation: { kind: 'dialog', dialog: 'enterprise-memory' },
    availabilityRule: 'enterprise-memory',
  },
  {
    id: 'auto-skill', label: '自动 Skill', category: 'capability', icon: 'auto-skill',
    activation: { kind: 'dialog', dialog: 'auto-skill' },
    availabilityRule: 'auto-skill',
  },
  {
    id: 'skill-zone', label: 'Skill 专区', category: 'capability', icon: 'skill-zone',
    activation: { kind: 'route', route: 'skill-zone' },
    availabilityRule: 'skill-zone',
  },
  {
    id: 'mind-map', label: '思维导图', category: 'common', icon: 'office-dataviz',
    activation: {
      kind: 'guided-task', taskId: 'mind-map',
      instructions: '你正在思维导图工作区。先确认中心主题、层级和交付格式，再生成可编辑的 Mermaid mindmap 或 Markdown 大纲；保留源文本，不得只交付不可编辑的截图。',
    },
    availabilityRule: 'always',
  },
  ...([
    ['platform-maotouying', '猫头鹰', '控价助手', 'platform-observe'],
    ['platform-trace-code', '穿山甲', '溯源大师', 'platform-trace'],
    ['platform-zhifang', '鸿雁知访', '外勤系统', 'platform-visit'],
    ['platform-zhiliaohou', '知了猴', '电商经营', 'platform-insight'],
    ['platform-zhixin-pigeon', '智信鸽', '全能 AI 客服', 'platform-message'],
  ] as const).map(([id, label, description, icon]) => ({
    id,
    label,
    description,
    category: 'platform' as const,
    icon,
    activation: {
      kind: 'platform' as const,
      platformId: id,
      url: configuredPlatformUrl(id),
      instructions: `你正在${label}平台控制工作区。优先复用用户已授权的安全连接器或本机浏览器登录态；如尚未绑定，引导用户在专用授权界面完成，不得让用户把密码、Cookie 或 Token 发进对话。读操作使用当前身份最小权限；发布、删除、修改或对外发送前必须展示最终动作并取得确认，所有外部写入都必须记录幂等键、结果和审计信息。`,
    },
    availabilityRule: 'always' as const,
  })),
] as const;

/** Approved product endpoints are defaults; a validated local setting may override them. */
export function configuredPlatformUrl(platformId: string): string | null {
  const fallback = DEFAULT_PLATFORM_URLS[platformId as keyof typeof DEFAULT_PLATFORM_URLS] ?? null;
  const value = typeof window !== 'undefined' && window.localStorage
    ? window.localStorage.getItem(`clawmaster.platform.${platformId}.url`)
    : null;
  if (!value) return fallback;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.toString()
      : fallback;
  } catch {
    return fallback;
  }
}

const PROFILE_MODULE_IDS: Readonly<Record<string, string>> = {
  'claw-personal': 'agent-personal-clawmaster',
  'claw-enterprise-work': 'agent-enterprise-work',
  'self-development': 'agent-self-development',
  ppt: 'agent-ppt',
  meeting: 'agent-meeting',
  doc: 'agent-word',
  sheet: 'agent-excel',
  pdf: 'agent-pdf',
  dataviz: 'agent-dataviz',
  research: 'agent-research',
  copy: 'agent-copy',
};

function staticAvailability(
  rule: StaticAvailabilityRule,
  context: ModuleCatalogContext,
): ModuleAvailability {
  if (rule === 'always') return 'available';
  if (rule === 'auto-skill') return 'available';
  if (context.edition !== 'enterprise') return 'hidden';

  if (rule === 'enterprise-memory') {
    return context.organizationFeatures?.knowledge ? 'available' : 'hidden';
  }
  if (rule === 'skill-zone') {
    return context.organizationFeatures?.skill_market ? 'available' : 'hidden';
  }
  if (!context.organizationFeatures?.park_service || !context.parkAuthorization.hasParkContext) {
    return 'hidden';
  }
  if (rule === 'park-statistics' && !context.parkAuthorization.canViewStatistics) {
    return 'hidden';
  }
  if (rule === 'park-staff' && !context.parkAuthorization.canViewStaffTasks) {
    return 'hidden';
  }
  return 'available';
}

const PROFILE_LINE_ICONS: Readonly<Record<string, ModuleIconKey>> = {
  'claw-enterprise-work': 'office-work',
  ppt: 'office-presentation',
  meeting: 'office-meeting',
  doc: 'office-document',
  sheet: 'office-spreadsheet',
  pdf: 'office-pdf',
  dataviz: 'office-dataviz',
  research: 'office-research',
  copy: 'office-copywriting',
};

/**
 * Workspace modules deliberately use one theme-aware line-icon family.
 * Rich generated artwork remains available in galleries and custom-agent
 * pickers, but mixing it into the compact right rail causes inconsistent
 * optical weight and cannot follow system appearance reliably.
 */
function profileModuleIcon(profile: AgentProfile): ModuleIconKey {
  if (profile.id === 'claw-personal') return 'clawmaster-avatar';
  if (profile.id === 'self-development') return 'self-development';
  return PROFILE_LINE_ICONS[profile.id] ?? 'agent';
}

function profileIsAllowed(profile: AgentProfile, edition: ModuleCatalogContext['edition']): boolean {
  if (edition === 'personal') {
    return profile.id === 'claw-personal' || Object.prototype.hasOwnProperty.call(PROFILE_MODULE_IDS, profile.id)
      && profile.id !== 'claw-enterprise-work';
  }
  return profile.id !== 'claw-personal' && Boolean(PROFILE_MODULE_IDS[profile.id]);
}

function agentModules(context: ModuleCatalogContext): ModuleDefinition[] {
  const profiles = context.edition === 'personal'
    ? [...context.profiles, ...COMMON_EXPERT_PROFILES]
    : context.profiles;
  const seenProfiles = new Set<string>();
  return profiles
    .filter((profile) => {
      if (seenProfiles.has(profile.id)) return false;
      seenProfiles.add(profile.id);
      return true;
    })
    .filter((profile) => profileIsAllowed(profile, context.edition))
    .flatMap((profile) => {
      const moduleId = PROFILE_MODULE_IDS[profile.id];
      if (!moduleId) return [];
      return [{
        id: moduleId,
        label: profile.name,
        description: profile.tagline,
        category: 'common' as const,
        icon: profileModuleIcon(profile),
        activation: { kind: 'agent' as const, profileId: profile.id },
        availability: 'available' as const,
      }];
    });
}

function customAgentModules(context: ModuleCatalogContext): ModuleDefinition[] {
  const baseProfileId = context.edition === 'enterprise'
    ? 'claw-enterprise-work'
    : 'claw-personal';
  return context.customAgents.map((agent) => ({
    id: `agent-${agent.id}`,
    label: agent.name,
    description: agent.instructions,
    category: 'custom-agent',
    // Rich custom artwork stays in the editor/gallery. Compact workspace tiles
    // deliberately use the shared theme-aware semantic icon family.
    icon: 'agent',
    activation: {
      kind: 'agent',
      profileId: baseProfileId,
      customAgentId: agent.id,
    },
    availability: 'available',
  }));
}

function customerModules(context: ModuleCatalogContext): ModuleDefinition[] {
  return (context.customerModules ?? []).map((module) => ({
    id: `customer-module:${module.id}`,
    label: module.name,
    description: module.description,
    category: 'customer-module',
    icon: 'customer-module',
    activation: { kind: 'customer-module', moduleId: module.id, version: module.version },
    availability: module.enabled ? 'available' : 'disabled',
    ...(module.suspendedReason ? { disabledReason: module.suspendedReason } : {}),
  }));
}

export function buildModuleCatalog(context: ModuleCatalogContext): ModuleDefinition[] {
  const staticModules = STATIC_MODULE_SPECS.map(({ availabilityRule, ...module }) => ({
    ...module,
    availability: staticAvailability(availabilityRule, context),
  }));
  const result = [...staticModules, ...agentModules(context), ...customAgentModules(context), ...customerModules(context)];
  const seen = new Set<string>();
  return result.filter((module) => {
    if (seen.has(module.id)) return false;
    seen.add(module.id);
    return true;
  });
}

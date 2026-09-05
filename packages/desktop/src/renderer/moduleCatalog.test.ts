import { beforeEach, describe, expect, it } from 'vitest';

import type { EnterpriseOrganizationFeatures } from '../preload/index.js';
import {
  BASE_AGENT_PROFILES,
  COMMON_EXPERT_PROFILES,
  ENTERPRISE_WORK_PROFILE,
  SELF_DEVELOPMENT_PROFILE,
} from './agents/departmentAgents.js';
import {
  buildModuleCatalog,
  configuredPlatformUrl,
  DEFAULT_PLATFORM_URLS,
  STATIC_MODULE_SPECS,
  type ModuleCatalogContext,
} from './moduleCatalog.js';

const enabledFeatures: EnterpriseOrganizationFeatures = {
  enterprise_tree: true,
  park_service: true,
  feishu_auto_reply: true,
  direct_messages: true,
  atoa: true,
  knowledge: true,
  skill_market: true,
};

function enterpriseContext(
  overrides: Partial<ModuleCatalogContext> = {},
): ModuleCatalogContext {
  return {
    edition: 'enterprise',
    profiles: [ENTERPRISE_WORK_PROFILE, SELF_DEVELOPMENT_PROFILE, ...COMMON_EXPERT_PROFILES],
    organizationFeatures: enabledFeatures,
    parkAuthorization: {
      hasParkContext: true,
      canViewStatistics: true,
      canViewStaffTasks: true,
    },
    customAgents: [],
    ...overrides,
  };
}

beforeEach(() => window.localStorage.clear());

describe('static module catalog', () => {
  it('ships the five approved platform endpoints while allowing a local override', () => {
    expect(DEFAULT_PLATFORM_URLS).toEqual({
      'platform-zhifang': 'https://47.116.30.60/',
      'platform-trace-code': 'https://8.140.52.117/',
      'platform-zhiliaohou': 'http://47.116.30.60:18787/',
      'platform-zhixin-pigeon': 'http://47.116.30.60:18788/',
      'platform-maotouying': 'http://8.141.8.31/',
    });
    expect(configuredPlatformUrl('platform-zhifang')).toBe('https://47.116.30.60/');
    window.localStorage.setItem('clawmaster.platform.platform-zhifang.url', 'https://example.com/work/');
    expect(configuredPlatformUrl('platform-zhifang')).toBe('https://example.com/work/');
    window.localStorage.setItem('clawmaster.platform.platform-zhifang.url', 'file:///tmp/unsafe');
    expect(configuredPlatformUrl('platform-zhifang')).toBe('https://47.116.30.60/');
  });

  it('uses the customer-facing platform names and subtitles', () => {
    expect(STATIC_MODULE_SPECS.filter((module) => module.category === 'platform').map((module) => ({
      label: module.label,
      description: module.description,
    }))).toEqual([
      { label: '猫头鹰', description: '控价助手' },
      { label: '穿山甲', description: '溯源大师' },
      { label: '鸿雁知访', description: '外勤系统' },
      { label: '知了猴', description: '电商经营' },
      { label: '智信鸽', description: '全能 AI 客服' },
    ]);
  });

  it('uses unique IDs and complete metadata without organization/contact entries', () => {
    const ids = STATIC_MODULE_SPECS.map((module) => module.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(STATIC_MODULE_SPECS.every((module) => (
      module.label.trim()
      && module.category
      && module.activation.kind
      && module.icon
    ))).toBe(true);
    expect(ids.some((id) => /organization|contact|friend/i.test(id))).toBe(false);
  });

  it('maps each fixed agent from its existing profile instead of duplicating profile data', () => {
    const catalog = buildModuleCatalog(enterpriseContext());
    const ppt = catalog.find((module) => module.id === 'agent-ppt');

    expect(ppt).toMatchObject({
      label: COMMON_EXPERT_PROFILES.find((profile) => profile.id === 'ppt')?.name,
      activation: { kind: 'agent', profileId: 'ppt' },
      availability: 'available',
    });
  });
});

describe('capability-driven availability', () => {
  it('fails closed for enterprise features while preserving supplied agent profiles', () => {
    const catalog = buildModuleCatalog(enterpriseContext({ organizationFeatures: null }));

    expect(catalog.find((module) => module.id === 'enterprise-memory')?.availability).toBe('hidden');
    expect(catalog.find((module) => module.id === 'skill-zone')?.availability).toBe('hidden');
    expect(catalog.find((module) => module.id === 'park-announcement')?.availability).toBe('hidden');
    expect(catalog.find((module) => module.id === 'agent-ppt')?.availability).toBe('available');
  });

  it('never exposes park staff/statistics modules without their existing authorization', () => {
    const catalog = buildModuleCatalog(enterpriseContext({
      parkAuthorization: {
        hasParkContext: true,
        canViewStatistics: false,
        canViewStaffTasks: false,
      },
    }));

    expect(catalog.find((module) => module.id === 'park-overview')?.availability).toBe('hidden');
    expect(catalog.find((module) => module.id === 'park-staff-tasks')?.availability).toBe('hidden');
    expect(catalog.find((module) => module.id === 'park-announcement')?.availability).toBe('available');
  });

  it('unlocks enterprise service entry points for personal users without fabricating data', () => {
    const catalog = buildModuleCatalog({
      edition: 'personal',
      profiles: BASE_AGENT_PROFILES,
      organizationFeatures: enabledFeatures,
      parkAuthorization: {
        hasParkContext: true,
        canViewStatistics: true,
        canViewStaffTasks: true,
      },
      customAgents: [],
    });
    const availableIds = catalog
      .filter((module) => module.availability === 'available')
      .map((module) => module.id);

    expect(availableIds).toContain('agent-personal-clawmaster');
    expect(availableIds).toContain('auto-skill');
    expect(availableIds).toEqual(expect.arrayContaining([
      'agent-word',
      'agent-excel',
      'agent-ppt',
      'agent-pdf',
      'agent-meeting',
      'mind-map',
      'platform-maotouying',
      'platform-trace-code',
      'platform-zhifang',
      'platform-zhiliaohou',
      'platform-zhixin-pigeon',
    ]));
    expect(availableIds).toContain('enterprise-memory');
    expect(availableIds).toContain('skill-zone');
    expect(catalog.filter((module) => module.id.startsWith('park-')).every((module) => (
      module.availability === 'disabled'
    ))).toBe(true);
  });

  it('allows personal office experts without leaking the enterprise foundation Agent', () => {
    const catalog = buildModuleCatalog({
      edition: 'personal',
      profiles: [ENTERPRISE_WORK_PROFILE, ...COMMON_EXPERT_PROFILES],
      organizationFeatures: enabledFeatures,
      parkAuthorization: {
        hasParkContext: true,
        canViewStatistics: true,
        canViewStaffTasks: true,
      },
      customAgents: [],
    });

    expect(catalog.find((module) => module.id === 'agent-ppt')?.availability).toBe('available');
    expect(catalog.find((module) => module.id === 'agent-enterprise-work')?.availability).not.toBe('available');
  });
});

describe('custom expert modules', () => {
  it('creates dynamic agent modules without mutating their stored definitions', () => {
    const customAgent = {
      id: 'custom-bid-helper',
      name: '招投标助手',
      instructions: '整理招投标材料',
      createdAt: '2026-08-26T00:00:00.000Z',
      icon: { kind: 'preset' as const, name: 'agent-customer-success' as const },
    };
    const before = structuredClone(customAgent);
    const catalog = buildModuleCatalog(enterpriseContext({ customAgents: [customAgent] }));

    expect(catalog.find((module) => module.id === 'agent-custom-bid-helper')).toMatchObject({
      label: '招投标助手',
      category: 'custom-agent',
      activation: {
        kind: 'agent',
        profileId: 'claw-enterprise-work',
        customAgentId: 'custom-bid-helper',
      },
      icon: 'agent',
      availability: 'available',
    });
    expect(customAgent).toEqual(before);
  });
});

describe('installed customer modules', () => {
  it('derives catalog entries from the installed registry and fails closed when disabled', () => {
    const catalog = buildModuleCatalog(enterpriseContext({
      customerModules: [{
        id: 'com.acme.report', version: '1.2.0', name: '月报模块',
        description: '生成月报', enabled: false, suspendedReason: '市场已暂停此版本',
      }],
    }));
    expect(catalog.find((module) => module.id === 'customer-module:com.acme.report')).toMatchObject({
      category: 'customer-module', availability: 'disabled',
      disabledReason: '市场已暂停此版本',
      activation: { kind: 'customer-module', moduleId: 'com.acme.report', version: '1.2.0' },
    });
  });

  it('uses the shared semantic icon even when the package contains custom artwork', () => {
    const catalog = buildModuleCatalog(enterpriseContext({
      customerModules: [{
        id: 'com.acme.report', version: '1.2.0', name: '月报模块',
        description: '生成月报', enabled: true,
        iconSrc: 'data:image/png;base64,not-rendered-in-the-right-rail',
      }],
    }));

    expect(catalog.find((module) => module.id === 'customer-module:com.acme.report')?.icon)
      .toBe('customer-module');
  });
});

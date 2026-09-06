import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperatingBriefDialog } from './OperatingBriefDialog.js';

const brief = {
  organizationId: 'org-1', generatedAt: '2026-09-06T08:00:00.000Z', status: 'partial' as const,
  metrics: {
    revenue: { status: 'known' as const, stale: false, amount: { currency: 'CNY', minorUnits: '126800000' }, evidenceRefs: ['e1'], sources: [] },
    margin: { status: 'known' as const, stale: false, amount: { currency: 'CNY', minorUnits: '35400000' }, basisPoints: 2792, evidenceRefs: ['e1'], sources: [] },
    inventory: { status: 'partial' as const, stale: false, value: null, daysCover: null, evidenceRefs: [], sources: [] },
    cash: { status: 'known' as const, stale: false, balance: { currency: 'CNY', minorUnits: '82000000' }, netWorkingCapital: null, runwayDays: 96, overdueReceivablesBps: null, evidenceRefs: ['e2'], sources: [] },
    growth: { status: 'unknown' as const, stale: false, revenueGrowthBps: null, contributionGrowthBps: null, attribution: 'unknown' as const, attributionAssumptions: [], evidenceRefs: [], sources: [] },
  },
  missing: ['inventory', 'growth'], risks: ['库存事实不完整'], opportunities: [],
  evidenceRefs: ['e1', 'e2'], invalidEvidenceRefs: [],
  recommendedActions: [], executedActions: [], decisionsRequired: [],
};

afterEach(() => vi.restoreAllMocks());

describe('OperatingBriefDialog', () => {
  it('loads only while open and renders unknown values without zero substitution', async () => {
    const load = vi.fn(async () => brief);
    Object.assign(window, { clawmaster: { enterpriseCompanyOsBrief: load } });
    const view = render(<OperatingBriefDialog open organizationName="示例品牌" onClose={vi.fn()} />);
    expect(await screen.findByText('示例品牌')).toBeTruthy();
    await waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(screen.getByText('¥1,268,000.00')).toBeTruthy();
    expect(screen.getAllByText('未知').length).toBeGreaterThan(0);
    view.rerender(<OperatingBriefDialog open={false} organizationName="示例品牌" onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog', { name: '经营简报' })).toBeNull();
  });

  it('shows a retryable error without fabricating metrics', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('服务暂不可用')).mockResolvedValueOnce(brief);
    Object.assign(window, { clawmaster: { enterpriseCompanyOsBrief: load } });
    render(<OperatingBriefDialog open organizationName="示例品牌" onClose={vi.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toContain('服务暂不可用');
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByText('¥1,268,000.00')).toBeTruthy();
  });
});

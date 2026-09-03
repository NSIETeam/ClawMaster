import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SelfModificationReviewPanel } from './SelfModificationReviewPanel.js';

const request = {
  id: 'change-1', goal: '优化长期任务恢复', state: 'review_required' as const,
  risk: 'security-review' as const, baselineCommit: 'a'.repeat(40), candidateCommit: 'b'.repeat(40),
  changedPaths: ['packages/desktop/src/main/update-service.ts'],
  checks: [{ name: 'doctor', status: 'passed' as const }, { name: 'typecheck', status: 'passed' as const }],
  permissionChanges: { added: ['filesystem:versions'], removed: [] },
  codeMapNodes: ['Desktop', 'AtomicUpdater', 'ResidentTasks'],
  estimatedCost: { currency: 'USD', amount: 0, modelCalls: 0 },
  resourceDelta: { memoryBytes: 4096, cpuPercent: 0.1 },
};

describe('SelfModificationReviewPanel', () => {
  it('shows evidence and requires the security-review approval path', () => {
    const onApprove = vi.fn();
    render(<SelfModificationReviewPanel request={request} reviewerKind="human" onApprove={onApprove} onReject={vi.fn()}/>);
    expect(screen.getByText('优化长期任务恢复')).toBeTruthy();
    expect(screen.getByText(/filesystem:versions/u)).toBeTruthy();
    expect(screen.getByText('AtomicUpdater')).toBeTruthy();
    expect(screen.getByText('0 USD')).toBeTruthy();
    expect((screen.getByRole('button', { name: '批准候选' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('需要安全审核员批准')).toBeTruthy();
  });

  it('allows a security reviewer to approve and any reviewer to reject', () => {
    const onApprove = vi.fn(); const onReject = vi.fn();
    render(<SelfModificationReviewPanel request={request} reviewerKind="security-reviewer" onApprove={onApprove} onReject={onReject}/>);
    fireEvent.click(screen.getByRole('button', { name: '批准候选' }));
    fireEvent.click(screen.getByRole('button', { name: '拒绝候选' }));
    expect(onApprove).toHaveBeenCalledWith('change-1');
    expect(onReject).toHaveBeenCalledWith('change-1');
  });
});

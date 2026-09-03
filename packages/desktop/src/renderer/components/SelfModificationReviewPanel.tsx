import React from 'react';

export interface SelfModificationReviewModel {
  id: string;
  goal: string;
  state: 'draft' | 'editing' | 'verifying' | 'verification_failed' | 'review_required'
    | 'approved' | 'building' | 'build_failed' | 'candidate_running' | 'candidate_failed'
    | 'draining' | 'activating' | 'observing' | 'active' | 'activation_failed'
    | 'rolled_back' | 'rejected' | 'cancelled';
  risk: 'policy-auto' | 'human-confirmation' | 'security-review';
  baselineCommit?: string;
  candidateCommit?: string;
  changedPaths: string[];
  checks: Array<{ name: string; status: 'passed' | 'failed' | 'skipped'; detail?: string }>;
  permissionChanges: { added: string[]; removed: string[] };
  codeMapNodes: string[];
  estimatedCost: { currency: string; amount: number; modelCalls: number };
  resourceDelta: { memoryBytes: number; cpuPercent: number };
  failure?: string;
}

function shortCommit(value: string | undefined): string {
  return value?.slice(0, 8) || '尚未生成';
}

function formatBytes(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value / 1024).toFixed(1)} KiB`;
}

export function SelfModificationReviewPanel({ request, reviewerKind, onApprove, onReject }: {
  request: SelfModificationReviewModel;
  reviewerKind: 'policy' | 'human' | 'security-reviewer';
  onApprove(id: string): void;
  onReject(id: string): void;
}): React.JSX.Element {
  const awaitingReview = request.state === 'review_required';
  const securityBlocked = request.risk === 'security-review' && reviewerKind !== 'security-reviewer';
  const humanBlocked = request.risk === 'human-confirmation' && reviewerKind === 'policy';
  const approvalBlocked = !awaitingReview || securityBlocked || humanBlocked;
  return <section className="otto-self-modification-review" aria-label="自修改候选审查">
    <header>
      <div><small>自修改候选 · {request.state}</small><h2>{request.goal}</h2></div>
      <span data-risk={request.risk}>{request.risk}</span>
    </header>
    <dl className="otto-self-modification-review__summary">
      <div><dt>基线</dt><dd>{shortCommit(request.baselineCommit)}</dd></div>
      <div><dt>候选</dt><dd>{shortCommit(request.candidateCommit)}</dd></div>
      <div><dt>预计费用</dt><dd>{request.estimatedCost.amount} {request.estimatedCost.currency}</dd></div>
      <div><dt>模型调用</dt><dd>{request.estimatedCost.modelCalls}</dd></div>
      <div><dt>内存变化</dt><dd>{formatBytes(request.resourceDelta.memoryBytes)}</dd></div>
      <div><dt>CPU 变化</dt><dd>{request.resourceDelta.cpuPercent > 0 ? '+' : ''}{request.resourceDelta.cpuPercent.toFixed(1)}%</dd></div>
    </dl>
    <section><h3>代码差异</h3><ul>{request.changedPaths.map((entry) => <li key={entry}><code>{entry}</code></li>)}</ul></section>
    <section><h3>受影响代码图谱</h3><div className="otto-self-modification-review__map">{request.codeMapNodes.map((entry) => <span key={entry}>{entry}</span>)}</div></section>
    <section><h3>权限差异</h3>
      {request.permissionChanges.added.length ? <ul>{request.permissionChanges.added.map((entry) => <li key={`added:${entry}`}>新增：{entry}</li>)}</ul> : <p>没有新增权限</p>}
      {request.permissionChanges.removed.length ? <ul>{request.permissionChanges.removed.map((entry) => <li key={`removed:${entry}`}>移除：{entry}</li>)}</ul> : null}
    </section>
    <section><h3>验证门禁</h3><ul>{request.checks.map((check) => <li key={check.name} data-status={check.status}><strong>{check.name}</strong><span>{check.status}</span>{check.detail ? <small>{check.detail}</small> : null}</li>)}</ul></section>
    {request.failure ? <p role="alert">{request.failure}</p> : null}
    {securityBlocked ? <p role="status">需要安全审核员批准</p> : null}
    {humanBlocked ? <p role="status">需要用户明确批准</p> : null}
    <footer>
      <button type="button" disabled={approvalBlocked} onClick={() => onApprove(request.id)}>批准候选</button>
      <button type="button" disabled={!awaitingReview} onClick={() => onReject(request.id)}>拒绝候选</button>
    </footer>
  </section>;
}

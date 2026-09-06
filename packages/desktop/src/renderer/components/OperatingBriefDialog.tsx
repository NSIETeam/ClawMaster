import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OperatingBrief } from '../../preload/index.js';
import { useModalDialog } from './useModalDialog.js';

type Money = { currency: string; minorUnits: string } | null;

function formatMoney(value: Money): string {
  if (!value) return '未知';
  const negative = value.minorUnits.startsWith('-');
  const digits = (negative ? value.minorUnits.slice(1) : value.minorUnits).padStart(3, '0');
  const major = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  const minor = digits.slice(-2);
  const symbol = value.currency === 'CNY' ? '¥' : `${value.currency} `;
  return `${negative ? '-' : ''}${symbol}${major}.${minor}`;
}

function formatBps(value: number | null): string {
  return value === null ? '未知' : `${(value / 100).toFixed(1)}%`;
}

function statusLabel(status: 'known' | 'partial' | 'unknown', stale: boolean): string {
  if (stale) return '已过期';
  if (status === 'known') return '已核验';
  if (status === 'partial') return '数据不全';
  return '未知';
}

export function OperatingBriefDialog({
  open,
  organizationName,
  onClose,
}: {
  open: boolean;
  organizationName: string;
  onClose(): void;
}): React.JSX.Element | null {
  const [brief, setBrief] = useState<OperatingBrief | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const modal = useModalDialog(open, onClose, true);

  const refresh = useCallback(() => {
    setLoading(true);
    setError('');
    void window.clawmaster.enterpriseCompanyOsBrief()
      .then(setBrief)
      .catch((cause: unknown) => {
        setBrief(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (open) refresh();
    else {
      setBrief(null);
      setError('');
    }
  }, [open, refresh]);

  if (!open) return null;
  const metricCards = brief ? [
    {
      label: '收入', value: formatMoney(brief.metrics.revenue.amount),
      detail: `${brief.metrics.revenue.evidenceRefs.length} 条证据`,
      metric: brief.metrics.revenue,
    },
    {
      label: '贡献利润', value: formatMoney(brief.metrics.margin.amount),
      detail: `利润率 ${formatBps(brief.metrics.margin.basisPoints)}`,
      metric: brief.metrics.margin,
    },
    {
      label: '库存', value: formatMoney(brief.metrics.inventory.value),
      detail: `覆盖 ${brief.metrics.inventory.daysCover ?? '未知'} 天`,
      metric: brief.metrics.inventory,
    },
    {
      label: '现金', value: formatMoney(brief.metrics.cash.balance),
      detail: `Runway ${brief.metrics.cash.runwayDays ?? '未知'} 天`,
      metric: brief.metrics.cash,
    },
    {
      label: '增长', value: formatBps(brief.metrics.growth.revenueGrowthBps),
      detail: `贡献增长 ${formatBps(brief.metrics.growth.contributionGrowthBps)}`,
      metric: brief.metrics.growth,
    },
  ] : [];

  return createPortal(
    <div className="claw-operating-brief" onMouseDown={modal.onBackdropMouseDown}>
      <section
        ref={modal.dialogRef}
        className="claw-operating-brief__sheet"
        role="dialog"
        aria-modal="true"
        aria-label="经营简报"
        onKeyDown={modal.onKeyDown}
      >
        <header className="claw-operating-brief__header">
          <div>
            <span>COMPANY OS / LIVE BRIEF</span>
            <h2>{organizationName}</h2>
            <p>每个数字都必须能追溯到来源；未知不会显示为零。</p>
          </div>
          <div className="claw-operating-brief__header-actions">
            <button type="button" disabled={loading} onClick={refresh}>刷新</button>
            <button ref={modal.closeRef} type="button" aria-label="关闭经营简报" onClick={onClose}>×</button>
          </div>
        </header>

        {loading && !brief ? <p className="claw-operating-brief__state" role="status">正在读取经营事实…</p> : null}
        {error ? <div className="claw-operating-brief__error" role="alert"><strong>经营数据暂不可用</strong><span>{error}</span></div> : null}
        {brief ? <>
          <div className="claw-operating-brief__meta">
            <span className={`is-${brief.status}`}>{statusLabel(brief.status, false)}</span>
            <time dateTime={brief.generatedAt}>{new Date(brief.generatedAt).toLocaleString('zh-CN')}</time>
            <span>{brief.evidenceRefs.length} 条有效证据</span>
          </div>
          <div className="claw-operating-brief__metrics">
            {metricCards.map((card, index) => <article key={card.label} style={{ '--brief-index': index } as React.CSSProperties}>
              <header><span>{card.label}</span><small className={`is-${card.metric.status}`}>{statusLabel(card.metric.status, card.metric.stale)}</small></header>
              <strong>{card.value}</strong>
              <p>{card.detail}</p>
            </article>)}
          </div>
          <div className="claw-operating-brief__lower">
            <section><h3>需要关注</h3>{brief.risks.length ? <ul>{brief.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul> : <p>当前证据中没有触发风险规则。</p>}</section>
            <section><h3>决策队列</h3><strong>{brief.decisionsRequired.length}</strong><p>需要人工决定的动作</p><small>建议 {brief.recommendedActions.length} · 已执行 {brief.executedActions.length}</small></section>
          </div>
          {brief.invalidEvidenceRefs.length ? <p className="claw-operating-brief__invalid">{brief.invalidEvidenceRefs.length} 条事实因契约无效未参与计算。</p> : null}
        </> : null}
      </section>
    </div>,
    document.body,
  );
}

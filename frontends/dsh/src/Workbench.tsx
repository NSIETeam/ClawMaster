import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import clawmasterIcon from './clawmaster.png';
import { BusinessModules } from './BusinessModules';

export interface WorkbenchSession {
  id: string;
  title: string;
  updatedAt?: number;
  running?: boolean;
}

export interface WorkbenchProps {
  sessions: readonly WorkbenchSession[];
  sessionsLoading?: boolean;
  connectionLabel: string;
  connected: boolean;
  watchdogReady?: boolean;
  onNewSession: () => void;
  onOpenSession: (id: string) => void;
  onOpenModels?: () => void;
  onOpenPlugins?: () => void;
  onRefresh: () => Promise<void>;
}

export const BRAND_SLOGAN = '开启AI时代的企业协作';

interface MarkProps {
  size?: number;
  className?: string;
  imageRef?: RefObject<HTMLImageElement>;
}

export function BrandName() {
  return <span className="cm-dsh-brand-name">ClawMaster</span>;
}

export function BrandMark({ size = 30, className, imageRef }: MarkProps) {
  return (
    <img
      ref={imageRef}
      className={['cm-dsh-brand-mark', className].filter(Boolean).join(' ')}
      src={clawmasterIcon}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

export function HeroMark({ size = 68, className }: MarkProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const root = imageRef.current?.closest('[data-phase="hero"]');
    if (!root) return;
    const applySlogan = () => {
      for (const span of root.querySelectorAll('span')) {
        const text = span.textContent?.trim();
        if (text === '探索未至之境' || text === 'Into the Unknown') {
          span.textContent = BRAND_SLOGAN;
          return;
        }
      }
    };
    applySlogan();
    const observer = new MutationObserver(applySlogan);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);
  return <BrandMark imageRef={imageRef} size={size} className={['cm-dsh-hero-mark', className].filter(Boolean).join(' ')} />;
}

type IconName = 'plus' | 'arrow' | 'search' | 'refresh' | 'model' | 'plugins' | 'task' | 'close';

function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 6.2A8 8 0 0 1 19.5 10M4.5 14a8 8 0 0 0 13.4 3.8" /></>,
    model: <><rect x="6" y="6" width="12" height="12" rx="3" /><path d="M10 2v4m4-4v4m-4 12v4m4-4v4M2 10h4m-4 4h4m12-4h4m-4 4h4" /><rect x="10" y="10" width="4" height="4" rx="1" /></>,
    plugins: <><path d="M14 3H9v6H3v6h6v6h6v-6h6V9h-7V3Z" /><path d="M9 9h5" /></>,
    task: <><rect x="5" y="3" width="14" height="18" rx="3" /><path d="M9 8h6m-6 4h6m-6 4h3" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function WorkbenchIcon({ size = 18, active = false }: { size?: number; active?: boolean }) {
  return (
    <svg className="cm-dsh-workbench-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={active ? { color: 'var(--dsw-alias-brand-primary, #3264d8)' } : undefined}>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </svg>
  );
}

function updatedLabel(timestamp: number | undefined): string | undefined {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  if (sameDay) {
    return `今天 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)}`;
  }
  return new Intl.DateTimeFormat('zh-CN', {
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' as const }),
    month: 'long',
    day: 'numeric',
  }).format(date);
}

export function Workbench({
  sessions,
  sessionsLoading = false,
  connectionLabel,
  connected,
  watchdogReady = true,
  onNewSession,
  onOpenSession,
  onOpenModels,
  onOpenPlugins,
  onRefresh,
}: WorkbenchProps) {
  const [query, setQuery] = useState('');
  const [runningOnly, setRunningOnly] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const refreshPending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const runningCount = sessions.filter((session) => session.running).length;
  const matchingSessions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN');
    return sessions.filter((session) => (!runningOnly || session.running)
      && (session.title || '未命名任务').toLocaleLowerCase('zh-CN').includes(needle));
  }, [sessions, query, runningOnly]);

  const refresh = async () => {
    if (refreshPending.current) return;
    refreshPending.current = true;
    setRefreshing(true);
    setRefreshError(false);
    try {
      await onRefresh();
    } catch {
      if (mounted.current) setRefreshError(true);
    } finally {
      refreshPending.current = false;
      if (mounted.current) setRefreshing(false);
    }
  };

  const hasFilter = query.trim().length > 0 || runningOnly;

  return (
    <main className="cm-dsh-workbench" aria-label="ClawMaster WatchDog">
      <div className="cm-dsh-workbench-inner">
        <div className="cm-dsh-topline">
          <span className="cm-dsh-eyebrow"><WorkbenchIcon size={15} /> WatchDog 运行中</span>
          <span className={`cm-dsh-connection${connected ? ' is-connected' : ''}`} role="status">
            <span className="cm-dsh-status-dot" />
            {connectionLabel}
          </span>
        </div>

        <header className="cm-dsh-welcome">
          <div className="cm-dsh-welcome-copy">
            <p className="cm-dsh-greeting">欢迎回来</p>
            <h1>{BRAND_SLOGAN}</h1>
            <p className="cm-dsh-intro">持续观察企业信号，发现异常后推进处理。无需预设工作空间，系统会按任务上下文调配执行环境。</p>
          </div>
          <button className="cm-dsh-button cm-dsh-button-primary cm-dsh-start" type="button" disabled={!watchdogReady} onClick={onNewSession}>
            <Icon name="plus" size={18} /> {watchdogReady ? '启动 WatchDog' : '正在准备 WatchDog'}
          </button>
        </header>

        <div className="cm-dsh-content-grid">
          <section className="cm-dsh-tasks" aria-labelledby="cm-dsh-tasks-heading" aria-busy={sessionsLoading || refreshing}>
            <div className="cm-dsh-section-heading">
              <div className="cm-dsh-section-title">
                <h2 id="cm-dsh-tasks-heading">WatchDog 任务</h2>
                {!sessionsLoading && <span className="cm-dsh-count">{sessions.length}</span>}
              </div>
              <button className="cm-dsh-refresh" type="button" disabled={refreshing} aria-busy={refreshing} onClick={() => { void refresh(); }}>
                <Icon name="refresh" size={15} className={refreshing ? 'cm-dsh-spin' : undefined} />
                {refreshing ? '正在刷新' : '刷新'}
              </button>
            </div>

            <div className="cm-dsh-task-card">
              <div className="cm-dsh-task-toolbar">
                <div className="cm-dsh-filters" role="group" aria-label="筛选任务状态">
                  <button className={`cm-dsh-filter${!runningOnly ? ' is-selected' : ''}`} type="button" aria-pressed={!runningOnly} onClick={() => setRunningOnly(false)}>全部</button>
                  <button className={`cm-dsh-filter${runningOnly ? ' is-selected' : ''}`} type="button" aria-pressed={runningOnly} onClick={() => setRunningOnly(true)}>
                    进行中 {!sessionsLoading && <span>{runningCount}</span>}
                  </button>
                </div>
                <div className="cm-dsh-search">
                  <Icon name="search" size={16} />
                  <input aria-label="搜索近期任务" placeholder="搜索任务" value={query} onChange={(event) => setQuery(event.target.value)} type="search" />
                  {query && <button type="button" className="cm-dsh-clear" aria-label="清空搜索" onClick={() => setQuery('')}><Icon name="close" size={13} /></button>}
                </div>
              </div>

              {refreshError && <p className="cm-dsh-refresh-error" role="alert">暂时没能更新任务列表，请稍后重试。</p>}

              {sessionsLoading ? (
                <div className="cm-dsh-empty cm-dsh-loading" role="status">
                  <span className="cm-dsh-empty-icon"><Icon name="refresh" size={25} className="cm-dsh-spin" /></span>
                  <p>正在读取会话…</p>
                </div>
              ) : matchingSessions.length > 0 ? (
                <ul className="cm-dsh-session-list" aria-label="近期任务列表">
                  {matchingSessions.map((session) => {
                    const updated = updatedLabel(session.updatedAt);
                    return (
                      <li key={session.id}>
                        <button type="button" className="cm-dsh-session" onClick={() => onOpenSession(session.id)}>
                          <span className={`cm-dsh-session-icon${session.running ? ' is-running' : ''}`}><Icon name="task" size={19} /></span>
                          <span className="cm-dsh-session-copy">
                            <span className="cm-dsh-session-title">{session.title || '未命名任务'}</span>
                            <span className="cm-dsh-session-meta">
                              {session.running ? <span className="cm-dsh-running-label"><span /> 进行中</span> : <span>点击继续</span>}
                              {updated && <><span aria-hidden="true">·</span><span>{updated}</span></>}
                            </span>
                          </span>
                          <Icon name="arrow" size={17} className="cm-dsh-session-arrow" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="cm-dsh-empty">
                  <span className="cm-dsh-empty-icon"><Icon name={hasFilter ? 'search' : 'task'} size={26} /></span>
                  <h3>{hasFilter ? '没有找到匹配的任务' : '创建第一个 WatchDog'}</h3>
                  <p>{hasFilter ? '换个关键词，或查看全部任务。' : '描述要持续关注的目标、信号和异常条件，系统会自动绑定托管空间并调配任务上下文。'}</p>
                  {hasFilter ? (
                    <button type="button" className="cm-dsh-button cm-dsh-button-secondary" onClick={() => { setQuery(''); setRunningOnly(false); }}>查看全部任务</button>
                  ) : (
                    <button type="button" className="cm-dsh-button cm-dsh-button-secondary" disabled={!watchdogReady} onClick={onNewSession}><Icon name="plus" size={16} /> {watchdogReady ? '启动 WatchDog' : '正在准备 WatchDog'}</button>
                  )}
                </div>
              )}
            </div>
            <p className="cm-dsh-list-note" aria-live="polite">
              {sessionsLoading ? '稍等一下，你的任务正在路上。' : hasFilter ? `显示 ${matchingSessions.length} 个匹配任务` : '每一次开始，都可以从这里继续。'}
            </p>
          </section>

          <aside className="cm-dsh-sidebar" aria-label="工作台快捷入口">
            <div className="cm-dsh-section-heading"><h2>快速开始</h2></div>
            <div className="cm-dsh-setup-card">
              {onOpenModels && <button type="button" className="cm-dsh-shortcut" onClick={onOpenModels}>
                <span className="cm-dsh-shortcut-icon"><Icon name="model" size={20} /></span>
                <span className="cm-dsh-shortcut-copy"><strong>模型设置</strong><span>选择适合你的 AI 模型</span></span>
                <Icon name="arrow" size={16} className="cm-dsh-shortcut-arrow" />
              </button>}
              {onOpenPlugins && <button type="button" className="cm-dsh-shortcut" onClick={onOpenPlugins}>
                <span className="cm-dsh-shortcut-icon cm-dsh-shortcut-plugins"><Icon name="plugins" size={20} /></span>
                <span className="cm-dsh-shortcut-copy"><strong>插件设置</strong><span>查看工具与扩展配置</span></span>
                <Icon name="arrow" size={16} className="cm-dsh-shortcut-arrow" />
              </button>}
              {(!onOpenModels || !onOpenPlugins) && <div className="cm-dsh-settings-guide">
                <span className="cm-dsh-shortcut-icon"><Icon name="model" size={20} /></span>
                <h3>让工作准备得更充分</h3>
                <p>在左下角设置中配置模型、管理插件。</p>
                <ol>
                  <li><span>1</span>打开左下角「设置」</li>
                  <li><span>2</span>在「模型」中完成模型配置</li>
                  <li><span>3</span>在「插件」中查看工具与扩展</li>
                </ol>
              </div>}
            </div>

            <div className="cm-dsh-note-card">
              <span className="cm-dsh-note-line" aria-hidden="true" />
              <p className="cm-dsh-note-label">默认工作方式</p>
              <h3>无需指定工作空间</h3>
              <p>先接收监控目标，再按任务调配上下文；目标续跑、定时巡检与高风险审批都沿用 DSH 的成熟能力。</p>
              <span className="cm-dsh-note-signature"><BrandMark size={22} /> ClawMaster WatchDog</span>
            </div>
          </aside>
        </div>
        <BusinessModules />
      </div>
    </main>
  );
}

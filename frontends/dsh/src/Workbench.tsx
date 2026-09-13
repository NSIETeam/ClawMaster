/** WatchDog task launcher and projection of the DSH Session list. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import clawmasterIcon from './clawmaster.png';
import { productCopy, type ProductLocale, type ProductModule } from './locales/frontend.ts';
import type { SessionId } from './services.ts';
import { ProductNavigationError, type WatchdogCadence } from './navigation.ts';

export interface WorkbenchSession { id: SessionId; title: string; updatedAt: number; running: boolean; }
export interface WorkbenchProps {
  locale: ProductLocale;
  sessions: readonly WorkbenchSession[];
  sessionsLoading: boolean;
  connectionLabel: string;
  connected: boolean;
  onStart: (goal: string, cadence: WatchdogCadence) => Promise<void>;
  onModule: (module: ProductModule) => Promise<void>;
  onOpenSession: (id: SessionId) => void;
  onRefresh: () => Promise<void>;
}

export const BRAND_SLOGAN = productCopy('zh-CN').slogan;

interface MarkProps {
  size?: number;
  className?: string;
  imageRef?: RefObject<HTMLImageElement>;
}

export function BrandName() {
  return <span className="cm-dsh-brand-name">{productCopy('zh-CN').brand}</span>;
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

export function WorkbenchIcon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M3 10h18M10 10v11" /></svg>;
}

/** Explicit task creation and tool opening; no model request runs on render. */
export function Workbench({ locale, sessions, sessionsLoading, connectionLabel, connected, onStart, onModule, onOpenSession, onRefresh }: WorkbenchProps) {
  const copy = productCopy(locale);
  const [goal, setGoal] = useState('');
  const [cadence, setCadence] = useState<WatchdogCadence>('once');
  const [query, setQuery] = useState('');
  const [runningOnly, setRunningOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'actionError' | 'refreshError' | 'toolDisabled' | undefined>();
  const pending = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const act = async (operation: () => Promise<void>, fallback: 'actionError' | 'refreshError' = 'actionError') => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError(undefined);
    try { await operation(); }
    catch (reason) { if (active.current) setError(reason instanceof ProductNavigationError ? reason.code : fallback); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  };
  const matching = useMemo(() => sessions.filter(row => (!runningOnly || row.running)
    && row.title.toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale))), [sessions, runningOnly, query, locale]);
  const modules: readonly ProductModule[] = ['editor', 'browser', 'terminal'];
  return <main className="cm-dsh-workbench" aria-label={copy.watchdog}>
    <header className="cm-workbench-toolbar">
      <h1><WorkbenchIcon /> {copy.watchdog}</h1>
      <span className={`cm-connection${connected ? ' is-connected' : ''}`} role="status">{connectionLabel}</span>
      <button type="button" disabled={busy || !connected} onClick={() => { void act(() => onStart('', 'once')); }}>{copy.newTask}</button>
    </header>
    <div className="cm-workbench-content">
      <section className="cm-task-launcher" aria-labelledby="cm-goal-heading">
        <p className="cm-slogan">{copy.slogan}</p>
        <h2 id="cm-goal-heading">{copy.goal}</h2>
        <form onSubmit={event => { event.preventDefault(); if (goal.trim()) void act(() => onStart(goal, cadence)); }}>
          <textarea aria-label={copy.goal} placeholder={copy.goalHint} value={goal} onChange={event => setGoal(event.target.value)} required rows={3} />
          <div className="cm-launcher-actions">
            <label>{copy.cadence}<select aria-label={copy.cadence} value={cadence} onChange={event => setCadence(event.target.value as WatchdogCadence)}>
              <option value="once">{copy.once}</option><option value="hourly">{copy.hourly}</option><option value="daily">{copy.daily}</option>
            </select></label>
            <button className="cm-primary" type="submit" disabled={busy || !connected || !goal.trim()}>{busy ? copy.preparing : copy.start}</button>
          </div>
        </form>
        <p className="cm-help">{cadence === 'once' ? copy.allocationHint : copy.scheduleHint}</p>
      </section>
      {error && <p className="cm-error" role="alert">{copy[error]}</p>}
      <nav className="cm-module-launchers" aria-label={copy.modules}>
        {modules.map(module => <button key={module} type="button" disabled={busy || !connected} onClick={() => { void act(() => onModule(module)); }}>
          <WorkbenchIcon size={17} /><strong>{copy[module]}</strong><small>{copy[`${module}Hint`]}</small>
        </button>)}
      </nav>
      <section className="cm-task-list" aria-label={copy.tasks} aria-busy={sessionsLoading}>
        <div className="cm-list-toolbar"><h2>{copy.tasks} <span>{sessions.length}</span></h2>
          <div className="cm-task-filters"><button type="button" aria-pressed={!runningOnly} onClick={() => setRunningOnly(false)}>{copy.all}</button>
            <button type="button" aria-pressed={runningOnly} onClick={() => setRunningOnly(true)}>{copy.running} {sessions.filter(row => row.running).length}</button></div>
          <input type="search" aria-label={copy.search} placeholder={copy.search} value={query} onChange={event => setQuery(event.target.value)} />
          <button type="button" disabled={busy} onClick={() => { void act(onRefresh, 'refreshError'); }}>{copy.refresh}</button>
        </div>
        {sessionsLoading ? <p className="cm-empty" role="status">{copy.loading}</p> : matching.length === 0 ? <div className="cm-empty"><p>{query || runningOnly ? copy.noMatches : copy.noTasks}</p><small>{copy.noTasksHint}</small></div> :
          <ul>{matching.map(row => <li key={row.id}><button type="button" onClick={() => onOpenSession(row.id)}>
            <span className="cm-task-title">{row.title}</span><span className={row.running ? 'cm-running' : 'cm-idle'}>{row.running ? copy.running : copy.idle}</span>
            <time dateTime={new Date(row.updatedAt).toISOString()}>{new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(row.updatedAt)}</time>
          </button></li>)}</ul>}
      </section>
    </div>
  </main>;
}

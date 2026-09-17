/** Explicit human controls for persisted checks; rendering never approves or dispatches work. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ProductLocale } from './locales/frontend.ts';
import type { WorkbenchSession } from './Workbench.tsx';
import type { SessionId } from './services.ts';
import { scheduleCopy, scheduleHistoryAction } from './locales/schedules.ts';
import type { ScheduleInstanceView, WatchdogScheduleClient } from './watchdog-schedule-client.ts';

interface Props { client: WatchdogScheduleClient; locale: ProductLocale; sessions: readonly WorkbenchSession[]; onOpenSession(id: SessionId): void; }
function date(value: number, locale: ProductLocale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
}

/** Read persisted plans and heartbeat observations; mutations require an explicit user action. */
export function ScheduleBoard({ client, locale, sessions, onOpenSession }: Props) {
  const copy = scheduleCopy(locale);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const [creating, setCreating] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => { void client.refresh(); }, [client]);
  const disabled = state.saving || state.pending;
  const selected = state.selected;
  const workerUnavailable = state.plans.some(plan => plan.active) && state.workerSummary !== null && state.workerSummary.online === 0;
  return <section className="cm-task-board cm-schedule-board" aria-label={copy.heading} aria-busy={state.loading}>
    <div className="cm-task-board-heading"><h2>{copy.heading}</h2><div>
      <button type="button" disabled={disabled} onClick={() => setCreating(value => !value)}>{creating ? copy.close : copy.create}</button>
      <button type="button" disabled={state.loading || state.saving} onClick={() => { void client.refresh(); }}>{copy.refresh}</button>
    </div></div>
    <p>{state.mode ? copy[state.mode] : copy.unavailableMode}</p><p className="cm-help">{copy.hint}</p>
    {state.observedAt !== null && <p className="cm-help">{copy.observedAt}: {date(state.observedAt, locale)}</p>}
    {workerUnavailable && <p role="alert" className="cm-error">{copy.activePlanWorkerUnavailable}</p>}
    {state.workerSummary && <p>{copy.workerCount}: {state.workerSummary.total} · {copy.online}: {state.workerSummary.online} · {copy.offline}: {state.workerSummary.offline} · {copy.degraded}: {state.workerSummary.degraded} · {copy.stopped}: {state.workerSummary.stopped}</p>}
    <details><summary>{copy.workerDetails}</summary><div aria-live="polite">{!state.workers.length ? <p>{copy.noWorkers}</p> : state.workers.map(item => <p key={item.id}>
      <code>{item.id}</code> ·
      {copy[item.status]} · {copy.heartbeat}: <time dateTime={new Date(item.lastHeartbeat).toISOString()}>{date(item.lastHeartbeat, locale)}</time>
    </p>)}</div>
      <button type="button" disabled={state.loading || state.saving} onClick={() => { void client.workers(); }}>{copy.refreshWorkers}</button>
      {state.workerSummary?.nextAfter != null && <button type="button" disabled={state.loading || state.saving} onClick={() => { void client.workers(state.workerSummary!.nextAfter!); }}>{copy.nextWorkers}</button>}
    </details>
    {state.error && <p role="alert" className="cm-error">{copy[state.error]}</p>}
    {state.saving && <p role="status">{copy.saving}</p>}
    {state.pending && !state.saving && <div role="alert"><p>{copy.pending}</p><button type="button" onClick={() => { void client.retry().then(saved => { if (saved) setCreating(false); }); }}>{copy.retry}</button></div>}
    {state.saved && <p role="status">{copy.saved}</p>}
    {creating && <PlanForm locale={locale} sessions={sessions} disabled={disabled} onSave={async command => { if (await client.command(command)) setCreating(false); }} />}
    {state.loading && <p role="status">{copy.loading}</p>}
    {!state.loading && !state.plans.length && <p>{copy.empty}</p>}
    <div className="cm-business-tasks">{state.plans.map(plan => <article className="cm-business-task" key={plan.id}>
      <button type="button" disabled={state.loading || state.saving} aria-pressed={selected?.id === plan.id}
        onClick={() => { setReason(''); void client.select(plan); }}>{plan.prompt}</button>
      <p>{plan.active ? copy.active : copy.inactive} · {copy.missedCount}: {plan.missedCount}</p>
      <p>{copy.nextAt}: {!plan.active || plan.nextAt === null ? copy.noNext : date(plan.nextAt, locale)}</p>
    </article>)}</div>
    {state.nextPlan !== null && <button type="button" disabled={state.loading || state.saving} onClick={() => { void client.refresh(state.nextPlan!); }}>{copy.nextPlan}</button>}
    {selected && <section className="cm-task-detail" aria-label={copy.occurrences}>
      <h3>{selected.prompt}</h3><code>{selected.id}</code>
      <div className="cm-task-decisions"><button type="button" onClick={() => onOpenSession(selected.sessionId as SessionId)}>{copy.openSession}</button>
        <button type="button" disabled={state.loading || state.saving} onClick={() => { void client.select(selected); }}>{copy.refreshInstances}</button></div>
      {selected.active && <form className="cm-business-form" onSubmit={event => { event.preventDefault(); void client.command({ type: 'cancel-plan', id: selected.id, reason }); }}>
        <fieldset disabled={disabled}><label>{copy.reason}<input value={reason} maxLength={1000} required onChange={event => setReason(event.target.value)} /></label>
          <p className="cm-help">{copy.cancelHint}</p><button type="submit" disabled={!reason.trim()}>{copy.cancelPlan}</button></fieldset>
      </form>}
      {!state.instances.length && <p>{copy.noInstances}</p>}
      {state.instances.map(item => <Occurrence key={`${item.id}:${item.state}`} item={item} locale={locale} disabled={disabled} onCommand={command => client.command(command)} />)}
      {state.nextInstance !== null && <button type="button" disabled={state.loading || state.saving} onClick={() => { void client.select(selected, state.nextInstance!); }}>{copy.nextInstance}</button>}
      <details className="cm-task-history"><summary>{copy.history}</summary>
        <button type="button" disabled={state.loading || state.saving} onClick={() => { void client.history(); }}>{copy.loadHistory}</button>
        {state.history.map(item => <article key={item.seq}><time dateTime={new Date(item.at).toISOString()}>{date(item.at, locale)}</time><p>{scheduleHistoryAction(locale, item.action)}</p>{item.reason && <p>{item.reason}</p>}
          <details><summary>{copy.technicalDetails}</summary><code>{item.action}</code></details></article>)}
        {state.nextHistory !== null && <button type="button" disabled={state.loading || state.saving} onClick={() => { void client.history(state.nextHistory!); }}>{copy.nextHistory}</button>}
      </details>
    </section>}
  </section>;
}

function PlanForm({ locale, sessions, disabled, onSave }: Pick<Props, 'locale' | 'sessions'> & { disabled: boolean; onSave(command: unknown): Promise<void> }) {
  const copy = scheduleCopy(locale);
  const [kind, setKind] = useState('every');
  return <form className="cm-business-form" aria-label={copy.create} onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const value = (key: string) => String(data.get(key) ?? '').trim();
    void onSave({ type: 'create', id: crypto.randomUUID(), sessionId: value('sessionId'), prompt: value('prompt'),
      rule: kind === 'every' ? { kind, everySeconds: Number(value('minutes')) * 60 } : { kind, at: { date: value('date'), time: value('time'), time_zone: value('timezone') } },
      missed: value('missed'), catchUpLimit: Number(value('catchUpLimit')) });
  }}><fieldset disabled={disabled}>
    <label>{copy.prompt}<textarea name="prompt" required maxLength={8000} rows={3} /></label>
    <label>{copy.session}<select name="sessionId" required defaultValue=""><option value="">{copy.choose}</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label>
    <label>{copy.rule}<select value={kind} onChange={event => setKind(event.target.value)}><option value="every">{copy.every}</option><option value="at">{copy.at}</option></select></label>
    {kind === 'every' ? <label>{copy.minutes}<input name="minutes" type="number" min="5" max="525600" step="1" defaultValue="60" required /></label> : <>
      <div className="cm-business-form-row"><label>{copy.date}<input name="date" type="date" required /></label><label>{copy.time}<input name="time" type="time" required /></label></div>
      <label>{copy.timezone}<input name="timezone" required defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone} /></label>
    </>}
    <label>{copy.missed}<select name="missed" defaultValue="coalesce"><option value="coalesce">{copy.coalesce}</option><option value="skip">{copy.skip}</option><option value="catch-up">{copy['catch-up']}</option></select></label>
    <label>{copy.catchUpLimit}<input name="catchUpLimit" type="number" min="1" max="100" step="1" defaultValue="1" required /></label>
    <button type="submit">{copy.save}</button>
  </fieldset></form>;
}

function Occurrence({ item, locale, disabled, onCommand }: { item: ScheduleInstanceView; locale: ProductLocale; disabled: boolean; onCommand(command: unknown): Promise<boolean> }) {
  const copy = scheduleCopy(locale);
  const [reason, setReason] = useState('');
  const [inspected, setInspected] = useState(false);
  const action = (type: string, fields = {}) => { void onCommand({ type, id: item.planId, instanceId: item.id, ...fields }); };
  return <article className="cm-business-task">
    <strong>{copy[item.state]}</strong><p><code>{item.id}</code></p>
    <p>{copy.dueAt}: {date(item.scheduledAt, locale)} · {copy.expiresAt}: {date(item.expiresAt, locale)} · {copy.attempts}: {item.attempts}</p>
    {item.reason && <details><summary>{copy.reason}</summary><p>{item.reason}</p></details>}
    <fieldset disabled={disabled}>
      {item.state === 'waiting_approval' && <button type="button" onClick={() => action('approve')}>{copy.approve}</button>}
      {['waiting_approval', 'ready', 'leased', 'uncertain'].includes(item.state) && <label>{copy.reason}<input value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} /></label>}
      {['waiting_approval', 'ready', 'leased'].includes(item.state) && <button type="button" disabled={!reason.trim()} onClick={() => action('cancel-instance', { reason })}>{copy.cancelInstance}</button>}
      {item.state === 'uncertain' && <><p>{copy.uncertainHint}</p><label><input type="checkbox" checked={inspected} onChange={event => setInspected(event.target.checked)} />{copy.inspected}</label>
        <div className="cm-task-decisions"><button type="button" disabled={!inspected || !reason.trim()} onClick={() => action('resolve-uncertain', { reason, resolution: 'acknowledge-dispatched' })}>{copy.acknowledge}</button>
          <button type="button" disabled={!inspected || !reason.trim()} onClick={() => action('resolve-uncertain', { reason, resolution: 'cancel' })}>{copy.resolveCancel}</button></div></>}
    </fieldset>
  </article>;
}

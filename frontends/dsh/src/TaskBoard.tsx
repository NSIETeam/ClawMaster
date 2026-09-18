/** Durable task management, evidence submission and human acceptance on the WatchDog home. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { taskCopy } from './locales/tasks.ts';
import type { ProductLocale } from './locales/frontend.ts';
import type { WorkbenchSession } from './Workbench.tsx';
import type { SessionId } from './services.ts';
import { taskAttentionSummary, taskIndicators, type TaskRecord, type TaskRequest } from './watchdog-task-format.ts';
import type { WatchdogTaskClient } from './watchdog-task-client.ts';

interface Props { client: WatchdogTaskClient; locale: ProductLocale; sessions: readonly WorkbenchSession[]; onOpenSession(id: SessionId): void;
  onPrepareExecution(task: TaskRecord, sessionId: string): string; onRunExecution(task: TaskRecord): Promise<void>; onAbandonExecution(requestId: string): void; }
function dateText(value: string, locale: ProductLocale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
function externalEvidence(location: string): string | undefined {
  try {
    const value = new URL(location);
    return ['https:', 'http:'].includes(value.protocol) && !value.username && !value.password ? value.href : undefined;
  } catch { return undefined; }
}
function nextStep(task: TaskRecord, copy: ReturnType<typeof taskCopy>): string {
  if (task.status === 'in_progress' && task.waitingFor) return copy.nextWaiting;
  const keys = { draft: 'nextDraft', ready: 'nextReady', in_progress: 'nextProgress', awaiting_review: 'nextReview',
    accepted: 'nextAccepted', failed: 'nextFailed', cancelled: 'nextCancelled' } as const;
  return copy[keys[task.status]];
}

/** Reads only on entry; task writes originate from explicit form submissions. */
export function TaskBoard({ client, locale, sessions, onOpenSession, onPrepareExecution, onRunExecution, onAbandonExecution }: Props) {
  const copy = taskCopy(locale);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const [creating, setCreating] = useState(false);
  const [executionError, setExecutionError] = useState(false);
  const run = async (task: TaskRecord): Promise<void> => {
    setExecutionError(false);
    try { await onRunExecution(task); } catch { setExecutionError(true); }
  };
  useEffect(() => { void client.refresh(); }, [client]);
  const blocked = state.saving || state.pending;
  const summary = taskAttentionSummary(state.tasks);
  return <section className="cm-task-board" aria-label={copy.heading} aria-busy={state.loading}>
    <div className="cm-task-board-heading"><h2>{copy.heading}</h2><div>
      <button type="button" disabled={blocked} onClick={() => setCreating(value => !value)}>{creating ? copy.closeForm : copy.create}</button>
      <button type="button" disabled={state.loading || state.saving} onClick={() => { void client.refresh(); }}>{copy.refresh}</button>
    </div></div>
    <p className="cm-help">{copy.hint}</p>
    <section className="cm-task-summary" aria-label={copy.summaryHeading}>
      <h3>{copy.summaryHeading}</h3><p className="cm-help">{copy.summaryHint}</p>
      <dl><div><dt>{copy.summaryLoaded}</dt><dd>{summary.total}</dd></div><div data-attention={summary.needsAttention > 0 ? 'true' : 'false'}><dt>{copy.summaryNeedsAttention}</dt><dd>{summary.needsAttention}</dd></div>
        <div><dt>{copy.summaryOverdue}</dt><dd>{summary.overdue}</dd></div><div><dt>{copy.summaryReview}</dt><dd>{summary.awaitingReview}</dd></div>
        <div><dt>{copy.summaryFailed}</dt><dd>{summary.failed}</dd></div><div><dt>{copy.summaryWaiting}</dt><dd>{summary.waiting}</dd></div>
      </dl>
    </section>
    {state.error && <p role="alert" className="cm-error">{copy[state.error]}</p>}
    {state.saving && <p role="status">{copy.saving}</p>}
    {state.pending && !state.saving && <div role="alert"><p>{copy.pending}</p><button type="button" onClick={() => { void (async () => {
      const pending = client.getPendingCommand();
      const isStart = pending?.command.type === 'start';
      const saved = await client.retry();
      if (saved) {
        setCreating(false);
        const task = client.getSnapshot().selected;
        if (isStart && task?.execution) await run(task);
      } else if (pending?.command.type === 'start' && !client.getSnapshot().pending) onAbandonExecution(pending.command.requestId);
    })(); }}>{copy.retry}</button></div>}
    {executionError && <p role="alert" className="cm-error">{copy.executionFailed}</p>}
    {creating && <TaskDraft locale={locale} sessions={sessions} disabled={blocked} onSave={async command => {
      if (await client.command(crypto.randomUUID(), 0, command)) setCreating(false);
    }} />}
    {state.loading && <p role="status">{copy.loading}</p>}
    {!state.loading && !state.tasks.length && <p className="cm-empty">{copy.empty}</p>}
    <div className="cm-business-tasks" aria-label={copy.loaded}>
      {state.tasks.map(task => {
        const flags = taskIndicators(task);
        return <article key={task.id} className="cm-business-task">
          <button type="button" aria-pressed={state.selected?.id === task.id} disabled={state.saving} onClick={() => { void client.select(task.id); }}><strong>{task.goal}</strong></button>
          <div className="cm-business-task-facts"><span data-task-status={task.status}>{copy[task.status]}</span>
            <span>{task.source === 'imported-session' ? copy.imported : copy.newSource}</span>
            {flags.overdue && <strong className="cm-attention">{copy.overdue}</strong>}
            {flags.waiting && <span>{copy.waiting}</span>}
            <span>{copy.owner}: {task.owner.kind === 'local' ? task.owner.label : task.owner.id}</span>
            {task.dueAt ? <time dateTime={task.dueAt}>{dateText(task.dueAt, locale)}</time> : <span>{copy.noDeadline}</span>}
            <span>{copy.nextStep}: {nextStep(task, copy)}</span>
          </div>
        </article>;
      })}
    </div>
    {state.nextCursor !== null && <button type="button" disabled={state.loading} onClick={() => { void client.more(); }}>{copy.more}</button>}
    {state.selected && <TaskDetail key={`${state.selected.id}:${state.selected.revision}`} task={state.selected} locale={locale} sessions={sessions}
      onOpenSession={onOpenSession} disabled={blocked} onCommand={async command => {
        const saved = await client.command(state.selected!.id, state.selected!.revision, command);
        if (!saved && command.type === 'start' && !client.getSnapshot().pending) onAbandonExecution(command.requestId);
        return saved;
      }} onPrepareExecution={onPrepareExecution} onAbandonExecution={onAbandonExecution} onRunExecution={run} />}
    {state.selected && <details className="cm-task-history"><summary>{copy.history}</summary>
      <button type="button" disabled={state.loading || state.saving} onClick={() => { void client.select(state.selected!.id); }}>{copy.loadHistory}</button>
      {!state.history.length && <p>{copy.noHistory}</p>}
      {state.history.map(task => <article key={task.revision}><strong>{copy.revision} {task.revision} · {copy[task.status]}</strong>
        <time dateTime={task.updatedAt}>{dateText(task.updatedAt, locale)}</time><Evidence task={task} locale={locale} />
        {task.lastReview && <p>{task.lastReview.actorId}: {task.lastReview.comment}</p>}
      </article>)}
      {state.nextAfter !== null && <button type="button" disabled={state.loading} onClick={() => { void client.moreHistory(); }}>{copy.moreHistory}</button>}
    </details>}
  </section>;
}

function TaskDraft({ locale, disabled, sessions, initial, onSave }: { locale: ProductLocale; disabled: boolean; sessions: readonly WorkbenchSession[]; initial?: TaskRecord; onSave(command: TaskRequest['command']): Promise<void> }) {
  const copy = taskCopy(locale);
  const [error, setError] = useState(false);
  const initialDate = initial?.dueAt ? new Date(initial.dueAt) : null;
  const localDate = initialDate ? new Date(initialDate.getTime() - initialDate.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
  return <form className="cm-business-form" aria-label={initial ? copy.edit : copy.create} onSubmit={event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (name: string) => String(form.get(name) ?? '').trim();
    const date = value('dueAt') ? new Date(value('dueAt')) : null;
    if (date && !Number.isFinite(date.getTime())) { setError(true); return; }
    setError(false);
    const task: Extract<TaskRequest['command'], { type: 'create' }>['task'] = { goal: value('goal'), scope: value('scope'),
      owner: value('ownerKind') === 'member' ? { kind: 'member', id: value('owner') } : { kind: 'local', label: value('owner') },
      dueAt: date?.toISOString() ?? null, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      risk: value('risk') as 'low' | 'medium' | 'high',
      checklist: value('criteria').split('\n').map(description => description.trim()).filter(Boolean).map((description, index) => ({
        id: initial?.checklist[index]?.description === description ? initial.checklist[index].id : crypto.randomUUID(), description })),
    };
    void onSave(initial ? { type: 'revise', task } : { type: 'create', task,
      ...(value('importedSession') ? { importedSessionId: value('importedSession') } : {}) });
  }}>
    <fieldset disabled={disabled}><label>{copy.goal}<input name="goal" required maxLength={4000} defaultValue={initial?.goal} /></label>
      <label>{copy.scope}<textarea name="scope" required maxLength={4000} rows={2} defaultValue={initial?.scope} /></label>
      <div className="cm-business-form-row"><label>{copy.ownerKind}<select name="ownerKind" defaultValue={initial?.owner.kind}><option value="local">{copy.local}</option><option value="member">{copy.member}</option></select></label>
        <label>{copy.owner}<input name="owner" required maxLength={200} defaultValue={initial?.owner.kind === 'member' ? initial.owner.id : initial?.owner.label} /></label></div>
      <div className="cm-business-form-row"><label>{copy.deadline}<input name="dueAt" type="datetime-local" defaultValue={localDate} /></label>
        <label>{copy.risk}<select name="risk" defaultValue={initial?.risk}><option value="low">{copy.low}</option><option value="medium">{copy.medium}</option><option value="high">{copy.high}</option></select></label></div>
      <p className="cm-help">{copy.timezone}: {Intl.DateTimeFormat().resolvedOptions().timeZone}</p>
      <label>{copy.criteria}<textarea name="criteria" required rows={3} defaultValue={initial?.checklist.map(item => item.description).join('\n')} /></label>
      {!initial && <label>{copy.importSession}<select name="importedSession"><option value="">{copy.noImport}</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label>}
      {error && <p role="alert">{copy.dateInvalid}</p>}
      <p className="cm-help">{copy.savedHint}</p><button type="submit">{initial ? copy.saveChanges : copy.saveDraft}</button>
    </fieldset>
  </form>;
}

function Evidence({ task, locale }: { task: TaskRecord; locale: ProductLocale }) {
  const copy = taskCopy(locale);
  return <div className="cm-task-evidence"><h4>{copy.evidence}</h4>
    {task.evidence.map(item => <div key={item.id}><p>{item.summary}</p><code>{item.location}</code>
      <time dateTime={item.observedAt}>{dateText(item.observedAt, locale)}</time>
      {externalEvidence(item.location) && <a href={externalEvidence(item.location)} target="_blank" rel="noopener noreferrer">{copy.openEvidence}</a>}
    </div>)}
    {task.evidence.length > 0 && <p className="cm-help">{copy[
      task.evidenceAvailability === 'available' ? 'evidenceAvailable'
        : task.evidenceAvailability === 'unavailable' ? 'evidenceUnavailable' : 'evidenceUnchecked']}</p>}
  </div>;
}

function TaskDetail({ task, locale, sessions, onOpenSession, disabled, onCommand, onPrepareExecution, onRunExecution }: Omit<Props, 'client'> & {
  task: TaskRecord; disabled: boolean; onCommand(command: TaskRequest['command']): Promise<boolean>;
}) {
  const copy = taskCopy(locale);
  const [sessionId, setSessionId] = useState(task.execution?.sessionId ?? task.sessionIds.at(-1) ?? '');
  const [comment, setComment] = useState('');
  const [dateError, setDateError] = useState(false);
  const [evidenceLocationError, setEvidenceLocationError] = useState(false);
  const [editing, setEditing] = useState(false);
  const closed = task.status === 'accepted' || task.status === 'cancelled';
  return <section className="cm-task-detail" aria-label={copy.details}>
    <h3>{task.goal}</h3><p>{task.scope}</p><p>{copy.status}: {copy[task.status]} · {copy.revision} {task.revision}</p>
    <p>{copy.timezone}: {task.timezone}</p>
    {task.waitingFor && <p>{task.status === 'failed' ? copy.failureReason : task.status === 'cancelled' ? copy.cancelReason : copy.waiting}: {task.waitingFor}</p>}
    <p>{task.source === 'imported-session' ? copy.imported : copy.newSource}</p>
    {['draft', 'ready'].includes(task.status) && <button type="button" disabled={disabled} onClick={() => setEditing(value => !value)}>{editing ? copy.closeForm : copy.edit}</button>}
    {editing && <TaskDraft locale={locale} disabled={disabled} sessions={sessions} initial={task} onSave={async command => { if (await onCommand(command)) setEditing(false); }} />}
    <fieldset disabled={disabled}>
      {['draft', 'failed'].includes(task.status) && <button type="button" onClick={() => { void onCommand({ type: 'queue' }); }}>{copy.queue}</button>}
      {!closed && <div className="cm-business-form-row"><label>{copy.session}<select value={sessionId} disabled={disabled || task.execution !== null} onChange={event => setSessionId(event.target.value)}>
        <option value="">{copy.selectSession}</option>{sessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}
      </select></label>{task.status === 'ready' || (task.status === 'in_progress' && !task.execution)
        ? <button type="button" disabled={!sessionId} onClick={() => { void (async () => {
          const requestId = onPrepareExecution(task, sessionId);
          if (!await onCommand({ type: 'start', sessionId, requestId, locale })) return;
          await onRunExecution({ ...task, status: 'in_progress', revision: task.revision + 1,
            sessionIds: [...new Set([...task.sessionIds, sessionId])], execution: { sessionId, requestId, locale } });
        })(); }}>{task.status === 'ready' ? copy.start : copy.resumeExecution}</button>
        : task.status === 'in_progress' && task.execution
          ? <button type="button" onClick={() => { void onRunExecution(task); }}>{copy.retryExecution}</button>
          : <button type="button" disabled={!sessionId} onClick={() => { void onCommand({ type: 'link', sessionId }); }}>{copy.link}</button>}</div>}
      {!closed && <p className="cm-help">{copy.sessionHint}</p>}
      {task.sessionIds.map(id => <div key={id}><button type="button" onClick={() => onOpenSession(id as SessionId)}>{copy.openSession} · {sessions.find(session => session.id === id)?.title ?? id}</button>
        {sessions.some(session => session.id === id) && <span>{sessions.find(session => session.id === id)?.running ? copy.running : copy.idle}</span>}</div>)}
    </fieldset>
    <Evidence task={task} locale={locale} />
    {task.lastReview && <p>{copy.review}: {task.lastReview.actorId} · {task.lastReview.comment}</p>}
    {task.status === 'in_progress' && <form className="cm-business-form" aria-label={copy.submit} onSubmit={event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const observed = new Date(String(form.get('observedAt')));
      if (!Number.isFinite(observed.getTime())) { setDateError(true); return; }
      const evidenceSession = String(form.get('evidenceSession') ?? '');
      const location = evidenceSession ? `dsh-session://${evidenceSession}` : String(form.get('location') ?? '').trim();
      if (!location) { setEvidenceLocationError(true); return; }
      setDateError(false);
      setEvidenceLocationError(false);
      void onCommand({ type: 'submit', evidence: [{ id: crypto.randomUUID(), location, observedAt: observed.toISOString(), summary: String(form.get('summary')) }],
        completedCriteria: form.getAll('criteria').map(String) });
    }}><fieldset disabled={disabled}><label>{copy.evidenceSession}<select name="evidenceSession"><option value="">{copy.noEvidenceSession}</option>{task.sessionIds.map(id => <option key={id} value={id}>{sessions.find(session => session.id === id)?.title ?? id}</option>)}</select></label>
      <p className="cm-help">{copy.evidenceLocationHint}</p><label>{copy.evidenceLocation}<input name="location" maxLength={2000} /></label>
      {evidenceLocationError && <p role="alert">{copy.evidenceLocationRequired}</p>}
      <label>{copy.evidenceSummary}<textarea name="summary" required maxLength={4000} rows={2} /></label>
      <label>{copy.evidenceObserved}<input name="observedAt" required type="datetime-local" /></label>
      <fieldset><legend>{copy.checkedCriteria}</legend>{task.checklist.map(item => <label key={item.id}><input name="criteria" type="checkbox" value={item.id} required />{item.description}</label>)}</fieldset>
      {dateError && <p role="alert">{copy.dateInvalid}</p>}<button type="submit">{copy.submit}</button>
    </fieldset></form>}
    <div className="cm-business-form"><label>{copy.reviewComment}<textarea value={comment} onChange={event => setComment(event.target.value)} maxLength={4000} rows={2} /></label>
      <fieldset disabled={disabled || !comment.trim()} className="cm-task-decisions">
        {task.status === 'awaiting_review' && <><button type="button" onClick={() => { void onCommand({ type: 'review', decision: 'accept', comment }); }}>{copy.accept}</button>
          <button type="button" onClick={() => { void onCommand({ type: 'review', decision: 'reject', comment }); }}>{copy.reject}</button></>}
        {closed ? <button type="button" onClick={() => { void onCommand({ type: 'reopen', reason: comment }); }}>{copy.reopen}</button>
          : <button type="button" onClick={() => { void onCommand({ type: 'cancel', reason: comment }); }}>{copy.cancel}</button>}
        {['ready', 'in_progress'].includes(task.status) && <button type="button" onClick={() => { void onCommand({ type: 'fail', reason: comment }); }}>{copy.fail}</button>}
        {['ready', 'in_progress'].includes(task.status) && <button type="button" onClick={() => { void onCommand({ type: 'wait', reason: comment }); }}>{copy.recordWaiting}</button>}
      </fieldset>
      {task.waitingFor && ['ready', 'in_progress'].includes(task.status) && <button type="button" disabled={disabled} onClick={() => { void onCommand({ type: 'wait', reason: null }); }}>{copy.clearWaiting}</button>}
    </div>
  </section>;
}

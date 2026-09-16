/** CRM and ERP sidebar components backed by the authenticated local enterprise service. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { productCopy, type ProductLocale } from './locales/frontend.ts';
import { enterpriseActionLabel, enterpriseCopy } from './locales/enterprise.ts';
import {
  enterpriseClient, EnterpriseClient, minorUnitsToMoneyInput, moneyInputToMinorUnits,
  quantityInputToInteger, type EnterpriseClientState,
} from './enterprise-client.ts';
import { auditSchema, enterpriseOrderTotal, parseEnterpriseBackup } from './enterprise-schema.ts';
import {
  enterpriseId, EnterpriseError, type AuditEntry, type BusinessOrder, type Contact, type EnterpriseBackup,
  type ContactInput, type EnterpriseCommand, type EnterpriseId, type EnterpriseSnapshot, type EnterpriseOverview, type EnterpriseQuerySpec, type EnterpriseQueryPage,
  type InventoryItem, type InventoryItemInput, type OrderInput,
} from './enterprise-types.ts';
import styles from './enterprise.css';

/** Host-selected language and optional isolated service client. */
export interface EnterprisePanelProps { locale?: ProductLocale; client?: EnterpriseClient; }

const stages: ContactInput['stage'][] = ['lead', 'contacted', 'proposal', 'won', 'lost'];

interface EnterpriseRecords { contacts: Contact; inventory: InventoryItem; orders: BusinessOrder; audit: AuditEntry; }
type PageFilters = Omit<EnterpriseQuerySpec, 'collection' | 'offset' | 'limit' | 'generation' | 'revision'>;
type CollectionPage<C extends keyof EnterpriseRecords> = Omit<EnterpriseQueryPage, 'records'> & { records: EnterpriseRecords[C][] };

function useEnterprisePage<C extends keyof EnterpriseRecords>(client: EnterpriseClient, overview: EnterpriseOverview | null, collection: C, filters: PageFilters = {}, enabled = true) {
  const filterKey = JSON.stringify({ ...filters, generation: overview?.generation, revision: overview?.revision });
  const [window, setWindow] = useState({ key: filterKey, offsets: [0] });
  const offsets = window.key === filterKey ? window.offsets : [0];
  const offset = offsets[offsets.length - 1] ?? 0;
  const query: EnterpriseQuerySpec = { collection, offset, limit: overview?.limits.pageRows ?? 50, ...filters,
    ...(overview ? { generation: overview.generation, revision: overview.revision } : {}) };
  const requestKey = JSON.stringify(query);
  const [result, setResult] = useState<{ key: string; page: CollectionPage<C> | null }>({ key: '', page: null });
  useEffect(() => {
    if (!overview || !enabled) return;
    const controller = new AbortController();
    let active = true;
    void client.query(JSON.parse(requestKey) as EnterpriseQuerySpec, controller.signal).then(page => {
      if (active) setResult({ key: requestKey, page: page as CollectionPage<C> });
    }).catch(() => { /* The client exposes the localized read failure without replacing the previous page. */ });
    return () => { active = false; controller.abort(); };
  }, [client, overview, requestKey, enabled]);
  const page = enabled && result.key === requestKey ? result.page : null;
  return { page, loading: enabled && overview !== null && page === null, previous: offsets.length > 1,
    back: () => setWindow({ key: filterKey, offsets: offsets.slice(0, -1) }),
    next: () => { if (page?.nextOffset !== null && page?.nextOffset !== undefined) setWindow({ key: filterKey, offsets: [...offsets, page.nextOffset] }); } };
}

function PageNavigation({ locale, view, busy }: { locale: ProductLocale; view: { page: EnterpriseQueryPage | null; previous: boolean; loading: boolean; back(): void; next(): void }; busy: boolean }) {
  const e = enterpriseCopy(locale);
  return <div className="cm-ent-load-more" aria-label={e.pageNavigation}>
    <span className="cm-ent-help">{view.page ? `${e.historyShowing}: ${view.page.records.length === 0 ? 0 : view.page.offset + 1}–${view.page.offset + view.page.records.length} / ${view.page.total}` : productCopy(locale).loadingData}</span>
    <button type="button" disabled={busy || view.loading || !view.previous} onClick={view.back}>{e.previousPage}</button>
    <button type="button" disabled={busy || view.loading || view.page?.nextOffset == null} onClick={view.next}>{e.nextPage}</button>
  </div>;
}

function useEnterprise(client: EnterpriseClient): EnterpriseClientState {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => { void client.refresh(); }, [client]);
  return state;
}

function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function money(value: number): string { return `¥${minorUnitsToMoneyInput(value)}`; }
function newId(): EnterpriseId { return enterpriseId(crypto.randomUUID()); }

async function downloadEnterpriseBackup(client: EnterpriseClient): Promise<void> {
  const backup = await client.backup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `clawmaster-enterprise-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ClientBanner({ state, client, locale, localError, onRetried }: {
  state: EnterpriseClientState; client: EnterpriseClient; locale: ProductLocale;
  localError?: string | null; onRetried?: (command: EnterpriseCommand) => void;
}) {
  const t = productCopy(locale);
  const e = enterpriseCopy(locale);
  const error = localError ?? (state.error === 'pending_command' ? e.pending : state.error === 'stale_form' ? e.staleForm : state.error === 'result_too_large' ? e.resultTooLarge : state.error === 'permission_denied' ? e.permissionDenied : state.error ? t[state.error] : null);
  if (!error && !state.pending) return null;
  return <div className={`cm-ent-banner ${state.pending ? 'is-pending' : 'is-error'}`} role="alert">
    {error && <p>{error}</p>}
    {state.pending && <p>{state.restoreUncertain ? e.restoreUncertain : e.pending}</p>}
    <div className="cm-ent-actions">{state.pending && !state.restoreUncertain
      ? <button type="button" disabled={state.saving} onClick={async () => { const command = await client.retryPending(); if (command) onRetried?.(command); }}>{state.saving ? t.saving : e.retryPending}</button>
      : <button type="button" disabled={state.loading || state.saving} onClick={() => { void client.refresh(); }}>{state.loading ? t.refreshing : t.refresh}</button>}
    </div>
  </div>;
}

function Panel({ locale, state, client, title, description, children }: {
  locale: ProductLocale; state: EnterpriseClientState; client: EnterpriseClient;
  title: string; description: string; children: ReactNode;
}) {
  const t = productCopy(locale);
  const e = enterpriseCopy(locale);
  const [restore, setRestore] = useState<EnterpriseBackup | null>(null);
  const [restoreReview, setRestoreReview] = useState<Pick<EnterpriseSnapshot, 'revision' | 'generation'> | null>(null);
  const [restoreError, setRestoreError] = useState(false);
  const [backupError, setBackupError] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const chooseRestore = async (file: File | undefined) => {
    if (!file) return;
    const reviewed = client.getSnapshot().overview;
    if (!reviewed) return;
    try {
      setRestore(parseEnterpriseBackup(JSON.parse(await file.text())));
      setRestoreReview({ revision: reviewed.revision, generation: reviewed.generation });
      setRestoreError(false);
    } catch {
      setRestore(null); setRestoreError(true);
    }
  };
  const confirmRestore = async () => {
    if (!restore || !restoreReview) return;
    setRestoreBusy(true); setRestoreError(false);
    try {
      await client.restore(restore, restoreReview.revision, restoreReview.generation);
      setRestore(null);
    } catch { /* The client retains the restore outcome and its localized failure. */ }
    finally { setRestoreBusy(false); }
  };
  return <section className="cm-enterprise" aria-label={title}>
    <style>{styles}</style>
    <header className="cm-ent-header"><div><small>{e.sourceLocal}</small><h2>{title}</h2><p>{description}</p></div>
      <div className="cm-ent-actions">{state.overview && <small>{t.revision}: {state.overview.revision}</small>}{state.overview && <button type="button" disabled={state.loading || state.saving} onClick={() => { setBackupError(false); void downloadEnterpriseBackup(client).catch(() => setBackupError(true)); }}>{e.localBackup}</button>}<label className="cm-ent-file-button"><input type="file" accept="application/json,.json" hidden disabled={state.saving || state.pending} onChange={event => { void chooseRestore(event.target.files?.[0]); event.currentTarget.value = ''; }} />{e.restoreBackup}</label><button type="button" disabled={state.loading || state.saving} onClick={() => { void client.refresh(); }}>{state.loading ? t.refreshing : t.refresh}</button></div>
    </header>
    {restoreError && <p className="cm-ent-banner is-error" role="alert">{e.restoreInvalid}</p>}
    {backupError && <p className="cm-ent-banner is-error" role="alert">{e.backupFailed}</p>}
    {restore && state.overview && <section className="cm-ent-banner cm-ent-confirm" aria-label={e.restorePreview}><strong>{e.restorePreview}</strong><p>{t.revision}: {restore.snapshot.revision} · {e.contactsCount}: {restore.snapshot.contacts.length} · {e.inventoryCount}: {restore.snapshot.inventory.length} · {e.allOrders}: {restore.snapshot.orders.length}</p><p>{e.restoreConfirm}？{t.revision} {state.overview.revision} → {restore.snapshot.revision}</p><div className="cm-ent-actions"><button className="cm-ent-primary" type="button" disabled={restoreBusy || state.saving || state.pending || state.loading} onClick={() => { void confirmRestore(); }}>{restoreBusy ? t.saving : e.restoreConfirm}</button><button type="button" disabled={restoreBusy} onClick={() => setRestore(null)}>{e.restoreCancel}</button></div></section>}
    {state.overview === null && !state.error && <p className="cm-ent-empty" role="status">{t.loadingData}</p>}
    {children}
  </section>;
}

function DeleteConfirmation({ locale, busy, name, changed, onCancel, onDelete }: {
  locale: ProductLocale; busy: boolean; name: string; changed: boolean; onCancel: () => void; onDelete: () => void;
}) {
  const t = productCopy(locale);
  const e = enterpriseCopy(locale);
  return <section className="cm-ent-banner cm-ent-confirm" aria-label={e.confirmDelete}>
    <strong>{name}</strong><p>{e.deleteConfirm}</p>{changed && <p role="alert">{e.confirmationChanged}</p>}<div className="cm-ent-actions">
      <button className="cm-ent-danger" type="button" disabled={busy || changed} onClick={onDelete}>{e.confirmDelete}</button>
      <button type="button" disabled={busy} onClick={onCancel}>{t.cancel}</button>
    </div>
  </section>;
}

function DraftReview({ locale, changed, available, busy, loading = false, onReview, children }: {
  locale: ProductLocale; changed: boolean; available: boolean; busy: boolean; loading?: boolean;
  onReview(): void; children: ReactNode;
}) {
  if (!changed) return null;
  const e = enterpriseCopy(locale);
  return <section className="cm-ent-banner" aria-label={e.latestRecord}>
    <p role="alert">{loading ? productCopy(locale).loadingData : available ? e.draftChanged : e.recordUnavailable}</p>
    {children}
    <button type="button" disabled={busy || loading || !available} onClick={onReview}>{e.reviewedDraft}</button>
  </section>;
}

function RecordFields({ fields }: { fields: readonly (readonly [string, string])[] }) {
  return <dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

/**
 * Render editable contacts, stage filters, and dated follow-ups from SQLite.
 * @param props Product language and enterprise client.
 * @returns A CRM sidebar component that retains forms after failed writes.
 */
export function CRM({ locale = 'zh-CN', client = enterpriseClient }: EnterprisePanelProps) {
  const t = productCopy(locale);
  const e = enterpriseCopy(locale);
  const state = useEnterprise(client);
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState<ContactInput['stage'] | ''>('');
  const [dueOnly, setDueOnly] = useState(false);
  const [editor, setEditor] = useState<ContactInput | null>(null);
  const [editorBase, setEditorBase] = useState({ revision: 0, generation: 0, existed: false });
  const [deleting, setDeleting] = useState<{ contact: Contact; revision: number; generation: number } | null>(null);
  const [status, setStatus] = useState('');
  const busy = state.saving || state.pending || state.loading || state.readUnavailable;
  const overview = state.overview;
  const isDue = (contact: Contact) => contact.nextActionDate !== null && contact.nextActionDate <= today();
  const contacts = useEnterprisePage(client, overview, 'contacts', { search, ...(stage ? { stage } : {}), ...(dueOnly ? { dueBefore: today() } : {}) });
  const latest = useEnterprisePage(client, overview, 'contacts', { ...(editor ? { id: editor.id } : {}) }, editor !== null && editorBase.existed);
  const rows = contacts.page?.records ?? [];
  const latestContact = latest.page?.records[0];
  const edit = (contact: Contact) => {
    const { updatedAt: _updatedAt, ...input } = contact;
    setEditor(input); setEditorBase({ generation: overview!.generation, revision: overview!.revision, existed: true }); setStatus('');
  };
  const mutationDone = (command: EnterpriseCommand) => {
    if (command.type === 'contact.upsert') { setEditor(null); setStatus(e.saved); }
    if (command.type === 'contact.remove') { setDeleting(null); setStatus(e.deleted); }
  };
  return <Panel locale={locale} state={state} client={client} title={t.crm} description={t.crmDescription}>
    <ClientBanner state={state} client={client} locale={locale} onRetried={mutationDone} />
    {status && <p className="cm-ent-status" role="status">{status}</p>}
    {overview && <>
      <div className="cm-ent-counts"><div><span>{e.contactsCount}</span><strong>{overview.counts.contacts}</strong></div><div><span>{e.dueCount}</span><strong>{overview.counts.followups}</strong></div></div>
      <div className="cm-ent-toolbar"><input type="search" aria-label={t.contactSearch} placeholder={t.contactSearch} value={search} onChange={event => setSearch(event.target.value)} />
        <select aria-label={e.stageFilter} value={stage} onChange={event => setStage(stages.find(value => value === event.target.value) ?? '')}><option value="">{t.allStages}</option>{stages.map(value => <option key={value} value={value}>{t[value]}</option>)}</select>
        <label className="cm-ent-check"><input type="checkbox" checked={dueOnly} onChange={event => setDueOnly(event.target.checked)} />{e.onlyDue}</label>
        <button className="cm-ent-primary" type="button" disabled={busy || editor !== null} onClick={() => { setEditor({ id: newId(), name: '', company: '', stage: 'lead', nextAction: '', nextActionDate: null }); setEditorBase({ generation: overview.generation, revision: overview.revision, existed: false }); setStatus(''); }}>{t.contactNew}</button>
      </div>
      {deleting && <DeleteConfirmation locale={locale} busy={busy} changed={(deleting.revision !== overview.revision || deleting.generation !== overview.generation)} name={deleting.contact.name} onCancel={() => setDeleting(null)} onDelete={async () => {
        const command: EnterpriseCommand = { type: 'contact.remove', id: deleting.contact.id };
        if (await client.execute(command, deleting.revision, deleting.generation)) mutationDone(command);
      }} />}
      <div className={`cm-ent-layout${editor ? ' has-editor' : ''}`}><div>
        {rows.length === 0 ? <p className="cm-ent-empty">{contacts.loading ? t.loadingData : overview.counts.contacts === 0 ? t.noContacts : e.noFiltered}</p> : <div className="cm-ent-table-wrap"><table className="cm-ent-table" aria-label={t.crm}>
          <thead><tr><th>{t.name}</th><th>{t.stage}</th><th>{t.nextAction}</th><th>{t.action}</th></tr></thead>
          <tbody>{rows.map(contact => <tr key={contact.id}><td><strong>{contact.name}</strong><small>{contact.company || e.noCompany}</small></td><td><span className={`cm-ent-badge${contact.stage === 'won' ? ' is-success' : ''}`}>{t[contact.stage]}</span></td>
            <td>{contact.nextAction || e.noAction}<small>{contact.nextActionDate ?? e.noDate} {isDue(contact) && <span className="cm-ent-badge is-warning">{t.due}</span>}</small></td>
            <td><div className="cm-ent-actions"><button type="button" disabled={busy || editor !== null} onClick={() => edit(contact)}>{t.edit}</button><button className="cm-ent-danger" type="button" disabled={busy || editor !== null} onClick={() => setDeleting({ contact, generation: overview.generation, revision: overview.revision })}>{t.remove}</button></div></td></tr>)}</tbody>
        </table></div>}
        <PageNavigation locale={locale} view={contacts} busy={busy} />
      </div>{editor && <form className="cm-ent-form" aria-label={editorBase.existed ? t.contactEdit : t.contactNew} onSubmit={async event => {
        event.preventDefault();
        const command: EnterpriseCommand = { type: 'contact.upsert', contact: editor };
        if (await client.execute(command, editorBase.revision, editorBase.generation)) mutationDone(command);
      }}>
        <header><h3>{editorBase.existed ? t.contactEdit : t.contactNew}</h3><button type="button" disabled={busy} onClick={() => setEditor(null)}>{t.cancel}</button></header>
        <DraftReview locale={locale} changed={(editorBase.revision !== overview.revision || editorBase.generation !== overview.generation)} busy={busy}
          loading={editorBase.existed && latest.loading}
          available={!editorBase.existed || latestContact !== undefined}
          onReview={() => setEditorBase({ ...editorBase, generation: overview.generation, revision: overview.revision })}>
          {(latestContact ? [latestContact] : []).map(contact => <RecordFields key={contact.id} fields={[
            [t.name, contact.name], [t.company, contact.company || e.noCompany], [t.stage, t[contact.stage]],
            [t.nextAction, contact.nextAction || e.noAction], [t.nextDate, contact.nextActionDate ?? e.noDate],
          ]} />)}
        </DraftReview>
        <fieldset className="cm-ent-fields" disabled={busy}>
          <label className="cm-ent-field"><span>{t.name}</span><input name="name" required maxLength={200} value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} /></label>
          <label className="cm-ent-field"><span>{t.company}</span><input name="company" maxLength={200} value={editor.company} onChange={event => setEditor({ ...editor, company: event.target.value })} /></label>
          <label className="cm-ent-field"><span>{t.stage}</span><select aria-label={t.stage} value={editor.stage} onChange={event => setEditor({ ...editor, stage: stages.find(value => value === event.target.value) ?? 'lead' })}>{stages.map(value => <option key={value} value={value}>{t[value]}</option>)}</select></label>
          <label className="cm-ent-field"><span>{t.nextAction}</span><textarea maxLength={2000} value={editor.nextAction} onChange={event => setEditor({ ...editor, nextAction: event.target.value })} /></label>
          <label className="cm-ent-field"><span>{t.nextDate}</span><input type="date" value={editor.nextActionDate ?? ''} onChange={event => setEditor({ ...editor, nextActionDate: event.target.value || null })} /></label>
          <button className="cm-ent-primary" type="submit" disabled={(editorBase.revision !== overview.revision || editorBase.generation !== overview.generation)}>{state.saving ? t.saving : t.save}</button>
        </fieldset>
      </form>}</div>
    </>}
  </Panel>;
}

interface ItemDraft { id: EnterpriseId; sku: string; name: string; stock: string; reorderAt: string; supplier: string; }
interface LineDraft { key: string; itemId: string; quantity: string; price: string; }
interface OrderDraft { id: EnterpriseId; kind: 'purchase' | 'sale'; counterparty: string; orderDate: string; note: string; lines: LineDraft[]; }

function toOrderDraft(order: BusinessOrder): OrderDraft {
  return { id: order.id, kind: order.kind, counterparty: order.counterparty, orderDate: order.orderDate, note: order.note,
    lines: order.lines.map(line => ({ key: crypto.randomUUID(), itemId: line.itemId, quantity: String(line.quantity), price: minorUnitsToMoneyInput(line.unitPriceMinorUnits) })) };
}

function toOrderInput(draft: OrderDraft): OrderInput {
  return { id: draft.id, kind: draft.kind, counterparty: draft.counterparty, orderDate: draft.orderDate, currency: 'CNY', note: draft.note,
    lines: draft.lines.map(line => ({ itemId: enterpriseId(line.itemId), quantity: quantityInputToInteger(line.quantity, 1), unitPriceMinorUnits: moneyInputToMinorUnits(line.price) })) };
}

function newLine(): LineDraft { return { key: crypto.randomUUID(), itemId: '', quantity: '1', price: '0.00' }; }

function AuditDetails({ entry, locale }: { entry: AuditEntry; locale: ProductLocale }) {
  const t = productCopy(locale);
  const e = enterpriseCopy(locale);
  const audit = auditSchema.parse(entry);
  const facts: [string, string, string][] = [];
  const empty = e.noRecord;
  const orderLines = (order: BusinessOrder) => order.lines.map(line => `${line.itemId} × ${line.quantity} @ ${money(line.unitPriceMinorUnits)}`).join('\n');
  if (audit.type === 'contact.upsert' || audit.type === 'contact.remove') {
    const before = audit.before; const after = audit.after;
    facts.push([t.name, before?.name ?? empty, after?.name ?? empty], [t.company, before?.company ?? empty, after?.company ?? empty],
      [t.stage, before ? t[before.stage] : empty, after ? t[after.stage] : empty], [t.nextAction, before?.nextAction ?? empty, after?.nextAction ?? empty],
      [t.nextDate, before?.nextActionDate ?? e.noDate, after?.nextActionDate ?? e.noDate]);
  } else if (audit.type === 'item.upsert' || audit.type === 'item.remove') {
    const before = audit.before; const after = audit.after;
    facts.push([t.sku, before?.sku ?? empty, after?.sku ?? empty], [t.itemName, before?.name ?? empty, after?.name ?? empty],
      [t.stock, before ? String(before.stock) : empty, after ? String(after.stock) : empty],
      [t.reorderAt, before ? String(before.reorderAt) : empty, after ? String(after.reorderAt) : empty], [t.supplier, before?.supplier ?? empty, after?.supplier ?? empty]);
  } else if (audit.type === 'order.save' || audit.type === 'order.remove') {
    const before = audit.before; const after = audit.after;
    facts.push([t.counterparty, before?.counterparty ?? empty, after?.counterparty ?? empty], [t.orderDate, before?.orderDate ?? empty, after?.orderDate ?? empty],
      [t.total, before ? money(before.totalMinorUnits) : empty, after ? money(after.totalMinorUnits) : empty],
      [t.lines, before ? orderLines(before) : empty, after ? orderLines(after) : empty], [t.note, before?.note ?? empty, after?.note ?? empty]);
  } else {
    facts.push([t.stage, t[audit.before.order.status], t[audit.after.order.status]]);
    for (const item of audit.after.inventory) facts.push([`${t.stock}: ${item.sku}`, String(audit.before.inventory.find(previous => previous.id === item.id)?.stock ?? 0), String(item.stock)]);
  }
  return <div className="cm-ent-table-wrap"><table className="cm-ent-table"><thead><tr><th>{t.details}</th><th>{e.before}</th><th>{e.after}</th></tr></thead><tbody>{facts.map(([label, before, after], index) => <tr key={index}><th scope="row">{label}</th><td>{before}</td><td>{after}</td></tr>)}</tbody></table></div>;
}

function SelectedItemOption({ client, overview, id }: { client: EnterpriseClient; overview: EnterpriseOverview; id: string }) {
  const detail = useEnterprisePage(client, overview, 'inventory', { id: enterpriseId(id) });
  const item = detail.page?.records[0];
  return <option value={id}>{item ? `${item.sku} · ${item.name}` : id}</option>;
}

/**
 * Render inventory corrections, purchase/sale drafts, explicit submission, and audit history.
 * @param props Product language and enterprise client.
 * @returns An ERP sidebar component with safe-integer quantities and minor-unit money.
 */
export function ERP({ locale = 'zh-CN', client = enterpriseClient }: EnterprisePanelProps) {
  const t = productCopy(locale);
  const e = enterpriseCopy(locale);
  const state = useEnterprise(client);
  const [tab, setTab] = useState<'inventory' | 'orders' | 'audit'>('inventory');
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [orderSearch, setOrderSearch] = useState('');
  const [orderKind, setOrderKind] = useState<'purchase' | 'sale' | ''>('');
  const [orderStatus, setOrderStatus] = useState<'draft' | 'submitted' | ''>('');
  const [itemEditor, setItemEditor] = useState<ItemDraft | null>(null);
  const [orderEditor, setOrderEditor] = useState<OrderDraft | null>(null);
  const [itemBase, setItemBase] = useState({ revision: 0, generation: 0, existed: false });
  const [orderBase, setOrderBase] = useState({ revision: 0, generation: 0, existed: false });
  const [viewOrderId, setViewOrderId] = useState<EnterpriseId | null>(null);
  const [deleting, setDeleting] = useState<{ kind: 'item' | 'order'; id: EnterpriseId; name: string; revision: number; generation: number } | null>(null);
  const [submission, setSubmission] = useState<{ order: BusinessOrder; revision: number; generation: number } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [itemSearch, setItemSearch] = useState('');
  const overview = state.overview;
  const busy = state.saving || state.pending || state.loading || state.readUnavailable;
  const inventory = useEnterprisePage(client, overview, 'inventory', { search, lowStock: lowOnly }, tab === 'inventory');
  const orderPage = useEnterprisePage(client, overview, 'orders', { search: orderSearch, ...(orderKind ? { kind: orderKind } : {}), ...(orderStatus ? { status: orderStatus } : {}) }, tab === 'orders');
  const history = useEnterprisePage(client, overview, 'audit', {}, tab === 'audit');
  const latestItem = useEnterprisePage(client, overview, 'inventory', { ...(itemEditor ? { id: itemEditor.id } : {}) }, itemEditor !== null && itemBase.existed);
  const latestOrder = useEnterprisePage(client, overview, 'orders', { ...(orderEditor ? { id: orderEditor.id } : {}) }, orderEditor !== null && orderBase.existed);
  const orderDetails = useEnterprisePage(client, overview, 'orders', { ...(viewOrderId ? { id: viewOrderId } : {}) }, viewOrderId !== null);
  const choices = useEnterprisePage(client, overview, 'inventory', { search: itemSearch }, orderEditor !== null);
  const items = inventory.page?.records ?? [];
  const orders = orderPage.page?.records ?? [];
  const submitting = submission?.order;
  const viewed = orderDetails.page?.records[0];
  const mutationDone = (command: EnterpriseCommand) => {
    setLocalError(null);
    if (command.type === 'item.upsert') { setItemEditor(null); setStatus(e.saved); }
    if (command.type === 'order.save') { setOrderEditor(null); setStatus(e.saved); }
    if (command.type === 'item.remove' || command.type === 'order.remove') { setDeleting(null); setStatus(e.deleted); }
    if (command.type === 'order.submit') { setSubmission(null); setStatus(e.submittedNotice); }
  };
  const execute = async (command: EnterpriseCommand, revision: number, generation: number) => { setLocalError(null); if (await client.execute(command, revision, generation)) mutationDone(command); };
  const inputError = (error: unknown) => setLocalError(error instanceof EnterpriseError ? error.code === 'result_too_large' ? e.resultTooLarge : t[error.code] : t.invalid_request);
  const editItem = (item: InventoryItem) => { setItemEditor({ id: item.id, sku: item.sku, name: item.name, stock: String(item.stock), reorderAt: String(item.reorderAt), supplier: item.supplier }); setItemBase({ generation: overview!.generation, revision: overview!.revision, existed: true }); setLocalError(null); setStatus(''); };
  let draftTotal: number | null = null;
  if (orderEditor) {
    try { draftTotal = enterpriseOrderTotal(toOrderInput(orderEditor)); } catch { /* Incomplete decimal inputs have no preview total. */ }
  }
  return <Panel locale={locale} state={state} client={client} title={t.erp} description={t.erpDescription}>
    <ClientBanner state={state} client={client} locale={locale} localError={localError} onRetried={mutationDone} />
    {status && <p className="cm-ent-status" role="status">{status}</p>}
    {overview && <>
      <nav className="cm-ent-tabs" aria-label={t.erp}>{(['inventory', 'orders', 'audit'] as const).map(value => <button key={value} type="button" aria-pressed={tab === value} onClick={() => { setTab(value); setLocalError(null); }}>{t[value]}</button>)}</nav>
      {deleting && <DeleteConfirmation locale={locale} busy={busy} changed={(deleting.revision !== overview.revision || deleting.generation !== overview.generation)} name={deleting.name} onCancel={() => setDeleting(null)} onDelete={() => { void execute({ type: deleting.kind === 'item' ? 'item.remove' : 'order.remove', id: deleting.id }, deleting.revision, deleting.generation); }} />}
      {tab === 'inventory' && <>
        <div className="cm-ent-counts"><div><span>{e.inventoryCount}</span><strong>{overview.counts.inventory}</strong></div><div><span>{e.lowStockCount}</span><strong>{overview.counts.lowStock}</strong></div></div>
        <div className="cm-ent-toolbar"><input type="search" aria-label={t.inventorySearch} placeholder={t.inventorySearch} value={search} onChange={event => setSearch(event.target.value)} /><label className="cm-ent-check"><input type="checkbox" checked={lowOnly} onChange={event => setLowOnly(event.target.checked)} />{e.onlyLowStock}</label>
          <button className="cm-ent-primary" type="button" disabled={busy || itemEditor !== null} onClick={() => { setItemEditor({ id: newId(), sku: '', name: '', stock: '0', reorderAt: '0', supplier: '' }); setItemBase({ generation: overview.generation, revision: overview.revision, existed: false }); setLocalError(null); setStatus(''); }}>{t.itemNew}</button>
        </div>
        <div className={`cm-ent-layout${itemEditor ? ' has-editor' : ''}`}><div>
          {items.length === 0 ? <p className="cm-ent-empty">{inventory.loading ? t.loadingData : overview.counts.inventory === 0 ? t.noInventory : e.noFiltered}</p> : <div className="cm-ent-table-wrap"><table className="cm-ent-table" aria-label={t.inventory}><thead><tr><th>{t.sku}</th><th>{t.stock}</th><th>{t.reorderAt}</th><th>{t.action}</th></tr></thead><tbody>
            {items.map(item => <tr key={item.id}><td><strong>{item.name}</strong><small>{item.sku} · {item.supplier || e.noSupplier}</small></td><td>{item.stock}<small><span className={`cm-ent-badge${item.stock <= item.reorderAt ? ' is-warning' : ''}`}>{item.stock <= item.reorderAt ? t.lowStock : t.normalStock}</span></small></td><td>{item.reorderAt}</td><td><div className="cm-ent-actions"><button type="button" disabled={busy || itemEditor !== null} onClick={() => editItem(item)}>{t.edit}</button><button className="cm-ent-danger" type="button" disabled={busy || itemEditor !== null} onClick={() => setDeleting({ kind: 'item', id: item.id, name: `${item.sku} · ${item.name}`, generation: overview.generation, revision: overview.revision })}>{t.remove}</button></div></td></tr>)}
          </tbody></table></div>}
          <PageNavigation locale={locale} view={inventory} busy={busy} />
        </div>{itemEditor && <form className="cm-ent-form" aria-label={itemBase.existed ? t.itemEdit : t.itemNew} onSubmit={async event => {
          event.preventDefault();
          let item: InventoryItemInput;
          try { item = { ...itemEditor, stock: quantityInputToInteger(itemEditor.stock, 0), reorderAt: quantityInputToInteger(itemEditor.reorderAt, 0) }; } catch (error) { inputError(error); return; }
          await execute({ type: 'item.upsert', item }, itemBase.revision, itemBase.generation);
        }}><header><h3>{itemBase.existed ? t.itemEdit : t.itemNew}</h3><button type="button" disabled={busy} onClick={() => { setItemEditor(null); setLocalError(null); }}>{t.cancel}</button></header>
          <DraftReview locale={locale} changed={(itemBase.revision !== overview.revision || itemBase.generation !== overview.generation)} busy={busy}
            loading={itemBase.existed && latestItem.loading}
            available={!itemBase.existed || (latestItem.page?.records.length ?? 0) > 0}
            onReview={() => setItemBase({ ...itemBase, generation: overview.generation, revision: overview.revision })}>
            {(latestItem.page?.records ?? []).map(item => <RecordFields key={item.id} fields={[
              [t.sku, item.sku], [t.itemName, item.name], [t.stock, String(item.stock)], [t.reorderAt, String(item.reorderAt)], [t.supplier, item.supplier || e.noSupplier],
            ]} />)}
          </DraftReview>
          <fieldset className="cm-ent-fields" disabled={busy}>
            <label className="cm-ent-field"><span>{t.sku}</span><input required maxLength={200} value={itemEditor.sku} onChange={event => setItemEditor({ ...itemEditor, sku: event.target.value })} /></label>
            <label className="cm-ent-field"><span>{t.itemName}</span><input required maxLength={200} value={itemEditor.name} onChange={event => setItemEditor({ ...itemEditor, name: event.target.value })} /></label>
            <div className="cm-ent-form-grid"><label className="cm-ent-field"><span>{t.stock}</span><input required inputMode="numeric" pattern="[0-9]+" value={itemEditor.stock} onChange={event => { setItemEditor({ ...itemEditor, stock: event.target.value }); setLocalError(null); }} /></label><label className="cm-ent-field"><span>{t.reorderAt}</span><input required inputMode="numeric" pattern="[0-9]+" value={itemEditor.reorderAt} onChange={event => { setItemEditor({ ...itemEditor, reorderAt: event.target.value }); setLocalError(null); }} /></label></div>
            <label className="cm-ent-field"><span>{t.supplier}</span><input maxLength={200} value={itemEditor.supplier} onChange={event => setItemEditor({ ...itemEditor, supplier: event.target.value })} /></label>
            <p className="cm-ent-help">{t.stockCorrection}</p><button className="cm-ent-primary" type="submit" disabled={(itemBase.revision !== overview.revision || itemBase.generation !== overview.generation)}>{state.saving ? t.saving : t.save}</button>
          </fieldset>
        </form>}</div>
      </>}
      {tab === 'orders' && <>
        <div className="cm-ent-toolbar"><input type="search" aria-label={e.orderSearch} placeholder={e.orderSearch} value={orderSearch} onChange={event => setOrderSearch(event.target.value)} />
          <select aria-label={e.orderKindFilter} value={orderKind} onChange={event => setOrderKind(event.target.value === 'purchase' ? 'purchase' : event.target.value === 'sale' ? 'sale' : '')}><option value="">{e.allOrders}</option><option value="purchase">{t.purchase}</option><option value="sale">{t.sale}</option></select>
          <select aria-label={e.orderStatusFilter} value={orderStatus} onChange={event => setOrderStatus(event.target.value === 'draft' ? 'draft' : event.target.value === 'submitted' ? 'submitted' : '')}><option value="">{e.allOrders}</option><option value="draft">{t.draft}</option><option value="submitted">{t.submitted}</option></select>
          <button className="cm-ent-primary" type="button" disabled={busy || orderEditor !== null || overview.counts.inventory === 0} onClick={() => { setOrderEditor({ id: newId(), kind: 'purchase', counterparty: '', orderDate: today(), note: '', lines: [newLine()] }); setOrderBase({ generation: overview.generation, revision: overview.revision, existed: false }); setViewOrderId(null); setLocalError(null); setStatus(''); }}>{t.orderNew}</button>
        </div>
        {overview.counts.inventory === 0 && <p className="cm-ent-banner">{e.addInventoryFirst}</p>}
        {submitting && <section className="cm-ent-banner cm-ent-confirm" aria-label={e.confirmSubmit}><h3>{e.confirmSubmit}</h3><p>{t[submitting.kind]} · {submitting.counterparty} · {money(submitting.totalMinorUnits)}</p><p>{t.submitHint}</p>{(submission!.revision !== overview.revision || submission!.generation !== overview.generation) && <p role="alert">{e.confirmationChanged}</p>}<strong>{e.submitImpact}</strong><ul className="cm-ent-impact">{submitting.lines.map(line => <li key={line.itemId}>{line.itemId} {submitting.kind === 'purchase' ? '+' : '−'}{line.quantity}</li>)}</ul><div className="cm-ent-actions"><button className="cm-ent-primary" type="button" disabled={busy || (submission!.revision !== overview.revision || submission!.generation !== overview.generation)} onClick={() => { void execute({ type: 'order.submit', id: submitting.id }, submission!.revision, submission!.generation); }}>{state.saving ? t.saving : t.submitOrder}</button><button type="button" disabled={busy} onClick={() => setSubmission(null)}>{t.cancel}</button></div></section>}
        <div className={`cm-ent-layout cm-ent-orders-layout${orderEditor ? ' has-editor' : ''}`}><div>
          {orders.length === 0 ? <p className="cm-ent-empty">{orderPage.loading ? t.loadingData : overview.counts.orders === 0 ? t.noOrders : e.noFiltered}</p> : <div className="cm-ent-table-wrap"><table className="cm-ent-table" aria-label={t.orders}><thead><tr><th>{t.orderDate}</th><th>{t.counterparty}</th><th>{t.stage}</th><th>{t.total}</th><th>{t.action}</th></tr></thead><tbody>{orders.map(order => <tr key={order.id}><td>{order.orderDate}<small>{t[order.kind]}</small></td><td><strong>{order.counterparty}</strong><small>{order.note}</small></td><td><span className={`cm-ent-badge${order.status === 'submitted' ? ' is-success' : ''}`}>{t[order.status]}</span></td><td>{money(order.totalMinorUnits)}</td><td><div className="cm-ent-actions">
            <button type="button" disabled={busy || orderEditor !== null} onClick={() => setViewOrderId(order.id)}>{t.orderDetails}</button>
            {order.status === 'draft' && <><button type="button" disabled={busy || orderEditor !== null} onClick={() => { setOrderEditor(toOrderDraft(order)); setOrderBase({ generation: overview.generation, revision: overview.revision, existed: true }); setViewOrderId(null); setLocalError(null); }}>{t.orderEdit}</button><button type="button" disabled={busy || orderEditor !== null} onClick={() => setSubmission({ order, generation: overview.generation, revision: overview.revision })}>{e.confirmSubmit}</button><button className="cm-ent-danger" type="button" disabled={busy || orderEditor !== null} onClick={() => setDeleting({ kind: 'order', id: order.id, name: `${t[order.kind]} · ${order.counterparty} · ${money(order.totalMinorUnits)}`, generation: overview.generation, revision: overview.revision })}>{t.remove}</button></>}
          </div></td></tr>)}</tbody></table></div>}
          <PageNavigation locale={locale} view={orderPage} busy={busy} />
        </div>
        {viewed && !orderEditor && <section className="cm-ent-form" aria-label={t.orderDetails}><header><h3>{t.orderDetails}</h3><button type="button" onClick={() => setViewOrderId(null)}>{t.cancel}</button></header><p>{t[viewed.kind]} · {viewed.counterparty} · {viewed.orderDate}</p><small className="cm-ent-help">{e.orderId}: {viewed.id}</small><p>{t[viewed.status]} · {money(viewed.totalMinorUnits)}</p><ul className="cm-ent-impact">{viewed.lines.map(line => <li key={line.itemId}>{line.itemId} × {line.quantity} @ {money(line.unitPriceMinorUnits)}</li>)}</ul><p>{viewed.note}</p>{viewed.status === 'submitted' && <p className="cm-ent-help">{e.viewSubmitted}</p>}</section>}
        {orderEditor && <form className="cm-ent-form" aria-label={orderBase.existed ? t.orderEdit : t.orderNew} onSubmit={async event => {
          event.preventDefault();
          if (orderEditor.lines.length === 0) { setLocalError(e.emptyOrder); return; }
          if (new Set(orderEditor.lines.map(line => line.itemId)).size !== orderEditor.lines.length) { setLocalError(e.duplicateLine); return; }
          let order: OrderInput;
          try { order = toOrderInput(orderEditor); enterpriseOrderTotal(order); } catch (error) { inputError(error); return; }
          await execute({ type: 'order.save', order }, orderBase.revision, orderBase.generation);
        }}><header><h3>{orderBase.existed ? t.orderEdit : t.orderNew}</h3><button type="button" disabled={busy} onClick={() => { setOrderEditor(null); setLocalError(null); }}>{t.cancel}</button></header><p className="cm-ent-help">{e.draftHint}</p>
          <DraftReview locale={locale} changed={(orderBase.revision !== overview.revision || orderBase.generation !== overview.generation)} busy={busy}
            loading={orderBase.existed && latestOrder.loading}
            available={!orderBase.existed || latestOrder.page?.records[0]?.status === 'draft'}
            onReview={() => setOrderBase({ ...orderBase, generation: overview.generation, revision: overview.revision })}>
            {(latestOrder.page?.records ?? []).map(order => <RecordFields key={order.id} fields={[
              [t.orders, t[order.kind]], [t.counterparty, order.counterparty], [t.orderDate, order.orderDate], [t.stage, t[order.status]],
              [t.lines, order.lines.map(line => `${line.itemId} × ${line.quantity} @ ${money(line.unitPriceMinorUnits)}`).join('; ')],
              [t.total, money(order.totalMinorUnits)], [t.note, order.note],
            ]} />)}
          </DraftReview>
          <fieldset className="cm-ent-fields" disabled={busy}><div className="cm-ent-form-grid">
            <label className="cm-ent-field"><span>{t.orders}</span><select aria-label={t.orders} value={orderEditor.kind} onChange={event => setOrderEditor({ ...orderEditor, kind: event.target.value === 'sale' ? 'sale' : 'purchase' })}><option value="purchase">{t.purchase}</option><option value="sale">{t.sale}</option></select></label>
            <label className="cm-ent-field"><span>{t.counterparty}</span><input required maxLength={200} value={orderEditor.counterparty} onChange={event => setOrderEditor({ ...orderEditor, counterparty: event.target.value })} /></label>
            <label className="cm-ent-field"><span>{t.orderDate}</span><input required type="date" value={orderEditor.orderDate} onChange={event => setOrderEditor({ ...orderEditor, orderDate: event.target.value })} /></label><label className="cm-ent-field"><span>{e.currency}</span><input value="CNY" readOnly /></label>
          </div><label className="cm-ent-field"><span>{e.itemLookup}</span><input type="search" value={itemSearch} onChange={event => setItemSearch(event.target.value)} /></label><PageNavigation locale={locale} view={choices} busy={busy} /><fieldset className="cm-ent-order-lines"><legend>{t.lines}</legend>{orderEditor.lines.map((line, index) => <div className="cm-ent-line" key={line.key}>
            <label className="cm-ent-field"><span>{e.selectLineItem}</span><select aria-label={`${e.selectLineItem} ${index + 1}`} required value={line.itemId} onChange={event => { setOrderEditor({ ...orderEditor, lines: orderEditor.lines.map(candidate => candidate.key === line.key ? { ...candidate, itemId: event.target.value } : candidate) }); setLocalError(null); }}><option value="">{t.chooseItem}</option>{line.itemId && !choices.page?.records.some(item => item.id === line.itemId) && <SelectedItemOption client={client} overview={overview} id={line.itemId} />}{(choices.page?.records ?? []).map(item => <option key={item.id} value={item.id} disabled={orderEditor.lines.some(candidate => candidate.key !== line.key && candidate.itemId === item.id)}>{item.sku} · {item.name}</option>)}</select></label>
            <label className="cm-ent-field"><span>{t.quantity}</span><input aria-label={`${e.lineQuantity} ${index + 1}`} required inputMode="numeric" pattern="[0-9]+" value={line.quantity} onChange={event => { setOrderEditor({ ...orderEditor, lines: orderEditor.lines.map(candidate => candidate.key === line.key ? { ...candidate, quantity: event.target.value } : candidate) }); setLocalError(null); }} /></label>
            <label className="cm-ent-field"><span>{t.price}</span><input aria-label={`${e.linePrice} ${index + 1}`} required inputMode="decimal" value={line.price} onChange={event => { setOrderEditor({ ...orderEditor, lines: orderEditor.lines.map(candidate => candidate.key === line.key ? { ...candidate, price: event.target.value } : candidate) }); setLocalError(null); }} /></label>
            <button type="button" onClick={() => setOrderEditor({ ...orderEditor, lines: orderEditor.lines.filter(candidate => candidate.key !== line.key) })}>{t.removeLine}</button>
          </div>)}<div><button type="button" onClick={() => setOrderEditor({ ...orderEditor, lines: [...orderEditor.lines, newLine()] })}>{t.addLine}</button></div></fieldset>
          <p className="cm-ent-help">{e.priceHint}</p><label className="cm-ent-field"><span>{t.note}</span><textarea maxLength={2000} value={orderEditor.note} onChange={event => setOrderEditor({ ...orderEditor, note: event.target.value })} /></label>
          <p className="cm-ent-order-total">{t.total}: {draftTotal === null ? '—' : money(draftTotal)}</p><button className="cm-ent-primary" type="submit" disabled={(orderBase.revision !== overview.revision || orderBase.generation !== overview.generation)}>{state.saving ? t.saving : e.saveDraft}</button>
          </fieldset>
        </form>}</div>
      </>}
      {tab === 'audit' && <>{history.loading ? <p className="cm-ent-empty">{t.loadingData}</p> : history.page?.records.length === 0 ? <p className="cm-ent-empty">{t.noAudit}</p> : <ol className="cm-ent-history">{history.page?.records.map(entry => <li key={entry.revision}><header><span className="cm-ent-badge">{t.revision} {entry.revision}</span><strong>{enterpriseActionLabel(entry.type, locale)}</strong><time dateTime={entry.at}>{new Date(entry.at).toLocaleString(locale)}</time></header><small className="cm-ent-help">{e.recordId}: {entry.entityId}</small><details><summary>{t.details}</summary><AuditDetails entry={entry} locale={locale} /></details></li>)}</ol>}<PageNavigation locale={locale} view={history} busy={busy} /></>}
    </>}
  </Panel>;
}

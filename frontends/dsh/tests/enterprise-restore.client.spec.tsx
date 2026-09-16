/** Restore interaction through the rendered CRM panel and its HTTP client. */
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CRM, ERP } from '../src/BusinessModules.tsx';
import { EnterpriseClient } from '../src/enterprise-client.ts';
import { openEnterpriseStore } from '../src/enterprise-host.ts';
import { enterpriseTransport, overviewOf } from './enterprise-transport.fixture.mjs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { enterpriseId } from '../src/enterprise-types.ts';
import { File as NodeFile } from 'node:buffer';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); for (const dispose of disposers.splice(0).reverse()) await dispose(); });

const snapshot = { generation: 0, revision: 0, contacts: [], inventory: [], orders: [], audit: [] };
const backup = { schemaVersion: 1, exportedAt: '2026-09-14T00:00:00.000Z', snapshot, auditCommands: [] };
const prepared = { token: 'prepared-token', backupSha256: 'a'.repeat(64), exportedAt: backup.exportedAt, generation: 0, revision: 0, counts: { contacts: 0, inventory: 0, orders: 0, audit: 0 } };
const restoreRequest = { token: prepared.token, backupSha256: prepared.backupSha256, confirm: true, expectedRevision: 0, expectedGeneration: 0, commandId: 'restore-command' };
const restoredReceipt = { commandId: restoreRequest.commandId, backupSha256: prepared.backupSha256, generation: 1, revision: 0 };
const backupFile = () => new NodeFile([JSON.stringify(backup)], 'enterprise.json', { type: 'application/json' });

function readResponse(path: string, current = snapshot): Response {
  if (path.includes('/query?')) {
    const search = new URL(path, 'http://localhost').searchParams;
    return Response.json({ generation: current.generation, revision: current.revision, collection: search.get('collection'),
      offset: Number(search.get('offset')), total: 0, nextOffset: null, records: [] });
  }
  return Response.json(overviewOf(current));
}

it.each([
  { Panel: CRM, create: 'New contact', field: 'Name' },
  { Panel: ERP, create: 'New item', field: 'Item name' },
])('retains but refuses a $create form opened before restore, even after further edits', async ({ Panel, create, field }) => {
  const sent: string[] = [];
  let current = snapshot;
  const client = new EnterpriseClient(async (path, init) => {
    if (init.method === 'GET') return readResponse(path, current);
    sent.push(path);
    current = { ...snapshot, generation: 1 };
    return Response.json(restoredReceipt);
  }, () => enterpriseId('restore-command'));
  render(<Panel locale="en" client={client} />);
  fireEvent.click(await screen.findByRole('button', { name: create }));
  fireEvent.change(screen.getByLabelText(field), { target: { value: 'Retained draft' } });
  await act(() => client.restore(prepared, 0, 0));
  fireEvent.change(screen.getByLabelText(field), { target: { value: 'Still retained' } });
  fireEvent.submit(screen.getByRole('form', { name: create }));
  await screen.findByText(/The database was restored after this form/);
  expect((screen.getByLabelText(field) as HTMLInputElement).value).toBe('Still retained');
  expect(sent).toEqual(['/api/clawmaster/enterprise/restore']);
});

it('requires explicit confirmation and disables a duplicate restore while saving', async () => {
  const response = Promise.withResolvers<Response>();
  const sent: unknown[] = [];
  const client = new EnterpriseClient(async (path, init) => {
    if (init.method === 'GET') return readResponse(path);
    if (path.endsWith('/prepare')) return Response.json(prepared);
    sent.push(JSON.parse(String(init.body)));
    return response.promise;
  }, () => enterpriseId('restore-command'));
  render(<CRM locale="en" client={client} />);
  await waitFor(() => expect(client.getSnapshot().overview).not.toBeNull());
  fireEvent.change(screen.getByLabelText('Restore local backup'), { target: { files: [backupFile()] } });
  const confirm = await screen.findByRole('button', { name: 'Confirm restore' });
  const preview = screen.getByRole('region', { name: 'Backup preview' });
  const paragraphs = preview.querySelectorAll('p');
  const rendered = { counts: paragraphs[0]?.textContent, checksum: paragraphs[2]?.textContent, confirmation: paragraphs[3]?.textContent,
    actions: within(preview).getAllByRole('button').map(button => button.textContent) };
  const expected = resolve('frontends/dsh/tests/expected/enterprise-backup-review.en.json');
  if (process.env.DSH_UPDATE_EXPECTED === '1') await writeFile(expected, JSON.stringify(rendered, null, 2) + '\n');
  expect(rendered).toEqual(JSON.parse(await readFile(expected, 'utf8')));
  expect(sent).toHaveLength(0);
  fireEvent.click(confirm);
  expect(confirm.hasAttribute('disabled')).toBe(true);
  expect(sent).toEqual([restoreRequest]);
  response.resolve(Response.json(restoredReceipt));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm restore' })).toBeNull());
});

it('offers the exact restore receipt query after response loss and keeps it pending through refresh', async () => {
  const requests: unknown[] = [];
  const client = new EnterpriseClient(async (path, init) => {
    if (init.method === 'GET') return readResponse(path, { ...snapshot, generation: requests.length ? 1 : 0 });
    if (path.endsWith('/prepare')) return Response.json(prepared);
    requests.push(JSON.parse(String(init.body)));
    if (requests.length === 1) throw new TypeError('connection lost');
    return Response.json(restoredReceipt);
  }, () => enterpriseId('restore-command'));
  render(<CRM locale="en" client={client} />);
  await waitFor(() => expect(client.getSnapshot().overview).not.toBeNull());
  fireEvent.change(screen.getByLabelText('Restore local backup'), { target: { files: [backupFile()] } });
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm restore' }));
  await screen.findByText(/The restore outcome is unknown. Check this restore outcome/);
  await act(() => client.refresh());
  expect(client.getSnapshot().pending).toBe(true);
  expect(screen.getByRole('button', { name: 'Confirm restore' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Check this restore outcome' }));
  await waitFor(() => expect(client.getSnapshot().pending).toBe(false));
  expect(requests).toEqual([restoreRequest, restoreRequest]);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm restore' })).toBeNull());
});

it('does not renew a selected restore confirmation when another restore repeats the revision', async () => {
  let current = snapshot;
  const confirmations: unknown[] = [];
  const client = new EnterpriseClient(async (path, init) => {
    if (init.method === 'GET') return readResponse(path, current);
    if (path.endsWith('/prepare')) return Response.json(prepared);
    confirmations.push(JSON.parse(String(init.body)));
    return Response.json({ error: { code: 'revision_conflict', message: 'Generation changed.' } }, { status: 409 });
  }, () => enterpriseId('restore-command'));
  render(<CRM locale="en" client={client} />);
  await waitFor(() => expect(client.getSnapshot().overview).not.toBeNull());
  fireEvent.change(screen.getByLabelText('Restore local backup'), { target: { files: [backupFile()] } });
  const confirm = await screen.findByRole('button', { name: 'Confirm restore' });
  current = { ...snapshot, generation: 1 };
  await act(() => client.refresh());
  fireEvent.click(confirm);
  await waitFor(() => expect(client.getSnapshot().error).toBe('revision_conflict'));
  expect(confirmations).toEqual([restoreRequest]);
});

it('uploads a real file for server review and restores only after confirmation through the worker routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'enterprise-backup-ui-'));
  const store = await openEnterpriseStore(join(root, 'enterprise.sqlite'));
  const transport = await enterpriseTransport(store);
  disposers.push(async () => { await transport.dispose(); store.close(); await rm(root, { recursive: true, force: true }); });
  const contact = { id: enterpriseId('file-contact'), name: 'Backup contact', company: '', stage: 'lead', nextAction: '', nextActionDate: null };
  store.executeReceipt({ generation: 0, revision: 0, commandId: enterpriseId('seed-backup'), command: { type: 'contact.upsert', contact } });
  const file = new NodeFile([JSON.stringify(store.backup())], 'records.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => { throw new Error('The browser must not parse the file.'); } });
  store.executeReceipt({ generation: 0, revision: 1, commandId: enterpriseId('later-contact'), command: { type: 'contact.upsert', contact: { ...contact, name: 'Current contact' } } });
  const sent: string[] = [];
  const preparedResponse = Promise.withResolvers<void>();
  const restoredResponse = Promise.withResolvers<void>();
  const client = new EnterpriseClient(async (path, init) => {
    sent.push(path);
    try { return await transport.fetch(path, init); }
    finally {
      if (path.endsWith('/prepare')) preparedResponse.resolve();
      if (path.endsWith('/restore')) restoredResponse.resolve();
    }
  });
  render(<CRM locale="en" client={client} />);
  await screen.findByText('Current contact');
  fireEvent.change(screen.getByLabelText('Restore local backup'), { target: { files: [file] } });
  await act(() => preparedResponse.promise);
  const preview = await screen.findByRole('region', { name: 'Backup preview' });
  expect(preview.textContent).toContain('Contacts: 1');
  expect(preview.textContent).toContain('File checksum:');
  expect(store.overview().generation).toBe(0);
  expect(sent.filter(path => path.endsWith('/restore'))).toHaveLength(0);
  fireEvent.click(within(preview).getByRole('button', { name: 'Confirm restore' }));
  await act(() => restoredResponse.promise);
  await screen.findByText('Backup contact');
  expect(store.overview().generation).toBe(1);
  expect(store.overview().revision).toBe(1);
  expect(sent.filter(path => path.endsWith('/restore'))).toHaveLength(1);
}, 15000);

it('cancels an active file import through the visible abort control without reading the file contents', async () => {
  let signal: AbortSignal | undefined;
  const file = backupFile();
  Object.defineProperty(file, 'text', { value: () => { throw new Error('No browser parsing.'); } });
  const client = new EnterpriseClient(async (path, init) => {
    if (init.method === 'GET') return readResponse(path);
    expect(init.body).toBe(file);
    signal = init.signal!;
    return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
  });
  render(<CRM locale="en" client={client} />);
  await screen.findByRole('button', { name: 'New contact' });
  fireEvent.change(screen.getByLabelText('Restore local backup'), { target: { files: [file] } });
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel current operation' }));
  await waitFor(() => expect(client.getSnapshot().saving).toBe(false));
  expect(signal?.aborted).toBe(true);
  expect(client.getSnapshot().pending).toBe(false);
  expect(screen.queryByRole('region', { name: 'Backup preview' })).toBeNull();
});

it('cancelling a restore keeps the exact original request available from the visible outcome check', async () => {
  const requests: unknown[] = [];
  const client = new EnterpriseClient(async (path, init) => {
    if (init.method === 'GET') return readResponse(path);
    if (path.endsWith('/prepare')) return Response.json(prepared);
    requests.push(JSON.parse(String(init.body)));
    if (requests.length > 1) return Response.json(restoredReceipt);
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
  }, () => enterpriseId('restore-command'));
  render(<CRM locale="en" client={client} />);
  await screen.findByRole('button', { name: 'New contact' });
  fireEvent.change(screen.getByLabelText('Restore local backup'), { target: { files: [backupFile()] } });
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm restore' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel current operation' }));
  await waitFor(() => expect(client.getSnapshot().saving).toBe(false));
  expect(client.getSnapshot().pending).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Check this restore outcome' }));
  await waitFor(() => expect(client.getSnapshot().pending).toBe(false));
  expect(requests).toEqual([restoreRequest, restoreRequest]);
});

async function pagedFixture() {
  const store = await openEnterpriseStore(':memory:', 5000, 'local', {}, { maxPageRows: 2 });
  const transport = await enterpriseTransport(store);
  disposers.push(async () => { await transport.dispose(); store.close(); });
  const requested: string[] = [];
  const client = new EnterpriseClient(async (path, init) => { requested.push(path); return transport.fetch(path, init); });
  const write = (command: unknown) => store.executeReceipt({ generation: store.overview().generation, revision: store.overview().revision, commandId: crypto.randomUUID(), command });
  for (let index = 0; index < 4; index++) {
    write({ type: 'contact.upsert', contact: { id: `contact-${index}`, name: `Contact ${index}`, company: '', stage: 'lead', nextAction: '', nextActionDate: null } });
    write({ type: 'item.upsert', item: { id: `item-${index}`, sku: `SKU-${index}`, name: `Item ${index}`, stock: 5, reorderAt: 1, supplier: '' } });
  }
  return { store, client, requested, write };
}

it('CRM replaces each server page and reviews an edited contact by id even after it leaves the filtered page', async () => {
  const f = await pagedFixture();
  render(<CRM locale="en" client={f.client} />);
  await screen.findByText('Contact 0');
  const firstPage = within(screen.getByRole('table', { name: 'CRM contacts' })).getAllByRole('row').slice(1).map(row => row.textContent);
  expect(screen.queryByText('Contact 2')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  const third = await screen.findByText('Contact 2');
  const secondPage = within(screen.getByRole('table', { name: 'CRM contacts' })).getAllByRole('row').slice(1).map(row => row.textContent);
  const navigation = screen.getByLabelText('Record pages').textContent;
  expect(screen.queryByText('Contact 0')).toBeNull();
  expect(within(screen.getByRole('table', { name: 'CRM contacts' })).getAllByRole('row')).toHaveLength(3);
  fireEvent.click(within(third.closest('tr')!).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Next action'), { target: { value: 'Retained off-page draft' } });
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Contact 0' } });
  await screen.findByText('Contact 0');
  expect(screen.getByRole('form', { name: 'Edit contact' })).toBeDefined();
  const original = f.store.snapshot().contacts.find(contact => contact.id === 'contact-2')!;
  f.write({ type: 'contact.upsert', contact: { id: original.id, name: original.name, company: 'Latest off-page company', stage: original.stage, nextAction: '', nextActionDate: null } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh', exact: true }));
  const review = await screen.findByRole('region', { name: 'Latest record' });
  await within(review).findByText('Latest off-page company');
  const rendered = { firstPage, secondPage, navigation, latest: review.textContent, retained: (screen.getByLabelText('Next action') as HTMLTextAreaElement).value };
  const expected = resolve('frontends/dsh/tests/expected/enterprise-pages.en.json');
  if (process.env.DSH_UPDATE_EXPECTED === '1') await writeFile(expected, JSON.stringify(rendered, null, 2) + '\n');
  expect(rendered).toEqual(JSON.parse(await readFile(expected, 'utf8')));
  expect((screen.getByLabelText('Next action') as HTMLTextAreaElement).value).toBe('Retained off-page draft');
  expect((screen.getByRole('button', { name: 'Save', exact: true }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(review).getByRole('button', { name: 'Reviewed latest record; keep my draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await screen.findByText('Saved to the local workbench.');
  expect(f.store.snapshot().contacts.find(contact => contact.id === 'contact-2')?.nextAction).toBe('Retained off-page draft');
  expect(f.requested.some(path => path.includes('id=contact-2'))).toBe(true);
  expect(f.requested.some(path => path.includes('search=Contact+0'))).toBe(true);
});

it('an order can select a searched off-page SKU and retain it when the candidate page changes', async () => {
  const f = await pagedFixture();
  render(<ERP locale="en" client={f.client} />);
  await screen.findByText('Item 0');
  fireEvent.click(screen.getByRole('button', { name: 'Orders', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'New order' }));
  const form = screen.getByRole('form', { name: 'New order' });
  fireEvent.change(within(form).getByLabelText('Customer / supplier'), { target: { value: 'Paged customer' } });
  fireEvent.change(within(form).getByLabelText('Search available items'), { target: { value: 'SKU-3' } });
  await within(form).findByRole('option', { name: 'SKU-3 · Item 3' });
  fireEvent.change(within(form).getByLabelText('Order item 1'), { target: { value: 'item-3' } });
  fireEvent.change(within(form).getByLabelText('Search available items'), { target: { value: 'SKU-0' } });
  await within(form).findByRole('option', { name: 'SKU-0 · Item 0' });
  await within(form).findByRole('option', { name: 'SKU-3 · Item 3' });
  expect((within(form).getByLabelText('Order item 1') as HTMLSelectElement).value).toBe('item-3');
  fireEvent.click(within(form).getByRole('button', { name: 'Save draft' }));
  await screen.findByText('Saved to the local workbench.');
  expect(f.store.snapshot().orders[0]?.lines[0]?.itemId).toBe('item-3');
  expect(f.requested.some(path => path.includes('id=item-3'))).toBe(true);
});

it('the audit tab fetches and replaces bounded history pages without accumulating earlier records', async () => {
  const f = await pagedFixture();
  render(<ERP locale="en" client={f.client} />);
  await screen.findByText('Item 0');
  fireEvent.click(screen.getByRole('button', { name: 'Change history', exact: true }));
  await screen.findByText('Revision 8');
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  await screen.findByText('Revision 6');
  expect(screen.queryByText('Revision 8')).toBeNull();
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(f.requested.some(path => path.includes('collection=audit') && path.includes('offset=2') && path.includes('revision=8'))).toBe(true);
});

it('failed page reads retain draft inputs but disable writes until an authoritative refresh succeeds', async () => {
  const f = await pagedFixture();
  const transport = await enterpriseTransport(f.store);
  disposers.push(transport.dispose);
  let failPage = false;
  const client = new EnterpriseClient(async (path, init) => path.includes('/query?') && failPage
    ? Response.json({ error: { code: 'storage_unavailable', message: 'Temporary read failure.' } }, { status: 503 })
    : transport.fetch(path, init));
  render(<CRM locale="en" client={client} />);
  const first = await screen.findByText('Contact 0');
  fireEvent.click(within(first.closest('tr')!).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Next action'), { target: { value: 'Draft survives read failure' } });
  failPage = true;
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Contact 3' } });
  await waitFor(() => expect(client.getSnapshot().readUnavailable).toBe(true));
  const input = screen.getByLabelText('Next action') as HTMLTextAreaElement;
  expect(input.value).toBe('Draft survives read failure');
  expect(input.closest('fieldset')!.disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'New contact' }) as HTMLButtonElement).disabled).toBe(true);
  failPage = false;
  await act(() => client.refresh());
  await screen.findByText('Contact 3');
  expect(input.closest('fieldset')!.disabled).toBe(false);
  expect(input.value).toBe('Draft survives read failure');
});

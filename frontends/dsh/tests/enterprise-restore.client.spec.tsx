/** Restore interaction through the rendered CRM panel and its HTTP client. */
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CRM, ERP } from '../src/BusinessModules.tsx';
import { EnterpriseClient } from '../src/enterprise-client.ts';

afterEach(cleanup);

const snapshot = { generation: 0, revision: 0, contacts: [], inventory: [], orders: [], audit: [] };
const backup = { schemaVersion: 1, exportedAt: '2026-09-14T00:00:00.000Z', snapshot, auditCommands: [] };

it.each([
  { Panel: CRM, create: 'New contact', field: 'Name' },
  { Panel: ERP, create: 'New item', field: 'Item name' },
])('retains but refuses a $create form opened before restore, even after further edits', async ({ Panel, create, field }) => {
  const sent: string[] = [];
  const client = new EnterpriseClient(async (path, init) => {
    if (init.method === 'GET') return Response.json(snapshot);
    sent.push(path);
    return Response.json({ ...snapshot, generation: 1 });
  });
  render(<Panel locale="en" client={client} />);
  fireEvent.click(await screen.findByRole('button', { name: create }));
  fireEvent.change(screen.getByLabelText(field), { target: { value: 'Retained draft' } });
  await act(() => client.restore(backup, 0, 0));
  fireEvent.change(screen.getByLabelText(field), { target: { value: 'Still retained' } });
  fireEvent.submit(screen.getByRole('form', { name: create }));
  await screen.findByText(/The database was restored after this form/);
  expect((screen.getByLabelText(field) as HTMLInputElement).value).toBe('Still retained');
  expect(sent).toEqual(['/api/clawmaster/enterprise/restore']);
});

it('requires explicit confirmation and disables a duplicate restore while saving', async () => {
  const response = Promise.withResolvers<Response>();
  const sent: unknown[] = [];
  const client = new EnterpriseClient(async (_path, init) => {
    if (init.method === 'GET') return Response.json(snapshot);
    sent.push(JSON.parse(String(init.body)));
    return response.promise;
  });
  render(<CRM locale="en" client={client} />);
  await waitFor(() => expect(client.getSnapshot().snapshot).not.toBeNull());
  fireEvent.change(screen.getByLabelText('Restore local backup'), { target: { files: [{ text: async () => JSON.stringify(backup) }] } });
  const confirm = await screen.findByRole('button', { name: 'Confirm restore' });
  expect(sent).toHaveLength(0);
  fireEvent.click(confirm);
  expect(confirm.hasAttribute('disabled')).toBe(true);
  expect(sent).toEqual([{ confirm: true, expectedRevision: 0, expectedGeneration: 0, backup }]);
  response.resolve(Response.json({ ...snapshot, generation: 1 }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm restore' })).toBeNull());
});

it('offers refresh instead of command replay after an uncertain restore', async () => {
  const client = new EnterpriseClient(async (_path, init) => {
    if (init.method === 'GET') return Response.json(snapshot);
    throw new TypeError('connection lost');
  });
  render(<CRM locale="en" client={client} />);
  await waitFor(() => expect(client.getSnapshot().snapshot).not.toBeNull());
  fireEvent.change(screen.getByLabelText('Restore local backup'), { target: { files: [{ text: async () => JSON.stringify(backup) }] } });
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm restore' }));
  await screen.findByText('The restore outcome is unknown. Refresh and review the current records before continuing.');
  expect(screen.queryByRole('button', { name: 'Retry the same request' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Confirm restore' }).hasAttribute('disabled')).toBe(true);
});

it('does not renew a selected restore confirmation when another restore repeats the revision', async () => {
  let current = snapshot;
  const confirmations: unknown[] = [];
  const client = new EnterpriseClient(async (_path, init) => {
    if (init.method === 'GET') return Response.json(current);
    confirmations.push(JSON.parse(String(init.body)));
    return Response.json({ error: { code: 'revision_conflict', message: 'Generation changed.' } }, { status: 409 });
  });
  render(<CRM locale="en" client={client} />);
  await waitFor(() => expect(client.getSnapshot().snapshot).not.toBeNull());
  fireEvent.change(screen.getByLabelText('Restore local backup'), { target: { files: [{ text: async () => JSON.stringify(backup) }] } });
  const confirm = await screen.findByRole('button', { name: 'Confirm restore' });
  current = { ...snapshot, generation: 1 };
  await act(() => client.refresh());
  fireEvent.click(confirm);
  await waitFor(() => expect(client.getSnapshot().error).toBe('revision_conflict'));
  expect(confirmations).toEqual([{ confirm: true, expectedRevision: 0, expectedGeneration: 0, backup }]);
});

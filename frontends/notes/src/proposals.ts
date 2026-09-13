/**
 * Pending note proposals: agent-authored drafts the user reviews before they touch a note.
 * Proposals live under the vault's ignored metadata directory, so they are never listed as
 * notes and never visible to an external editor browsing the vault.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { VaultError, assertWritableNoteId, type Vault } from './vault.ts';
import { proposalIdSchema } from './protocol.ts';

/** Vault-relative directory holding pending proposals. */
export const PROPOSAL_DIRECTORY = '.clawmaster/proposals';

const proposalSchema = z.object({
  proposalId: proposalIdSchema,
  /** Target note id; may not exist yet. */
  id: z.string().min(1),
  /** Proposed full content. */
  text: z.string(),
  /** Revision the proposal was based on; null means "create a new note". */
  baseRevision: z.string().nullable(),
  createdAt: z.string(),
}).strict();

/** One stored proposal. */
export type Proposal = z.output<typeof proposalSchema>;

/** Read and write proposals for one vault. */
export class ProposalStore {
  constructor(private readonly vault: Vault, private readonly maxReadBytes: number) {}

  private get directory(): string {
    return join(this.vault.root, PROPOSAL_DIRECTORY);
  }

  private path(proposalId: string): string {
    return join(this.directory, `${proposalIdSchema.parse(proposalId)}.json`);
  }

  /** Store a proposal against the note's current revision. */
  async create(id: string, text: string, now: Date = new Date()): Promise<Proposal> {
    const safe = assertWritableNoteId(id);
    let baseRevision: string | null = null;
    try {
      baseRevision = (await this.vault.read(safe, this.maxReadBytes)).revision;
    } catch (error) {
      if (!(error instanceof VaultError) || error.code !== 'not_found') throw error;
    }
    const proposal: Proposal = {
      proposalId: randomUUID(), id: safe, text, baseRevision, createdAt: now.toISOString(),
    };
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.path(proposal.proposalId), `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
    return proposal;
  }

  /** Every pending proposal, oldest first. */
  async list(): Promise<Proposal[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch { return []; }
    const proposals: Proposal[] = [];
    for (const name of names.filter(name => name.endsWith('.json')).sort()) {
      try { proposals.push(proposalSchema.parse(JSON.parse(await readFile(join(this.directory, name), 'utf8')))); }
      catch { /* an unreadable proposal must not hide the readable ones */ }
    }
    return proposals;
  }

  /** Read one proposal. */
  async read(proposalId: string): Promise<Proposal> {
    try {
      return proposalSchema.parse(JSON.parse(await readFile(this.path(proposalId), 'utf8')));
    } catch (error) {
      if (error instanceof z.ZodError) throw new VaultError('storage_unavailable', 'The stored proposal is not readable.');
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new VaultError('not_found', `Proposal ${proposalId} does not exist.`);
      }
      throw error;
    }
  }

  /** Remove one proposal; missing proposals are not an error for a discard. */
  async remove(proposalId: string): Promise<void> {
    await rm(this.path(proposalId), { force: true });
  }
}

/**
 * Pending note proposals: agent-authored drafts the user reviews before they touch a note.
 * Proposals use the vault's checked, bounded metadata IO and atomic no-replace publication.
 * They are excluded from the note index; external filesystem access can still inspect them.
 */
import { randomUUID } from 'node:crypto';
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
  baseRevision: z.string().regex(/^sha256-[0-9a-f]{64}$/).nullable(),
  createdAt: z.string().datetime(),
}).strict();

/** One stored proposal. */
export type Proposal = z.output<typeof proposalSchema>;

/** Read and write proposals for one vault. */
export class ProposalStore {
  constructor(private readonly vault: Vault, private readonly maxReadBytes: number, private readonly maxEntries: number) {}

  private filename(proposalId: string): string {
    return `${proposalIdSchema.parse(proposalId)}.json`;
  }

  /** Store a proposal against the note's current revision. */
  async create(id: string, text: string, now: Date = new Date()): Promise<Proposal> {
    const safe = assertWritableNoteId(id);
    if (Buffer.byteLength(text, 'utf8') > this.maxReadBytes) throw new VaultError('invalid_request', `Proposal exceeds the ${this.maxReadBytes} byte limit.`);
    let baseRevision: string | null = null;
    try {
      baseRevision = (await this.vault.read(safe, this.maxReadBytes)).revision;
    } catch (error) {
      if (!(error instanceof VaultError) || error.code !== 'not_found') throw error;
    }
    const proposal: Proposal = {
      proposalId: randomUUID(), id: safe, text, baseRevision, createdAt: now.toISOString(),
    };
    await this.vault.createMetadata('proposals', this.filename(proposal.proposalId), `${JSON.stringify(proposal, null, 2)}\n`, this.maxReadBytes);
    return proposal;
  }

  /** Pending proposals, oldest first, under one entry limit and aggregate JSON byte budget. */
  async list(): Promise<Proposal[]> {
    const names = await this.vault.listMetadata('proposals', this.maxEntries);
    const proposals: Proposal[] = [];
    let remaining = this.maxReadBytes;
    for (const name of names) {
      try {
        const record = await this.readRecord(name.slice(0, -'.json'.length), remaining);
        proposals.push(record.proposal);
        remaining -= record.bytes;
      } catch (error) {
        // A concurrent discard may remove a listed file; unsafe or corrupt files still fail.
        if (!(error instanceof VaultError) || error.code !== 'not_found') throw error;
      }
    }
    return proposals.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.proposalId.localeCompare(right.proposalId));
  }

  /** Read one proposal. */
  async read(proposalId: string): Promise<Proposal> {
    return (await this.readRecord(proposalId, this.maxReadBytes)).proposal;
  }

  private async readRecord(proposalId: string, maxBytes: number): Promise<{ proposal: Proposal; bytes: number }> {
    const name = this.filename(proposalId);
    const { text } = await this.vault.readMetadata('proposals', name, maxBytes);
    try {
      const proposal = proposalSchema.parse(JSON.parse(text));
      assertWritableNoteId(proposal.id);
      if (proposal.proposalId !== proposalId) throw new VaultError('storage_unavailable', 'The stored proposal identity does not match its filename.');
      return { proposal, bytes: Buffer.byteLength(text, 'utf8') };
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) throw new VaultError('storage_unavailable', 'The stored proposal is not readable.');
      throw error;
    }
  }

  /** Remove one proposal; missing proposals are not an error for a discard. */
  async remove(proposalId: string): Promise<void> {
    await this.vault.removeMetadata('proposals', this.filename(proposalId));
  }
}

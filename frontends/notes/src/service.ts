/** Notes application service: the query and command surface shared by the Fetch routes and the agent tools. */
import {
  Vault, VaultError, noteTitle, parseFrontmatter, type NoteMatch as VaultMatch, type VaultEntry,
} from './vault.ts';
import {
  noteCommandSchema, type NoteCommand, type NoteRead, type NoteReceipt, type NotesSearch, type NotesTree,
} from './protocol.ts';
import { unifiedDiff, type UnifiedDiff } from './diff.ts';
import { ProposalStore, type Proposal } from './proposals.ts';

/** Directory that holds one note per day. */
export const DAILY_DIRECTORY = '日记';

/** Deployment bounds for one model-visible or browser-visible page. */
export interface NotesLimits {
  /** Maximum UTF-8 bytes per note read or combined proposal diff inputs; excess fails explicitly. */
  maxReadBytes: number;
  /** Default and hard maximum number of search hits. */
  maxSearchResults: number;
  /** Hard maximum number of notes in one tree listing. */
  maxTreeEntries: number;
}

export const DEFAULT_LIMITS: NotesLimits = { maxReadBytes: 262144, maxSearchResults: 50, maxTreeEntries: 5000 };

/** Today's date in local time, as `YYYY-MM-DD`. */
export function localDate(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The note id and head template for one day. */
export function dailyNote(date: string): { id: string; header: string } {
  return {
    id: `${DAILY_DIRECTORY}/${date}.md`,
    header: `---\ntitle: ${date}\ndate: ${date}\ntags: [日记]\ntype: 日记\n---\n\n# ${date}\n`,
  };
}

/** One work entry the agent composed out of what it just did. */
export interface DigestEntry {
  /** Local date `YYYY-MM-DD`; defaults to today. */
  date?: string | undefined;
  /** Local time `HH:MM`; defaults to now. */
  time?: string | undefined;
  /** Project name, linked to its note when one matches. */
  project?: string | undefined;
  /** What was done. */
  summary: string;
  /** Decisions taken. */
  decisions?: string[] | undefined;
  /** Evidence a reader can check. */
  evidence?: string[] | undefined;
  /** What happens next. */
  nextSteps?: string[] | undefined;
}

/** Compose one daily work entry; `link` is the resolved project note id when one exists. */
export function composeDigest(entry: DigestEntry, link?: string | undefined, now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const time = entry.time ?? `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const heading = entry.project === undefined
    ? `### ${time}`
    : `### ${time} · ${link === undefined ? entry.project : `[[${link}]]`}`;
  const sections: string[] = [heading, '', entry.summary.trim()];
  const list = (title: string, items: string[] | undefined): void => {
    const kept = (items ?? []).map(item => item.trim()).filter(item => item !== '');
    if (kept.length === 0) return;
    sections.push('', `**${title}**`, ...kept.map(item => `- ${item}`));
  };
  list('决定', entry.decisions);
  list('证据', entry.evidence);
  list('下一步', entry.nextSteps);
  return sections.join('\n');
}

/** Read, search and mutate one vault under explicit bounds. */
export class NotesService {
  /** Pending proposals for this vault. */
  readonly proposals: ProposalStore;

  constructor(readonly vault: Vault, readonly limits: NotesLimits = DEFAULT_LIMITS) {
    this.proposals = new ProposalStore(vault, limits.maxReadBytes, limits.maxTreeEntries);
  }

  /**
   * Draft a change without touching any note.
   * The proposal records the revision it was based on, so applying it later can detect drift.
   */
  async propose(id: string, text: string): Promise<{ proposal: Proposal; diff: UnifiedDiff }> {
    const proposal = await this.proposals.create(id, text);
    return { proposal, diff: unifiedDiff(await this.before(proposal), text) };
  }

  /** Every pending proposal with the diff it would apply. */
  async pendingProposals(): Promise<Array<{ proposal: Proposal; diff: UnifiedDiff }>> {
    const pending = await this.proposals.list();
    const entries: Array<{ proposal: Proposal; diff: UnifiedDiff }> = [];
    let remaining = this.limits.maxReadBytes;
    for (const proposal of pending) {
      remaining -= Buffer.byteLength(proposal.text, 'utf8');
      if (remaining < 0) throw new VaultError('invalid_request', 'Pending proposal diff inputs exceed the configured byte limit.');
      const before = await this.before(proposal, remaining);
      remaining -= Buffer.byteLength(before, 'utf8');
      entries.push({ proposal, diff: unifiedDiff(before, proposal.text) });
    }
    return entries;
  }

  /** Apply a proposal, refusing when its note moved since the proposal was drafted. */
  async applyProposal(proposalId: string): Promise<NoteReceipt & { proposalId: string }> {
    const proposal = await this.proposals.read(proposalId);
    const receipt: NoteReceipt = proposal.baseRevision === null
      ? { action: 'apply-proposal', id: proposal.id, revision: await this.vault.create(proposal.id, proposal.text), previousRevision: null }
      : {
        action: 'apply-proposal',
        id: proposal.id,
        revision: await this.vault.save(proposal.id, proposal.text, proposal.baseRevision),
        previousRevision: proposal.baseRevision,
      };
    await this.proposals.remove(proposalId);
    return { ...receipt, proposalId };
  }

  /** Drop a proposal without touching the note. */
  async discardProposal(proposalId: string): Promise<{ proposalId: string; id: string }> {
    const proposal = await this.proposals.read(proposalId);
    await this.proposals.remove(proposalId);
    return { proposalId, id: proposal.id };
  }

  /** Append one composed work entry to the daily note, linking a matching project note. */
  async digest(entry: DigestEntry): Promise<{ id: string; markdown: string; revision: string; previousRevision: string | null }> {
    const date = entry.date ?? localDate();
    const { id, header } = dailyNote(date);
    const link = entry.project === undefined ? undefined : await this.projectLink(entry.project);
    const markdown = composeDigest(entry, link);
    const change = await this.vault.appendOrCreate(id, `${markdown}\n`, `${header}\n`, this.limits.maxReadBytes);
    return { id, markdown, ...change };
  }

  private async before(proposal: Proposal, maxReadBytes: number = this.limits.maxReadBytes): Promise<string> {
    if (proposal.baseRevision === null) return '';
    try { return (await this.vault.read(proposal.id, maxReadBytes)).text; }
    catch (error) {
      if (error instanceof VaultError && error.code === 'not_found') return '';
      throw error;
    }
  }

  private async projectLink(project: string): Promise<string | undefined> {
    const wanted = project.replace(/\.md$/, '').toLowerCase();
    for (const entry of await this.vault.list(this.limits)) {
      const bare = entry.id.replace(/\.md$/, '');
      if (bare.toLowerCase() === wanted || (bare.split('/').pop() ?? '').toLowerCase() === wanted) return bare;
    }
    return undefined;
  }

  /** Every note, bounded so one huge vault cannot exhaust a model request. */
  async tree(): Promise<NotesTree> {
    const notes = await this.vault.list(this.limits);
    return { vault: this.vault.root, notes };
  }

  /** One note with its revision and link facts, bounded by the read budget. */
  async read(id: string): Promise<NoteRead> {
    const note = await this.vault.read(id, this.limits.maxReadBytes);
    return {
      id: note.id, title: note.title, text: note.text, revision: note.revision,
      links: note.links, embeds: note.embeds, tags: note.tags,
    };
  }

  /** Case-insensitive search bounded by the configured hit limit. */
  async search(query: string, limit?: number): Promise<NotesSearch> {
    const requested = limit ?? this.limits.maxSearchResults;
    if (!Number.isInteger(requested) || requested < 1) throw new VaultError('invalid_request', 'Search limit must be a positive integer.');
    const effective = Math.min(requested, this.limits.maxSearchResults);
    const matches = await this.vault.search(query, effective, this.limits);
    return { query, matches };
  }

  /** Notes linking to the given note. */
  async backlinks(id: string): Promise<VaultEntry[]> {
    return this.vault.backlinks(id, this.limits);
  }

  /** Every tag in the vault with its note count. */
  async tags(): Promise<Array<{ tag: string; count: number }>> {
    const counts = new Map<string, number>();
    for (const entry of await this.vault.list(this.limits)) {
      const { tags } = await this.vault.read(entry.id, this.limits.maxReadBytes);
      for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts].map(([tag, count]) => ({ tag, count }))
      .sort((left, right) => right.count - left.count || (left.tag < right.tag ? -1 : 1));
  }

  /** Apply one command and report the revisions a caller needs to audit or undo it. */
  async execute(value: unknown): Promise<NoteReceipt> {
    const command: NoteCommand = noteCommandSchema.parse(value);
    switch (command.action) {
      case 'create': {
        const revision = await this.vault.create(command.id, command.text);
        return { action: command.action, id: command.id, revision, previousRevision: null };
      }
      case 'save': {
        const revision = await this.vault.save(command.id, command.text, command.expectedRevision);
        return { action: command.action, id: command.id, revision, previousRevision: command.expectedRevision };
      }
      case 'append': {
        const change = await this.vault.append(command.id, command.text, this.limits.maxReadBytes);
        return { action: command.action, id: command.id, ...change };
      }
      case 'daily': {
        const date = command.date ?? localDate();
        const { id, header } = dailyNote(date);
        const entry = command.text.trim();
        // An empty entry is how the UI opens today's note without writing anything to it.
        if (entry === '') {
          try {
            const current = await this.read(id);
            return { action: command.action, id, revision: current.revision, previousRevision: current.revision };
          } catch (error) {
            if (!(error instanceof VaultError) || error.code !== 'not_found') throw error;
          }
          const revision = await this.vault.create(id, `${header}\n`);
          return { action: command.action, id, revision, previousRevision: null };
        }
        const change = await this.vault.appendOrCreate(id, `${entry}\n`, `${header}\n`, this.limits.maxReadBytes);
        return { action: command.action, id, ...change };
      }
      case 'rename': {
        const revision = await this.vault.rename(command.id, command.to);
        return { action: command.action, id: command.to, revision, previousRevision: revision };
      }
      case 'delete': {
        const revision = await this.vault.remove(command.id);
        return { action: command.action, id: command.id, revision: null, previousRevision: revision };
      }
      case 'apply-proposal': return this.applyProposal(command.proposalId);
      case 'discard-proposal': {
        const dropped = await this.discardProposal(command.proposalId);
        return { action: command.action, id: dropped.id, revision: null, previousRevision: null };
      }
    }
  }

}

/** A short, model-readable diff summary used as the approval reason for a mutation. */
export function commandSummary(command: NoteCommand, vaultRoot: string): string {
  const where = `vault ${vaultRoot}`;
  switch (command.action) {
    case 'create': return `Create note ${command.id} in ${where} (${Buffer.byteLength(command.text, 'utf8')} bytes).`;
    case 'save': return `Replace note ${command.id} in ${where} at revision ${command.expectedRevision} (${Buffer.byteLength(command.text, 'utf8')} bytes). The previous content is not recoverable from this tool.`;
    case 'append': return `Append ${Buffer.byteLength(command.text, 'utf8')} bytes to note ${command.id} in ${where}.`;
    case 'daily': return `Append today's work entry to the daily note in ${where}.`;
    case 'rename': return `Rename note ${command.id} to ${command.to} in ${where}.`;
    case 'delete': return `Delete note ${command.id} in ${where}. The note is not moved to a trash folder.`;
    case 'apply-proposal': return `Apply the stored proposal ${command.proposalId} in ${where}. The note is written only if it still matches the revision the proposal was based on.`;
    case 'discard-proposal': return `Discard the stored proposal ${command.proposalId} in ${where}. No note changes; the proposal text is deleted.`;
  }
}

export { VaultError };
export type { VaultEntry, VaultMatch };
export { noteTitle, parseFrontmatter };

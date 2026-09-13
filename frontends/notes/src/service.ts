/** Notes application service: the query and command surface shared by the Fetch routes and the agent tools. */
import {
  Vault, VaultError, noteTitle, parseFrontmatter, type NoteMatch as VaultMatch, type VaultEntry,
} from './vault.ts';
import {
  noteCommandSchema, type NoteCommand, type NoteRead, type NoteReceipt, type NotesSearch, type NotesTree,
} from './protocol.ts';

/** Directory that holds one note per day. */
export const DAILY_DIRECTORY = '日记';

/** Deployment bounds for one model-visible or browser-visible page. */
export interface NotesLimits {
  /** Maximum UTF-8 bytes returned by one read; larger notes fail explicitly. */
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

/** Read, search and mutate one vault under explicit bounds. */
export class NotesService {
  constructor(readonly vault: Vault, readonly limits: NotesLimits = DEFAULT_LIMITS) {}

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
        const change = await this.vault.appendOrCreate(id, `${command.text}\n`, `${header}\n`, this.limits.maxReadBytes);
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
  }
}

export { VaultError };
export type { VaultEntry, VaultMatch };
export { noteTitle, parseFrontmatter };

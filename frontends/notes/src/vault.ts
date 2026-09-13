/**
 * Notes vault core: path policy, revisioned note IO, frontmatter and link extraction.
 * Owns no Session, listener or index; callers supply an absolute vault root.
 */
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, opendir, realpath, rm, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { extractLinks, noteTitle, parseFrontmatter } from './note-format.ts';

/** Failure codes the route and tool layers map onto HTTP status and model errors. */
export type VaultErrorCode = 'invalid_path' | 'invalid_request' | 'not_found' | 'conflict' | 'storage_unavailable';

/** One rejected vault operation; `currentRevision` accompanies conflicts. */
export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode, message: string, readonly currentRevision?: string) {
    super(message);
    this.name = 'VaultError';
  }
}

/** Extensions the vault addresses. */
export const NOTE_EXTENSIONS = ['.md', '.canvas'] as const;
/** Extensions a writer may create or overwrite; canvases stay read-only in this version. */
export const WRITABLE_EXTENSIONS = ['.md'] as const;
/** Directories never listed, read or written: editor state and the vault's own metadata. */
export const IGNORED_DIRECTORIES = ['.obsidian', '.clawmaster', '.git', '.trash'] as const;
/** The note created once, only when a brand-new vault is opened. */
export const WELCOME_NOTE = '欢迎.md';

const IGNORED = new Set<string>(IGNORED_DIRECTORIES);
const MAX_ID_LENGTH = 512;

/** Reject every id that is not a plain relative note path inside the vault. */
export function assertNoteId(id: string): string {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) {
    throw new VaultError('invalid_path', `Note id must be 1-${MAX_ID_LENGTH} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(id)) throw new VaultError('invalid_path', 'Note id must not contain control characters.');
  if (id.startsWith('/') || id.startsWith('\\')) throw new VaultError('invalid_path', 'Note id must be relative to the vault.');
  if (id.includes('\\')) throw new VaultError('invalid_path', 'Note id must use POSIX separators.');
  if (id.includes(':')) throw new VaultError('invalid_path', 'Note id must not contain a drive prefix or alternate data stream.');
  const segments = id.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new VaultError('invalid_path', 'Note id must not contain empty, "." or ".." segments.');
    }
    if (segment.startsWith('.')) throw new VaultError('invalid_path', 'Note id must not address hidden entries.');
    if (segment !== segment.trim()) throw new VaultError('invalid_path', 'Note id segments must not carry outer whitespace.');
  }
  if (!NOTE_EXTENSIONS.some(extension => id.endsWith(extension))) {
    throw new VaultError('invalid_path', `Note id must end with ${NOTE_EXTENSIONS.join(' or ')}.`);
  }
  return segments.join('/');
}

/** Reject ids the writer may not create: canvases and anything non-Markdown. */
export function assertWritableNoteId(id: string): string {
  const safe = assertNoteId(id);
  if (!WRITABLE_EXTENSIONS.some(extension => safe.endsWith(extension))) {
    throw new VaultError('invalid_path', `Only ${WRITABLE_EXTENSIONS.join(' or ')} notes can be written.`);
  }
  return safe;
}

/** Map an id onto an absolute path, failing if it would leave the vault root. */
export function resolveVaultPath(root: string, id: string): string {
  const safe = assertNoteId(id);
  const base = resolve(root);
  const target = resolve(base, safe);
  const prefix = base.endsWith(sep) ? base : base + sep;
  if (!target.startsWith(prefix)) throw new VaultError('invalid_path', 'Note id escapes the vault root.');
  return target;
}

/** Content revision in the same `sha256-<hex>` shape the sidebar If-Match contract uses. */
export function revisionOf(content: string | Uint8Array): string {
  return `sha256-${createHash('sha256').update(content).digest('hex')}`;
}

export { extractLinks, normalizeTarget, noteTitle, parseFrontmatter } from './note-format.ts';
export type { Frontmatter, NoteLinks } from './note-format.ts';

/** One listed note: identity, display title and cheap filesystem facts. */
export interface VaultEntry { id: string; title: string; dir: string; size: number; mtimeMs: number }

/** One search hit with its first matching line. */
export interface NoteMatch { id: string; title: string; lineNumber: number; line: string }

/** One note's full content plus derived link facts. */
export interface NoteDocument {
  id: string; title: string; text: string; revision: string;
  links: string[]; embeds: string[]; tags: string[];
}

const WELCOME_TEXT = `---
title: 欢迎使用 ClawMaster 笔记
tags: [clawmaster]
created: 1970-01-01
type: note
---

# 欢迎使用 ClawMaster 笔记

这是 ClawMaster 内置的笔记库，纯 Markdown 存储，不依赖任何外部软件。

- 用 \`[[双向链接]]\` 连接笔记，反链会自动汇总。
- 用 \`#标签\` 分类。
- ClawMaster 可以把你的工作过程整理成笔记：它会先给你看改动，得到批准后才写入。
`;

/** Bounds enforced while reading note bytes and enumerating the vault. */
export interface VaultQueryLimits { maxReadBytes: number; maxTreeEntries: number }

/** The revisions observed and committed under one writer lock. */
export interface VaultChange { revision: string; previousRevision: string | null }

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function storageError(error: unknown): VaultError {
  if (error instanceof VaultError) return error;
  return new VaultError('storage_unavailable', `Vault operation failed: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * A Markdown vault with canonical path checks and cooperative cross-process writes.
 * External processes replacing ancestors between a check and syscall require OS isolation.
 */
export class Vault {
  private constructor(readonly root: string) {}

  /** Open an absolute native path and retain its canonical directory identity. */
  static async open(root: string): Promise<Vault> {
    if (!isAbsolute(root)) throw new VaultError('invalid_request', 'Vault root must be an absolute path.');
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      return new Vault(await realpath(root));
    } catch (error) { throw storageError(error); }
  }

  private toId(absolute: string): string {
    return relative(this.root, absolute).split(sep).join('/');
  }

  private contains(path: string): boolean {
    const suffix = relative(this.root, path);
    return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
  }

  private async checkRoot(): Promise<void> {
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(this.root) !== this.root) {
      throw new VaultError('invalid_path', 'Vault root no longer identifies its canonical directory.');
    }
  }

  /** Check existing components without following links; create only verified parent directories. */
  private async checkedPath(id: string, kind: 'file' | 'directory', createParents = false) {
    await this.checkRoot();
    const segments = id.split('/');
    let path = this.root;
    for (let index = 0; index < segments.length; index += 1) {
      path = join(path, segments[index]!);
      const last = index === segments.length - 1;
      let info;
      try { info = await lstat(path); } catch (error) {
        if (!isMissing(error)) throw error;
        if (last && kind === 'file') return { path, info: undefined };
        if (!createParents) throw new VaultError('not_found', `Note ${id} does not exist.`);
        try { await mkdir(path, { mode: 0o700 }); } catch (creationError) {
          if ((creationError as NodeJS.ErrnoException).code !== 'EEXIST') throw creationError;
        }
        info = await lstat(path);
      }
      if (info.isSymbolicLink() || !this.contains(await realpath(path))) {
        throw new VaultError('invalid_path', `Note ${id} addresses a symbolic link or leaves the vault.`);
      }
      const directory = !last || kind === 'directory';
      if (directory ? !info.isDirectory() : !info.isFile()) {
        throw new VaultError('invalid_path', `Note ${id} does not address a regular ${directory ? 'directory' : 'file'}.`);
      }
      if (last) return { path, info };
    }
    throw new VaultError('invalid_path', 'Note path is empty.');
  }

  private async openNote(id: string) {
    const checked = await this.checkedPath(id, 'file');
    if (!checked.info) throw new VaultError('not_found', `Note ${id} does not exist.`);
    const handle = await open(checked.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      const current = await this.checkedPath(id, 'file');
      if (!info.isFile() || !current.info || info.dev !== current.info.dev || info.ino !== current.info.ino) {
        throw new VaultError('conflict', `Note ${id} changed while it was opened.`);
      }
      return { handle, info };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async currentRevision(id: string): Promise<{ revision: string; mode: number } | undefined> {
    let opened;
    try { opened = await this.openNote(id); } catch (error) {
      if (isMissing(error) || error instanceof VaultError && error.code === 'not_found') return undefined;
      throw error;
    }
    try {
      const hash = createHash('sha256');
      for await (const bytes of opened.handle.createReadStream({ autoClose: false })) hash.update(bytes);
      return { revision: `sha256-${hash.digest('hex')}`, mode: opened.info.mode & 0o777 };
    } finally { await opened.handle.close(); }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    try {
      await this.checkRoot();
      return await withFileLock(join(this.root, '.clawmaster-notes-write'), async () => {
        await this.checkRoot();
        return operation();
      });
    } catch (error) { throw storageError(error); }
  }

  private async *noteIds(directory = this.root): AsyncGenerator<string> {
    if (directory === this.root) await this.checkRoot();
    else await this.checkedPath(this.toId(directory), 'directory');
    const entries = await opendir(directory);
    for await (const child of entries) {
      if (child.name.startsWith('.') || IGNORED.has(child.name) || child.isSymbolicLink()) continue;
      const path = join(directory, child.name);
      if (child.isDirectory()) { yield* this.noteIds(path); continue; }
      if (!child.isFile() || !NOTE_EXTENSIONS.some(extension => child.name.endsWith(extension))) continue;
      const id = this.toId(path);
      assertNoteId(id);
      yield id;
    }
  }

  /** List at most the configured number of notes, bounding every title read before allocation. */
  async list(limits: VaultQueryLimits): Promise<VaultEntry[]> {
    try {
      const entries: VaultEntry[] = [];
      for await (const id of this.noteIds()) {
        if (entries.length >= limits.maxTreeEntries) {
          throw new VaultError('invalid_request', `Vault exceeds the ${limits.maxTreeEntries} note limit.`);
        }
        const note = await this.read(id, limits.maxReadBytes);
        const { info } = await this.checkedPath(id, 'file');
        if (!info) throw new VaultError('not_found', `Note ${id} no longer exists.`);
        entries.push({ id, title: note.title, dir: posix.dirname(id) === '.' ? '' : posix.dirname(id), size: info.size, mtimeMs: info.mtimeMs });
      }
      return entries.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    } catch (error) { throw storageError(error); }
  }

  /** Read at most maxBytes; both the initial size and bytes arriving after that check are bounded. */
  async read(id: string, maxBytes: number): Promise<NoteDocument> {
    const safe = assertNoteId(id);
    try {
      const { handle, info } = await this.openNote(safe);
      let bytes: Buffer;
      try {
        if (info.size > maxBytes) throw new VaultError('invalid_request', `Note ${safe} exceeds the ${maxBytes} byte read limit.`);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: maxBytes })) {
          const buffer = chunk as Buffer;
          size += buffer.length;
          if (size > maxBytes) throw new VaultError('invalid_request', `Note ${safe} exceeds the ${maxBytes} byte read limit.`);
          chunks.push(buffer);
        }
        bytes = Buffer.concat(chunks, size);
      } finally { await handle.close(); }
      const text = bytes.toString('utf8');
      const head = parseFrontmatter(text);
      const links = extractLinks(text);
      return { id: safe, title: noteTitle(safe, head.data, head.body), text, revision: revisionOf(bytes), links: links.links, embeds: links.embeds, tags: links.tags };
    } catch (error) {
      if (isMissing(error)) throw new VaultError('not_found', `Note ${safe} does not exist.`);
      throw storageError(error);
    }
  }

  private async createLocked(id: string, text: string): Promise<string> {
    const checked = await this.checkedPath(id, 'file', true);
    const existing = await this.currentRevision(id);
    if (existing) throw new VaultError('conflict', `Note ${id} already exists.`, existing.revision);
    const staging = await mkdtemp(join(dirname(checked.path), '.clawmaster-notes-'));
    try {
      const temp = join(staging, 'note');
      await writeFileAtomic(temp, text, { mode: 0o600, dirMode: 0o700 });
      await this.checkedPath(id, 'file');
      try { await link(temp, checked.path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        throw new VaultError('conflict', `Note ${id} already exists.`, (await this.currentRevision(id))?.revision);
      }
      return revisionOf(text);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  /** Create complete content with no-replace publication; an occupied target is never overwritten. */
  async create(id: string, text: string): Promise<string> {
    const safe = assertWritableNoteId(id);
    return this.mutate(() => this.createLocked(safe, text));
  }

  private async saveLocked(id: string, text: string, expectedRevision: string): Promise<string> {
    const existing = await this.currentRevision(id);
    if (!existing) throw new VaultError('not_found', `Note ${id} does not exist.`);
    if (existing.revision !== expectedRevision) throw new VaultError('conflict', `Note ${id} changed since it was read.`, existing.revision);
    const checked = await this.checkedPath(id, 'file');
    await writeFileAtomic(checked.path, text, { mode: existing.mode, dirMode: 0o700 });
    return revisionOf(text);
  }

  /** Replace complete content after re-reading the caller's revision under the cooperative writer lock. */
  async save(id: string, text: string, expectedRevision: string): Promise<string> {
    const safe = assertWritableNoteId(id);
    return this.mutate(() => this.saveLocked(safe, text, expectedRevision));
  }

  private async appendLocked(current: NoteDocument, text: string): Promise<VaultChange> {
    const separator = current.text.endsWith('\n') || current.text === '' ? '' : '\n';
    const revision = await this.saveLocked(current.id, `${current.text}${separator}${text}`, current.revision);
    return { revision, previousRevision: current.revision };
  }

  /** Append to the revision read under the writer lock and return both committed revisions. */
  async append(id: string, text: string, maxBytes: number): Promise<VaultChange> {
    const safe = assertWritableNoteId(id);
    return this.mutate(async () => this.appendLocked(await this.read(safe, maxBytes), text));
  }

  /** Atomically choose between a new initial document and an append to the existing document. */
  async appendOrCreate(id: string, text: string, initialText: string, maxBytes: number): Promise<VaultChange> {
    const safe = assertWritableNoteId(id);
    return this.mutate(async () => {
      let current: NoteDocument | undefined;
      try { current = await this.read(safe, maxBytes); } catch (error) {
        if (!(error instanceof VaultError) || error.code !== 'not_found') throw error;
      }
      if (current) return this.appendLocked(current, text);
      return { revision: await this.createLocked(safe, `${initialText}${text}`), previousRevision: null };
    });
  }

  /** Move without replacing a destination; the returned revision is the content actually moved. */
  async rename(id: string, to: string): Promise<string> {
    const from = assertWritableNoteId(id);
    const target = assertWritableNoteId(to);
    return this.mutate(async () => {
      const existing = await this.currentRevision(from);
      if (!existing) throw new VaultError('not_found', `Note ${from} does not exist.`);
      const source = await this.checkedPath(from, 'file');
      const destination = await this.checkedPath(target, 'file', true);
      if (destination.info) throw new VaultError('conflict', `Note ${target} already exists.`, (await this.currentRevision(target))?.revision);
      try { await link(source.path, destination.path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        throw new VaultError('conflict', `Note ${target} already exists.`, (await this.currentRevision(target))?.revision);
      }
      try { await unlink(source.path); } catch (error) {
        throw new VaultError('storage_unavailable', `Note ${target} was published but ${from} could not be removed; both paths may exist. ${storageError(error).message}`);
      }
      return existing.revision;
    });
  }

  /** Delete one checked regular file and return its revision under the same writer lock. */
  async remove(id: string): Promise<string> {
    const safe = assertWritableNoteId(id);
    return this.mutate(async () => {
      const existing = await this.currentRevision(safe);
      if (!existing) throw new VaultError('not_found', `Note ${safe} does not exist.`);
      const checked = await this.checkedPath(safe, 'file');
      await unlink(checked.path);
      return existing.revision;
    });
  }

  /** Seed a welcome note only while no visible note exists, under the vault writer lock. */
  async seedWelcome(): Promise<void> {
    await this.mutate(async () => {
      for await (const _id of this.noteIds()) return;
      await this.createLocked(WELCOME_NOTE, WELCOME_TEXT);
    });
  }

  /** Case-insensitive substring search with the same note-count and byte budgets as listing. */
  async search(query: string, limit: number, limits: VaultQueryLimits): Promise<NoteMatch[]> {
    const needle = query.trim().toLocaleLowerCase();
    if (needle === '') throw new VaultError('invalid_request', 'Search query must not be empty.');
    const matches: NoteMatch[] = [];
    for (const entry of await this.list(limits)) {
      if (matches.length >= limit) break;
      const { text } = await this.read(entry.id, limits.maxReadBytes);
      const lines = text.split(/\r?\n/);
      const hit = lines.findIndex(line => line.toLocaleLowerCase().includes(needle));
      if (hit >= 0) { matches.push({ id: entry.id, title: entry.title, lineNumber: hit + 1, line: (lines[hit] ?? '').trim() }); continue; }
      if (entry.title.toLocaleLowerCase().includes(needle)) matches.push({ id: entry.id, title: entry.title, lineNumber: 0, line: entry.title });
    }
    return matches;
  }

  /** Notes linking to an id, bounded by the same query budgets. */
  async backlinks(id: string, limits: VaultQueryLimits): Promise<VaultEntry[]> {
    const safe = assertNoteId(id);
    const names = new Set([safe, safe.replace(/\.(md|canvas)$/, '')]);
    const sources: VaultEntry[] = [];
    for (const entry of await this.list(limits)) {
      if (entry.id === safe) continue;
      const { links } = await this.read(entry.id, limits.maxReadBytes);
      if (links.some(link => names.has(link))) sources.push(entry);
    }
    return sources;
  }
}

/** Open a canonical vault and seed welcome content once while it is empty. */
export async function openVault(root: string): Promise<Vault> {
  const vault = await Vault.open(root);
  await vault.seedWelcome();
  return vault;
}

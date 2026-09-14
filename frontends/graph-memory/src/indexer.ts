/** In-process adapters that read the Notes service and OpenViking's read-only HTTP API. */
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { buildGraph, contentHash, type IndexedDocument, wikiLinks } from './algorithms.ts';
import type { GraphSnapshot } from './model.ts';

export interface NotesAccess {
  readonly root: string;
  list(): Promise<Array<{ id: string; title: string; size: number; mtimeMs: number }>>;
  read(id: string): Promise<{ id: string; title: string; text: string; revision: string; links: string[]; tags: string[] }>;
}

export interface GraphIndexConfig {
  memory: 'auto' | 'off';
  includePeerMemory: boolean;
  maxMemoryEntries: number;
  similarityThreshold: number;
  similarPerDocument: number;
  fileSources: Array<{ label: string; path: string }>;
}

const credentialSchema = z.object({
  url: z.string().url().optional(), baseUrl: z.string().url().optional(),
  api_key: z.string().min(1).optional(), apiKey: z.string().min(1).optional(),
}).passthrough();

interface MemoryCredential { url: string; key: string }

async function credentials(): Promise<MemoryCredential | undefined> {
  try {
    const parsed = credentialSchema.parse(JSON.parse(await readFile(join(homedir(), '.openviking', 'ovcli.conf'), 'utf8')));
    const key = parsed.api_key ?? parsed.apiKey;
    if (key === undefined) return undefined;
    return { url: (parsed.url ?? parsed.baseUrl ?? 'http://127.0.0.1:1933').replace(/\/+$/, ''), key };
  } catch {
    return undefined;
  }
}

async function openVikingGet(credential: MemoryCredential, path: string, params: Record<string, string | number>, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${credential.url}${path}?${new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))}`, {
    headers: { 'X-API-Key': credential.key }, ...(signal === undefined ? {} : { signal }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}.`);
  try { return JSON.parse(text) as unknown; }
  catch { return text; }
}

function memoryEntries(value: unknown, output: Array<{ uri: string; contextType: string | null; level: string | number | null }> = []): Array<{ uri: string; contextType: string | null; level: string | number | null }> {
  if (Array.isArray(value)) {
    for (const item of value) memoryEntries(item, output);
    return output;
  }
  if (typeof value !== 'object' || value === null) return output;
  const record = value as Record<string, unknown>;
  const uri = record['uri'] ?? record['path'];
  const kind = String(record['kind'] ?? record['type'] ?? record['node_type'] ?? '').toLocaleLowerCase();
  const directory = record['isDir'] === true || record['is_dir'] === true || kind === 'dir' || kind === 'directory';
  if (typeof uri === 'string' && uri !== '' && !directory && !uri.endsWith('/')) {
    const level = record['level'];
    output.push({ uri, contextType: typeof record['context_type'] === 'string' ? record['context_type'] : null, level: typeof level === 'string' || typeof level === 'number' ? level : null });
  }
  for (const [key, child] of Object.entries(record)) if (key !== 'abstract') memoryEntries(child, output);
  return output;
}

function textFromMemory(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record['content'] === 'string') return record['content'];
    if (typeof record['text'] === 'string') return record['text'];
  }
  return JSON.stringify(value);
}

function titleOf(text: string, fallback: string): string {
  return /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || fallback;
}

function tagsOf(text: string): string[] {
  const tags = new Set<string>();
  for (const line of text.replace(/```[\s\S]*?```/g, '').split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) continue;
    for (const match of line.matchAll(/(^|[\s(（[，,。;；])#([\p{L}\p{N}_/\-]{1,64})/gu)) if (match[2] !== undefined) tags.add(match[2]);
  }
  return [...tags];
}

async function noteDocuments(access: NotesAccess): Promise<IndexedDocument[]> {
  const entries = await access.list();
  return Promise.all(entries.map(async entry => {
    const note = await access.read(entry.id);
    return {
      id: `note:${entry.id.replace(/\.[^.]+$/, '')}`, kind: 'note' as const, path: entry.id,
      title: note.title, text: note.text, tags: note.tags, links: note.links,
      hash: note.revision.replace(/^sha256-/, ''), mtimeMs: entry.mtimeMs, size: entry.size,
      meta: { source: 'notes', vault: access.root },
    };
  }));
}

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

async function walk(root: string, directory = root, output: string[] = []): Promise<string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(root, path, output);
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

async function fileDocuments(source: { label: string; path: string }): Promise<IndexedDocument[]> {
  const documents: IndexedDocument[] = [];
  for (const path of await walk(source.path)) {
    const info = await stat(path);
    const relative = path.slice(source.path.replace(/\/+$/, '').length + 1);
    const extension = /\.[^.]+$/.exec(relative)?.[0]?.toLocaleLowerCase() ?? '';
    const textual = TEXT_EXTENSIONS.has(extension);
    const text = textual ? await readFile(path, 'utf8') : `${relative}\n${extension.slice(1)}\n${source.label}`;
    const title = textual ? titleOf(text, relative.split('/').at(-1)?.replace(/\.[^.]+$/, '') ?? relative) : relative.split('/').at(-1) ?? relative;
    documents.push({
      id: `file:${source.label}:${relative}`, kind: 'file', path: `${source.label}/${relative}`, title, text,
      tags: textual ? tagsOf(text) : [], links: textual ? wikiLinks(text) : [],
      hash: textual ? contentHash(text) : contentHash(JSON.stringify({ relative, size: info.size, mtimeMs: Math.round(info.mtimeMs) })),
      mtimeMs: info.mtimeMs, size: info.size,
      meta: { source: source.label, indexed: textual ? 'text' : 'metadata-only', extension },
    });
  }
  return documents;
}

async function memoryDocuments(config: GraphIndexConfig, signal?: AbortSignal): Promise<{ documents: IndexedDocument[]; location?: string; errors: GraphSnapshot['errors'] }> {
  if (config.memory === 'off') return { documents: [], errors: [] };
  const credential = await credentials();
  if (credential === undefined) return { documents: [], errors: [{ source: 'memory', message: 'OpenViking credentials are unavailable.' }] };
  const roots = ['viking://~/memories', 'viking://~/skills', 'viking://~/resources', ...(config.includePeerMemory ? ['viking://~/peers'] : [])];
  const documents: IndexedDocument[] = [];
  const errors: GraphSnapshot['errors'] = [];
  for (const root of roots) {
    try {
      const tree = await openVikingGet(credential, '/api/v1/fs/tree', { uri: root, level_limit: 12, node_limit: config.maxMemoryEntries }, signal);
      for (const entry of memoryEntries(tree).slice(0, config.maxMemoryEntries)) {
        try {
          const value = await openVikingGet(credential, '/api/v1/content/read', { uri: entry.uri, raw: 'true' }, signal);
          const text = textFromMemory(value);
          const path = entry.uri.replace(/^viking:\/\/~\/?/, '');
          const fallback = path.split('/').at(-1)?.replace(/\.[^.]+$/, '') ?? path;
          documents.push({
            id: `memory:${path.replace(/\.[^.]+$/, '')}`, kind: 'memory', path,
            title: titleOf(text, fallback), text, tags: tagsOf(text), links: wikiLinks(text),
            hash: contentHash(text), mtimeMs: 0, size: Buffer.byteLength(text),
            meta: { source: 'openviking', uri: entry.uri, contextType: entry.contextType, level: entry.level, content: text },
          });
        } catch (error) {
          errors.push({ source: entry.uri, message: String(error) });
        }
      }
    } catch (error) {
      errors.push({ source: root, message: String(error) });
    }
  }
  return { documents, location: credential.url, errors };
}

/** Refresh the graph without copying source documents or writing long-term memory. */
export async function indexSources(access: NotesAccess, config: GraphIndexConfig, signal?: AbortSignal): Promise<GraphSnapshot> {
  signal?.throwIfAborted();
  const notes = await noteDocuments(access);
  signal?.throwIfAborted();
  const memory = await memoryDocuments(config, signal);
  const fileGroups = await Promise.all(config.fileSources.map(async source => ({ source, documents: await fileDocuments(source) })));
  signal?.throwIfAborted();
  const documents = [...notes, ...memory.documents, ...fileGroups.flatMap(group => group.documents)];
  return buildGraph(documents, {
    generatedAt: new Date().toISOString(), threshold: config.similarityThreshold, topK: config.similarPerDocument,
    sources: [
      { id: 'notes', kind: 'notes', label: 'ClawMaster 笔记', location: access.root, documents: notes.length },
      ...(memory.location === undefined ? [] : [{ id: 'memory', kind: 'memory' as const, label: 'Agent 记忆', location: memory.location, documents: memory.documents.length }]),
      ...fileGroups.map(group => ({ id: `files:${group.source.label}`, kind: 'files' as const, label: group.source.label, location: group.source.path, documents: group.documents.length })),
    ],
    errors: memory.errors,
  });
}

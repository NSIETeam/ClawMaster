import type { FeishuClient } from './client.ts';
import { FeishuError } from './errors.ts';
import { blocksToMarkdown, type DocxBlock } from './markdown.ts';

function requireId(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export interface FeishuDocument {
  readonly documentId: string;
  readonly title: string;
  readonly revisionId: string | null;
  readonly blockCount: number;
  readonly markdown: string;
}

export interface FeishuWikiSpace {
  readonly spaceId: string;
  readonly name: string;
  readonly description: string;
}

export interface FeishuWikiNode {
  readonly nodeToken: string | null;
  readonly objToken: string | null;
  readonly objType: string | null;
  readonly title: string;
  readonly hasChild: boolean;
}

export interface FeishuDriveFile {
  readonly token: string;
  readonly name: string;
  readonly type: string;
  readonly url: string | null;
  readonly modifiedTime: string | null;
}

/** Read one docx document and render it to Markdown. */
export async function readDocument(client: FeishuClient, documentId: string): Promise<FeishuDocument> {
  const id = requireId(documentId, 'documentId');
  const path = `/open-apis/docx/v1/documents/${encodeURIComponent(id)}`;
  const meta = asRecord((await client.request(path)).document);
  const blocks = await client.getAll<DocxBlock>(`${path}/blocks`, { pageSize: 500 });
  const title = typeof meta.title === 'string' ? meta.title : '';
  return Object.freeze({
    documentId: id,
    title,
    revisionId: meta.revision_id === undefined ? null : String(meta.revision_id),
    blockCount: blocks.length,
    markdown: blocksToMarkdown(blocks, { title }),
  });
}

export async function listWikiSpaces(client: FeishuClient): Promise<FeishuWikiSpace[]> {
  const spaces = await client.getAll<Record<string, unknown>>('/open-apis/wiki/v2/spaces', { pageSize: 50 });
  return spaces.map(space => ({
    spaceId: String(space.space_id ?? ''),
    name: typeof space.name === 'string' ? space.name : '',
    description: typeof space.description === 'string' ? space.description : '',
  }));
}

export async function getWikiNode(client: FeishuClient, token: string): Promise<FeishuWikiNode> {
  const nodeToken = requireId(token, 'token');
  const data = await client.request('/open-apis/wiki/v2/spaces/get_node', { query: { token: nodeToken } });
  return normalizeWikiNode(asRecord(data.node));
}

function normalizeWikiNode(node: Record<string, unknown>): FeishuWikiNode {
  return Object.freeze({
    nodeToken: stringOrNull(node.node_token),
    objToken: stringOrNull(node.obj_token),
    objType: stringOrNull(node.obj_type),
    title: typeof node.title === 'string' ? node.title : '',
    hasChild: node.has_child === true,
  });
}

export async function listWikiNodes(
  client: FeishuClient,
  spaceId: string,
  parentNodeToken?: string,
): Promise<FeishuWikiNode[]> {
  const id = requireId(spaceId, 'spaceId');
  const path = `/open-apis/wiki/v2/spaces/${encodeURIComponent(id)}/nodes`;
  const nodes = typeof parentNodeToken === 'string' && parentNodeToken !== ''
    ? await client.getAll<Record<string, unknown>>(path, { pageSize: 50, query: { parent_node_token: parentNodeToken } })
    : await client.getAll<Record<string, unknown>>(path, { pageSize: 50 });
  return nodes.map(normalizeWikiNode);
}

export async function listDriveFiles(client: FeishuClient, folderToken?: string): Promise<FeishuDriveFile[]> {
  const files = typeof folderToken === 'string' && folderToken !== ''
    ? await client.getAll<Record<string, unknown>>('/open-apis/drive/v1/files', { pageSize: 200, query: { folder_token: folderToken } })
    : await client.getAll<Record<string, unknown>>('/open-apis/drive/v1/files', { pageSize: 200 });
  return files.map(file => ({
    token: String(file.token ?? ''),
    name: typeof file.name === 'string' ? file.name : '',
    type: typeof file.type === 'string' ? file.type : '',
    url: stringOrNull(file.url),
    modifiedTime: stringOrNull(file.modified_time),
  }));
}

/**
 * A wiki node wraps a docx/sheet/bitable. Resolve the wrapper, then read the document.
 * A node type this reader cannot render is reported instead of coerced into empty Markdown.
 */
export async function readWikiDocument(client: FeishuClient, wikiToken: string): Promise<FeishuDocument> {
  const node = await getWikiNode(client, wikiToken);
  if (node.objType !== 'docx' && node.objType !== 'doc') {
    throw new FeishuError(
      `Wiki node ${wikiToken} wraps a "${node.objType ?? 'unknown'}", which this reader does not render as Markdown`,
      { path: 'wiki/v2/spaces/get_node' },
    );
  }
  if (node.objToken === null) {
    throw new FeishuError(`Wiki node ${wikiToken} resolved to no obj_token`, { path: 'wiki/v2/spaces/get_node' });
  }
  return readDocument(client, node.objToken);
}

/** Which OAuth scope each read capability needs, in the order the probe reports them. */
export const CAPABILITY_PROBES: readonly { readonly name: string; readonly path: string }[] = Object.freeze([
  { name: 'wiki spaces', path: '/open-apis/wiki/v2/spaces' },
  { name: 'wiki node lookup', path: '/open-apis/wiki/v2/spaces/get_node?token=probe' },
  { name: 'drive files', path: '/open-apis/drive/v1/files' },
  { name: 'docx metadata', path: '/open-apis/docx/v1/documents/doxcnAAAAAAAAAAAAAAAAAAAA' },
]);

export interface CapabilityProbe {
  readonly name: string;
  readonly path: string;
  readonly status: 'granted' | 'missing-scope' | 'error';
  readonly code: number | null;
  readonly requiredScopes: readonly string[];
  readonly detail: string;
}

/**
 * Report which read capabilities this app currently holds.
 *
 * This exists so a deployment can tell "no documents" apart from "no permission" without
 * reading a blog post: each entry is a real call whose Feishu failure code is classified.
 */
export async function probeCapabilities(client: FeishuClient): Promise<CapabilityProbe[]> {
  const results: CapabilityProbe[] = [];
  for (const probe of CAPABILITY_PROBES) {
    try {
      await client.request(probe.path, { query: { page_size: 1 } });
      results.push({ ...probe, status: 'granted', code: 0, requiredScopes: [], detail: 'ok' });
    } catch (error) {
      const feishu = error instanceof FeishuError ? error : undefined;
      const scopes = feishu !== undefined && 'scopes' in feishu && Array.isArray(feishu.scopes)
        ? feishu.scopes as readonly string[]
        : [];
      results.push({
        ...probe,
        status: feishu?.name === 'FeishuScopeError' ? 'missing-scope' : 'error',
        code: feishu?.code ?? null,
        requiredScopes: scopes,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

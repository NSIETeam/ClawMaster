/** Sidebar Office loading and guarded saves over the existing authenticated file routes. */
import type { ReactNode } from 'react';
import { isDocumentBytes, isEnvelope, OFFICE_PROTOCOL, OFFICE_PROTOCOL_VERSION, MAX_DOCUMENT_BYTES, type OfficeLocale, type ParentPayload } from './protocol.ts';

export interface OfficeScope { sessionId: string; cwd?: string }
export interface OfficeToolbarState { modes: boolean; mode: 'preview' | 'edit'; dirty: boolean; editable: boolean; saveState: 'idle' | 'saving' | 'saved' | 'failed' }
export interface OfficeViewerProps {
  scope: OfficeScope; path: string; title: string;
  onToolbarState?: (state: OfficeToolbarState) => void;
}
export interface OfficeServices {
  effect(install: () => () => void, label?: string): void;
  locale: { getSnapshot(): { active: string }; subscribe(listener: () => void): () => void };
  betterSidebar: {
    registerFileViewer(viewer: {
      id: string; title(): string; exts: readonly string[]; priority: number; fetchStrategy: 'none';
      component(props: OfficeViewerProps): ReactNode;
    }): () => void;
  };
}
export type OfficeStatus = 'loading' | 'opening' | 'ready' | 'saving' | 'saved' | 'load-error' | 'save-error' | 'conflict';
export interface OfficeState { status: OfficeStatus; dirty: boolean; recovery?: ArrayBuffer }
export interface OfficeTransport {
  origin: string;
  channel: string;
  frame(): Window | null;
  fetch: typeof fetch;
  digest(bytes: ArrayBuffer): Promise<ArrayBuffer>;
}

/** An exact content revision accepted by the sidebar's If-Match upload contract. */
export async function documentRevision(bytes: ArrayBuffer, digest: OfficeTransport['digest']): Promise<string> {
  const hash = new Uint8Array(await digest(bytes));
  return `sha256-${Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Construct the existing Session-scoped file download URL. */
export function officeFileUrl(scope: OfficeScope, path: string): string {
  const query = new URLSearchParams({ sessionId: scope.sessionId, path });
  if (scope.cwd) query.set('cwd', scope.cwd);
  return `/sidebar/file?${query}`;
}

/** One local path split without applying browser URL normalization to its filename. */
export function officePath(path: string): { dir: string; fileName: string } {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (slash < 0 || slash === path.length - 1) throw new Error('Office file path must be absolute');
  const dir = slash === 2 && /^[a-z]:/i.test(path) ? path.slice(0, slash + 1) : path.slice(0, slash) || '/';
  return { dir, fileName: path.slice(slash + 1) };
}

/** Own one immutable document identity and accept saves only from its editing iframe. */
export class OfficeDocument {
  readonly signal: AbortSignal;
  private readonly lifetime = new AbortController();
  private state: OfficeState = { status: 'loading', dirty: false };
  private listeners = new Set<() => void>();
  private revision?: string;
  private initialBytes?: ArrayBuffer;
  private ready = false;
  private opened = false;
  private saving = false;
  private seenSaves = new Set<string>();

  constructor(readonly scope: OfficeScope, readonly path: string, readonly locale: OfficeLocale, private readonly transport: OfficeTransport) {
    this.signal = this.lifetime.signal;
  }
  getSnapshot = (): OfficeState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(next: OfficeState): void {
    if (this.signal.aborted) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  private send(message: ParentPayload): void {
    if (this.signal.aborted) return;
    this.transport.frame()?.postMessage({ protocol: OFFICE_PROTOCOL, version: OFFICE_PROTOCOL_VERSION, channel: this.transport.channel, ...message }, this.transport.origin);
  }
  private openWhenReady(): void {
    if (!this.ready || this.opened || !this.initialBytes || this.signal.aborted) return;
    this.opened = true;
    this.update({ status: 'opening', dirty: false });
    this.send({ type: 'open', fileName: officePath(this.path).fileName, locale: this.locale, bytes: this.initialBytes });
    this.initialBytes = undefined;
  }
  /** Load actual file bytes before computing the revision used by every save. */
  async start(): Promise<void> {
    try {
      const response = await this.transport.fetch(officeFileUrl(this.scope, this.path), { signal: this.signal, cache: 'no-store' });
      if (!response.ok || Number(response.headers.get('content-length')) > MAX_DOCUMENT_BYTES) throw new Error('Office file unavailable');
      const bytes = await response.arrayBuffer();
      if (!isDocumentBytes(bytes)) throw new Error('Office file size unsupported');
      this.revision = await documentRevision(bytes, this.transport.digest);
      this.initialBytes = bytes;
      this.openWhenReady();
    } catch {
      if (!this.signal.aborted) this.update({ status: 'load-error', dirty: false });
    }
  }
  /** Ignore unrelated frames and malformed or duplicate save requests. */
  receive = (event: MessageEvent<unknown>): void => {
    if (this.signal.aborted || event.source !== this.transport.frame() || event.origin !== this.transport.origin || !isEnvelope(event.data, this.transport.channel)) return;
    const data = event.data;
    if (data.type === 'ready') { this.ready = true; this.openWhenReady(); }
    else if (data.type === 'opened' && this.opened) this.update({ status: 'ready', dirty: false });
    else if (data.type === 'dirty' && typeof data.value === 'boolean' && this.opened) {
      if (!data.value && ['conflict', 'save-error'].includes(this.state.status)) return;
      this.update({ ...this.state, dirty: data.value });
    } else if (data.type === 'error' && this.opened) {
      this.update({ ...this.state, status: data.code === 'conversion-failed' ? 'save-error' : 'load-error' });
    } else if (data.type === 'save' && typeof data.requestId === 'string' && data.requestId.length <= 128
      && isDocumentBytes(data.bytes) && this.opened && this.revision && !this.seenSaves.has(data.requestId)) {
      if (this.saving) { this.send({ type: 'save-result', requestId: data.requestId, ok: false }); return; }
      this.seenSaves.add(data.requestId);
      void this.save(data.requestId, data.bytes);
    }
  };
  private async save(requestId: string, bytes: ArrayBuffer): Promise<void> {
    this.saving = true;
    this.update({ status: 'saving', dirty: true, recovery: bytes });
    try {
      const { dir, fileName } = officePath(this.path);
      const query = new URLSearchParams({ sessionId: this.scope.sessionId, dir, relativePath: fileName });
      if (this.scope.cwd) query.set('cwd', this.scope.cwd);
      const response = await this.transport.fetch(`/sidebar/upload?${query}`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream', 'If-Match': `"${this.revision}"` },
        body: bytes, signal: this.signal,
      });
      if (response.status === 412) {
        this.update({ status: 'conflict', dirty: true, recovery: bytes });
        this.send({ type: 'save-result', requestId, ok: false });
        return;
      }
      if (!response.ok) throw new Error('Office save failed');
      const envelope: unknown = await response.json();
      const savedRevision = await documentRevision(bytes, this.transport.digest);
      if (typeof envelope !== 'object' || envelope === null || !('ok' in envelope) || envelope.ok !== true
        || !('value' in envelope) || typeof envelope.value !== 'object' || envelope.value === null
        || !('revision' in envelope.value) || envelope.value.revision !== savedRevision) throw new Error('Office save result unavailable');
      this.revision = savedRevision;
      this.update({ status: 'saved', dirty: false });
      this.send({ type: 'save-result', requestId, ok: true });
    } catch {
      if (!this.signal.aborted) {
        this.update({ status: 'save-error', dirty: true, recovery: bytes });
        this.send({ type: 'save-result', requestId, ok: false });
      }
    } finally { this.saving = false; }
  }
  /** Abort file activity and stop updates when the owning viewer closes. */
  dispose(): void { this.lifetime.abort(); this.listeners.clear(); this.initialBytes = undefined; }
}

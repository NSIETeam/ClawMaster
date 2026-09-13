/** The local Office iframe exchanges one document with its owning sidebar viewer. */
export const OFFICE_PROTOCOL = 'clawmaster-office';
export const OFFICE_PROTOCOL_VERSION = 1;
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
export type OfficeLocale = 'zh-CN' | 'en-US';
export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';
export interface Envelope { protocol: typeof OFFICE_PROTOCOL; version: typeof OFFICE_PROTOCOL_VERSION; channel: string }
export type FrameMessage = Envelope & (
  | { type: 'ready' }
  | { type: 'opened' }
  | { type: 'dirty'; value: boolean }
  | { type: 'save'; requestId: string; bytes: ArrayBuffer }
  | { type: 'error'; code: 'open-failed' | 'conversion-failed' }
);
export type ParentMessage = Envelope & (
  | { type: 'open'; fileName: string; locale: OfficeLocale; bytes: ArrayBuffer }
  | { type: 'save-result'; requestId: string; ok: boolean }
);
export type ParentPayload = ParentMessage extends infer Message ? Message extends Envelope ? Omit<Message, keyof Envelope> : never : never;

/** Recognize the fixed protocol envelope before interpreting cross-window data. */
export function isEnvelope(value: unknown, channel: string): value is Envelope & Record<string, unknown> {
  return typeof value === 'object' && value !== null
    && 'protocol' in value && value.protocol === OFFICE_PROTOCOL
    && 'version' in value && value.version === OFFICE_PROTOCOL_VERSION
    && 'channel' in value && value.channel === channel;
}

/** Only the three supported OOXML file types can enter an editing frame. */
export function officeFormat(fileName: string): OfficeFormat | undefined {
  const ext = fileName.split('.').at(-1)?.toLowerCase();
  return ext === 'docx' || ext === 'xlsx' || ext === 'pptx' ? ext : undefined;
}

/** Bound the document bytes accepted at the iframe protocol boundary. */
export function isDocumentBytes(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer && value.byteLength > 0 && value.byteLength <= MAX_DOCUMENT_BYTES;
}

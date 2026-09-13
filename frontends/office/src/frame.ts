/** One local document per frame; saves are acknowledged only after its owner confirms disk persistence. */
import { convertDocument, convertBinToDocument, initX2T } from '../vendor/onlyoffice-web-local/x2t.ts';
import { isDocumentBytes, isEnvelope, officeFormat, OFFICE_PROTOCOL, OFFICE_PROTOCOL_VERSION, MAX_DOCUMENT_BYTES, type FrameMessage } from './protocol.ts';

interface Editor { sendCommand(command: { command: string; data: unknown }): void; destroyEditor(): void }
interface EditorEvent { data: unknown }
declare global { interface Window { DocsAPI: { DocEditor: new (id: string, config: unknown) => Editor } } }
const query = new URLSearchParams(location.search);
const channel = query.get('channel');
const parentOrigin = query.get('parentOrigin');
if (!channel || parentOrigin !== location.origin || window.parent === window) throw new Error('Office editor requires its local document viewer.');
type Payload = FrameMessage extends infer Message ? Message extends { type: string } ? Omit<Message, 'protocol' | 'version' | 'channel'> : never : never;
const send = (message: Payload): void => parent.postMessage({ protocol: OFFICE_PROTOCOL, version: OFFICE_PROTOCOL_VERSION, channel, ...message }, parentOrigin);
let editor: Editor | undefined;
let opened = false;
let pendingSave: string | undefined;
const imageUrls: Record<string, string> = {};

async function api(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = './web-apps/apps/api/documents/api.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Local Office API unavailable.'));
    document.head.appendChild(script);
  });
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
async function save(event: EditorEvent, fileName: string): Promise<void> {
  if (pendingSave) return;
  try {
    const payload = event.data;
    if (!record(payload) || !record(payload.data) || !(payload.data.data instanceof Uint8Array || typeof payload.data.data === 'string')) throw new Error('Invalid Office save data.');
    if (payload.data.data.length > MAX_DOCUMENT_BYTES * 4) throw new Error('Office intermediate document exceeds the supported size.');
    const converted = await convertBinToDocument(payload.data.data, fileName, officeFormat(fileName)!.toUpperCase());
    const bytes = Uint8Array.from(converted.data).buffer;
    if (!isDocumentBytes(bytes)) throw new Error('Office output exceeds the supported size.');
    pendingSave = crypto.randomUUID();
    send({ type: 'save', requestId: pendingSave, bytes });
  } catch {
    editor?.sendCommand({ command: 'asc_onSaveCallback', data: { err_code: 1 } });
    send({ type: 'error', code: 'conversion-failed' });
  }
}

async function writeImage(event: EditorEvent): Promise<void> {
  try {
    const data = event.data;
    if (!record(data) || typeof data.file !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(data.file)
      || !(data.data instanceof Uint8Array) || data.data.byteLength > 20 * 1024 * 1024) throw new Error('Invalid image.');
    const converter = await initX2T();
    converter.FS.writeFile(`/working/media/${data.file}`, data.data);
    const url = URL.createObjectURL(new Blob([Uint8Array.from(data.data)]));
    imageUrls[`media/${data.file}`] = url;
    editor?.sendCommand({ command: 'asc_setImageUrls', data: { urls: imageUrls } });
    editor?.sendCommand({ command: 'asc_writeFileCallback', data: { path: url, imgName: data.file } });
  } catch {
    editor?.sendCommand({ command: 'asc_writeFileCallback', data: { success: false } });
  }
}

async function open(fileName: string, bytes: ArrayBuffer, locale: string): Promise<void> {
  try {
    await api();
    const converted = await convertDocument(new File([bytes], fileName));
    Object.assign(imageUrls, converted.media);
    editor = new window.DocsAPI.DocEditor('editor', {
      document: { title: fileName, url: fileName, fileType: officeFormat(fileName), permissions: { edit: true, chat: false, protect: false } },
      editorConfig: { lang: locale === 'zh-CN' ? 'zh' : 'en', mode: 'edit', customization: {
        about: true, help: false, anonymous: { request: false, label: 'Guest' }, features: { spellcheck: { change: false } },
      } },
      events: {
        onAppReady: () => {
          editor?.sendCommand({ command: 'asc_setImageUrls', data: { urls: imageUrls } });
          editor?.sendCommand({ command: 'asc_openDocument', data: { buf: converted.bin } });
        },
        onDocumentReady: () => send({ type: 'opened' }),
        onDocumentStateChange: (event: EditorEvent) => { if (typeof event.data === 'boolean') send({ type: 'dirty', value: event.data }); },
        onSave: (event: EditorEvent) => { void save(event, fileName); },
        writeFile: (event: EditorEvent) => { void writeImage(event); },
        onError: () => send({ type: 'error', code: 'open-failed' }),
      },
    });
  } catch { send({ type: 'error', code: 'open-failed' }); }
}

window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== parentOrigin || !isEnvelope(event.data, channel)) return;
  const data = event.data;
  if (data.type === 'open' && !opened && typeof data.fileName === 'string' && officeFormat(data.fileName)
    && !/[/\\\x00-\x1f]/.test(data.fileName) && isDocumentBytes(data.bytes) && (data.locale === 'zh-CN' || data.locale === 'en-US')) {
    opened = true;
    void open(data.fileName, data.bytes, data.locale);
  } else if (data.type === 'save-result' && pendingSave !== undefined && data.requestId === pendingSave && typeof data.ok === 'boolean') {
    pendingSave = undefined;
    editor?.sendCommand({ command: 'asc_onSaveCallback', data: { err_code: data.ok ? 0 : 1 } });
  }
});
window.addEventListener('pagehide', () => { editor?.destroyEditor(); Object.values(imageUrls).forEach(url => URL.revokeObjectURL(url)); });
send({ type: 'ready' });

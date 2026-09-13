/** Isolated browser fixture drives the production file viewer transport. */
import { OfficeDocument } from '../src/services.ts';
const frame = document.querySelector<HTMLIFrameElement>('iframe')!;
const path = new URLSearchParams(location.search).get('path')!;
const channel = crypto.randomUUID();
const office = new OfficeDocument({ sessionId: 'test-office', cwd: path.slice(0, path.lastIndexOf('/')) }, path, 'zh-CN', {
  origin: location.origin, channel, frame: () => frame.contentWindow, fetch: window.fetch.bind(window), digest: bytes => crypto.subtle.digest('SHA-256', bytes),
});
office.subscribe(() => { document.querySelector('output')!.textContent = JSON.stringify(office.getSnapshot(), (key, value) => key === 'recovery' ? Boolean(value) : value); });
window.addEventListener('message', office.receive);
frame.src = `/clawmaster/office/runtime/index.html?${new URLSearchParams({ channel, parentOrigin: location.origin })}`;
void office.start();
window.addEventListener('pagehide', () => office.dispose());

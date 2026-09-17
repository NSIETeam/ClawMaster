/** Office file viewers reuse the local editor iframe and guarded sidebar uploads. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { OfficeDocument, officePath, type OfficeServices, type OfficeViewerProps } from './services.ts';
import { officeCopy } from './locales.ts';
import type { OfficeLocale } from './protocol.ts';
import styles from './styles.css';

export const name = 'clawmaster-office';
export const inject = ['betterSidebar', 'locale'];
const RUNTIME = '/clawmaster/office/runtime/';

function OfficeViewer({ scope, path, locale, onToolbarState }: OfficeViewerProps & { locale: OfficeLocale }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [channel] = useState(() => crypto.randomUUID());
  const [document] = useState(() => new OfficeDocument(scope, path, locale, {
    origin: window.location.origin, channel, frame: () => frame.current?.contentWindow ?? null,
    fetch: window.fetch.bind(window), digest: bytes => crypto.subtle.digest('SHA-256', bytes),
  }));
  const state = useSyncExternalStore(document.subscribe, document.getSnapshot, document.getSnapshot);
  useEffect(() => {
    onToolbarState?.({ modes: false, mode: 'edit', dirty: state.dirty,
      editable: false,
      saveState: state.status === 'saving' ? 'saving' : state.status === 'saved' ? 'saved'
        : ['save-error', 'conflict'].includes(state.status) ? 'failed' : 'idle' });
  }, [state, onToolbarState]);
  const copy = officeCopy(locale);
  const [recoveryUrl, setRecoveryUrl] = useState<string>();
  useEffect(() => {
    window.addEventListener('message', document.receive);
    void document.start();
    return () => { window.removeEventListener('message', document.receive); document.dispose(); };
  }, [document]);
  useEffect(() => {
    if (!state.recovery) { setRecoveryUrl(undefined); return; }
    const url = URL.createObjectURL(new Blob([state.recovery], { type: 'application/octet-stream' }));
    setRecoveryUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [state.recovery]);
  const src = `${RUNTIME}index.html?${new URLSearchParams({ channel, parentOrigin: window.location.origin })}`;
  return <section className="cm-office" aria-label={copy.editor}>
    <div className="cm-office-status" role="status" data-state={state.status}>
      <span>{copy[state.status]}{state.dirty ? ` · ${copy.dirty}` : ''}</span>
      {recoveryUrl && ['conflict', 'save-error'].includes(state.status) && <a href={recoveryUrl} download={officePath(path).fileName}>{copy.recovery}</a>}
      <a href={`${RUNTIME}NOTICE.html`} target="_blank" rel="noreferrer">{copy.legal}</a>
    </div>
    <iframe ref={frame} className="cm-office-frame" src={src} title={copy.editor} />
  </section>;
}

/** Register and dispose three Office viewers with the existing sidebar service. */
export function apply(ctx: OfficeServices): void {
  const locale = (): OfficeLocale => ctx.locale.getSnapshot().active.startsWith('zh') ? 'zh-CN' : 'en-US';
  ctx.effect(() => {
    const style = document.createElement('style');
    const nonce = document.querySelector<HTMLMetaElement>('meta[name="dsh-style-nonce"]')?.content;
    if (nonce) style.nonce = nonce;
    style.textContent = styles; style.dataset.plugin = name;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'clawmaster: office viewer styles');
  for (const format of ['docx', 'xlsx', 'pptx'] as const) {
    function Viewer(props: OfficeViewerProps) {
      useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active);
      return <OfficeViewer key={`${props.scope.sessionId}:${props.path}`} {...props} locale={locale()} />;
    }
    ctx.effect(() => ctx.betterSidebar.registerFileViewer({
      id: `clawmaster:office:${format}`, title: () => officeCopy(locale())[format], exts: [format],
      priority: 20, fetchStrategy: 'none', component: props => <Viewer {...props} />,
    }), `clawmaster: office ${format} viewer`);
  }
}

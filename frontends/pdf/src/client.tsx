/**
 * Built-in PDF panel: the Sidebar tab that inspects a document and runs the built-in operations.
 *
 * The panel deliberately does no document work of its own. Every operation goes to the Host, which owns
 * the folder policy, the atomic write and the revision record, so the panel and an agent tool produce
 * byte-identical results and the same refusals. What the panel adds is the part a model is bad at: the
 * exact page selection, the watermark text, and a list of what actually landed on disk.
 */
import { useEffect, useMemo, useState } from 'react';
import { PdfApi, PdfApiError } from './pdf-api.ts';
import { PdfIcon } from './icons.tsx';
import { pdfCopy, type PdfCopy } from './locales.ts';
import type { PdfEditReceipt, PdfInfo, StirlingStatus } from './protocol.ts';

/** The services this plugin consumes from the client runtime. */
export interface PdfClientServices {
  effect(install: () => () => void, label?: string): void;
  locale: { getSnapshot(): { active: string }; subscribe(listener: () => void): () => void };
  betterSidebar: {
    registerTab(descriptor: {
      id: string;
      title: string | (() => string);
      description?: string | (() => string);
      icon?: React.ReactNode | ((size: number) => React.ReactNode);
      order?: number;
      single?: boolean;
      component(props: { scope: { sessionId: string }; visible: boolean }): React.ReactNode;
    }): () => void;
  };
}

/** The plugin identity the client runtime loads this module under. */
export const name = 'clawmaster-pdf';

/** The services this plugin must be given before it loads. */
export const inject = ['betterSidebar', 'locale'];

/** The operations the panel offers, in the order they appear. */
const OPERATIONS = ['rotate', 'delete', 'extract', 'reorder', 'watermark', 'pageNumbers', 'merge'] as const;
type OperationName = typeof OPERATIONS[number];

/**
 * The PDF tab.
 * @param props - The plugin context and whether the tab is on screen.
 */
export function PdfPanel({ ctx, visible }: { ctx: PdfClientServices; visible: boolean }): React.ReactElement {
  const copy = useCopy(ctx);
  const api = useMemo(() => new PdfApi(fetch), []);
  const [path, setPath] = useState('');
  const [info, setInfo] = useState<PdfInfo | null>(null);
  const [receipt, setReceipt] = useState<PdfEditReceipt | null>(null);
  const [stirling, setStirling] = useState<StirlingStatus | null>(null);
  const [operation, setOperation] = useState<OperationName>('rotate');
  const [selection, setSelection] = useState('all');
  const [text, setText] = useState('');
  const [inputs, setInputs] = useState('');
  const [inPlace, setInPlace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  // The optional component's status is asked for once, when the tab first appears, because it is the
  // only way the panel can tell a user which tool handles OCR rather than guessing.
  useEffect(() => {
    if (!visible) return undefined;
    let live = true;
    void api.stirling().then(status => { if (live) setStirling(status); }).catch(() => undefined);
    return () => { live = false; };
  }, [api, visible]);

  const inspect = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      setInfo(await api.info(path.trim()));
      setReceipt(null);
    } catch (error) {
      setProblem(messageOf(error));
      setInfo(null);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const operations = buildOperations(operation, { selection, text, inputs });
      setReceipt(await api.edit({ source: path.trim(), operations, inPlace }));
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const ready = path.trim().toLowerCase().endsWith('.pdf');

  return (
    <div className="cm-pdf">
      <header className="cm-pdf-head">
        <PdfIcon size={16} />
        <input
          className="cm-pdf-input"
          value={path}
          placeholder={copy.pathPlaceholder}
          aria-label={copy.path}
          onChange={event => setPath(event.target.value)}
        />
        <button type="button" onClick={() => void inspect()} disabled={busy || !ready}>{copy.inspect}</button>
      </header>

      {!ready && path.trim() !== '' ? <p className="cm-pdf-note cm-pdf-warn">{copy.invalidPath}</p> : null}
      {problem !== undefined ? <p className="cm-pdf-note cm-pdf-warn">{problem}</p> : null}

      {info !== null ? (
        <section className="cm-pdf-info">
          <dl>
            <dt>{copy.pages}</dt><dd>{info.pageCount}</dd>
            <dt>{copy.size}</dt><dd>{formatBytes(info.bytes)}</dd>
            <dt>{copy.rotation}</dt><dd>{info.rotations.join(', ')}</dd>
            <dt>{copy.revision}</dt><dd className="cm-pdf-mono">{info.revision.slice(0, 19)}…</dd>
          </dl>
          {info.title !== undefined ? <p className="cm-pdf-title">{info.title}</p> : null}
        </section>
      ) : null}

      <section className="cm-pdf-run">
        <div className="cm-pdf-row">
          <select value={operation} aria-label={copy.operation} onChange={event => setOperation(event.target.value as OperationName)}>
            {OPERATIONS.map(entry => <option key={entry} value={entry}>{copy[entry]}</option>)}
          </select>
          <input
            className="cm-pdf-input"
            value={selection}
            placeholder={copy.pagesHint}
            aria-label={copy.pagesSelection}
            onChange={event => setSelection(event.target.value)}
          />
        </div>
        {operation === 'watermark' ? (
          <input className="cm-pdf-input" value={text} placeholder={copy.watermarkText} onChange={event => setText(event.target.value)} />
        ) : null}
        {operation === 'merge' ? (
          <input className="cm-pdf-input" value={inputs} placeholder={copy.inputsHint} onChange={event => setInputs(event.target.value)} />
        ) : null}
        <div className="cm-pdf-row">
          <label className="cm-pdf-check" title={copy.inPlaceHint}>
            <input type="checkbox" checked={inPlace} onChange={event => setInPlace(event.target.checked)} />
            {copy.inPlace}
          </label>
          <button type="button" onClick={() => void run()} disabled={busy || !ready}>{busy ? copy.working : copy.apply}</button>
        </div>
      </section>

      <section className="cm-pdf-results">
        <div className="cm-pdf-section">{copy.results}</div>
        {receipt === null ? <p className="cm-pdf-note">{copy.noResults}</p> : null}
        {receipt?.outputs.map(output => (
          <p className="cm-pdf-result" key={output.path}>
            <span className="cm-pdf-who">{output.path}</span>
            <span className="cm-pdf-count">{output.pageCount} {copy.pages.toLowerCase()}</span>
            <span className="cm-pdf-mono">{(receipt.revisions[output.path] ?? '').slice(0, 12)}…</span>
          </p>
        ))}
      </section>

      <footer className="cm-pdf-stirling">
        <div className="cm-pdf-section">{copy.stirling}</div>
        {stirling === null ? null : stirling.available
          ? <p className="cm-pdf-note">{stirling.directory}</p>
          : <p className="cm-pdf-note">{copy.stirlingMissing}{stirling.reason === undefined ? '' : ` — ${stirling.reason}`}</p>}
        {stirling !== null && !stirling.available ? (
          <p className="cm-pdf-note">{copy.delegated}: {stirling.delegatedOperations.join(', ')}</p>
        ) : null}
      </footer>
    </div>
  );
}

/**
 * Build the operation list one panel choice produces.
 *
 * The panel's single-operation shape is converted here rather than on the wire, so the same sequence
 * shape the agent uses goes to the Host and both produce identical results.
 * @param operation - Which operation the user picked.
 * @param input - The current controls.
 * @returns The operation list to send.
 */
export function buildOperations(
  operation: OperationName,
  input: { selection: string; text: string; inputs: string },
): Array<Record<string, unknown>> {
  const selection = input.selection.trim() === '' ? 'all' : input.selection.trim();
  switch (operation) {
    case 'rotate': return [{ op: 'rotate', pages: selection, by: 90 }];
    case 'delete': return [{ op: 'delete', pages: selection }];
    case 'extract': return [{ op: 'extract', ranges: selection, mode: 'keep' }];
    case 'reorder': return [{ op: 'reorder', order: selection }];
    case 'watermark': return [{ op: 'watermark', text: input.text }];
    case 'pageNumbers': return [{ op: 'pageNumbers' }];
    case 'merge': return [{ op: 'merge', paths: input.inputs.split(',').map(entry => entry.trim()).filter(entry => entry !== '') }];
  }
}

/** The copy for the locale the host is in. */
function useCopy(ctx: PdfClientServices): PdfCopy {
  const [locale, setLocale] = useState(ctx.locale.getSnapshot().active);
  useEffect(() => ctx.locale.subscribe(() => setLocale(ctx.locale.getSnapshot().active)), [ctx]);
  return pdfCopy(locale);
}

/** A short reason for a failed call, carrying the server's own code when there is one. */
function messageOf(error: unknown): string {
  if (error instanceof PdfApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** A size a person can read. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * Register the PDF tab for the plugin lifetime.
 * @param ctx - The sidebar and locale services.
 */
export function apply(ctx: PdfClientServices): void {
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = name;
    style.textContent = STYLES;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'clawmaster: pdf styles');
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'clawmaster:pdf',
    title: () => pdfCopy(ctx.locale.getSnapshot().active.startsWith('zh') ? 'zh-CN' : 'en-US').tab,
    description: () => pdfCopy(ctx.locale.getSnapshot().active.startsWith('zh') ? 'zh-CN' : 'en-US').tabDescription,
    icon: size => <PdfIcon size={size} />,
    order: 50,
    single: true,
    component: ({ visible }) => <PdfPanel ctx={ctx} visible={visible} />,
  }), 'clawmaster: pdf tab');
}

/** Panel styles, on the host's own alias tokens so the panel follows both themes. */
const STYLES = `
.cm-pdf { display: flex; flex-direction: column; height: 100%; font-size: 13px; gap: 8px; }
.cm-pdf-head { display: flex; align-items: center; gap: 6px; }
.cm-pdf-head svg { color: var(--dsw-alias-text-secondary, #666); flex: none; }
.cm-pdf-input { flex: 1; min-width: 80px; height: 28px; padding: 0 6px; border-radius: 4px; border: 1px solid var(--dsw-alias-border, #d0d0d0); background: transparent; color: inherit; }
.cm-pdf button { height: 28px; padding: 0 8px; border-radius: 4px; border: 1px solid var(--dsw-alias-border, #d0d0d0); background: transparent; color: inherit; cursor: pointer; }
.cm-pdf button:disabled { opacity: 0.5; cursor: default; }
.cm-pdf select { height: 28px; border-radius: 4px; border: 1px solid var(--dsw-alias-border, #d0d0d0); background: transparent; color: inherit; }
.cm-pdf-note { margin: 0; color: var(--dsw-alias-text-secondary, #666); }
.cm-pdf-warn { color: var(--dsw-alias-state-warning, #b26a00); }
.cm-pdf-section { color: var(--dsw-alias-text-secondary, #666); letter-spacing: 0.02em; margin-bottom: 2px; }
.cm-pdf-info dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; margin: 0; }
.cm-pdf-info dt { color: var(--dsw-alias-text-secondary, #666); }
.cm-pdf-info dd { margin: 0; }
.cm-pdf-title { margin: 4px 0 0; font-weight: 600; }
.cm-pdf-run { display: flex; flex-direction: column; gap: 6px; }
.cm-pdf-row { display: flex; align-items: center; gap: 6px; }
.cm-pdf-check { display: flex; align-items: center; gap: 4px; color: var(--dsw-alias-text-secondary, #666); flex: 1; }
.cm-pdf-results { flex: 1; overflow: auto; }
.cm-pdf-result { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; margin: 0 0 4px; align-items: baseline; }
.cm-pdf-who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cm-pdf-count, .cm-pdf-mono { color: var(--dsw-alias-text-secondary, #666); font-size: 12px; }
.cm-pdf-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.cm-pdf-stirling { border-top: 1px solid var(--dsw-alias-border, #d0d0d0); padding-top: 6px; }
`;

/** ClawMaster Notes: the built-in Markdown vault as a native sidebar tab. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { NotesApi, NotesApiError } from './notes-api.ts';
import { inlineTokens, parseMarkdown, type Block } from './markdown.ts';
import type { NoteEntry, NoteMatch, NoteRead, Proposal, UnifiedDiff } from './protocol.ts';
import { extractLinks, noteTitle, parseFrontmatter } from './note-format.ts';
import { notesCopy, type NotesLocale } from './locales.ts';
import styles from './styles.css';

export const name = 'clawmaster-notes';
export const inject = ['betterSidebar', 'locale'];

/** The public sidebar registry and locale service this plugin consumes. */
export interface NotesClientServices {
  effect(install: () => () => void, label?: string): void;
  locale: { getSnapshot(): { active: string }; subscribe(listener: () => void): () => void };
  betterSidebar: {
    registerTab(descriptor: {
      id: string;
      title: string | (() => string);
      description?: string | (() => string);
      order?: number;
      single?: boolean;
      component(props: { scope: { sessionId: string }; visible: boolean }): ReactNode;
    }): () => void;
  };
}

type NoteDraft = { note: NoteRead; text: string };
type Drafts = Map<string, NoteDraft>;

type Status = { state: 'loading' | 'idle' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error'; message?: string };

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

/** How often a visible notes panel asks whether the vault changed underneath it. */
const REVISION_POLL_MS = 4000;

/** Render one inline run: wiki links become in-panel navigation, never raw markup. */
function InlineView({ text, onWiki }: { text: string; onWiki: (target: string) => void }): ReactNode {
  return <>{inlineTokens(text).map((token, index) => {
    if (token.kind === 'wiki') {
      return <button key={index} type="button" className="cm-notes-wiki" onClick={() => onWiki(token.target ?? token.text)}>{token.text}</button>;
    }
    if (token.kind === 'code') return <code key={index}>{token.text}</code>;
    if (token.kind === 'strong') return <strong key={index}>{token.text}</strong>;
    return <span key={index}>{token.text}</span>;
  })}</>;
}

/** Render one parsed block. */
function BlockView({ block, onWiki }: { block: Block; onWiki: (target: string) => void }): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const Tag = HEADINGS[Math.min(Math.max(block.level ?? 1, 1), 6) - 1] ?? 'p';
      return <Tag><InlineView text={block.text} onWiki={onWiki} /></Tag>;
    }
    case 'list': {
      const items = (block.items ?? []).map((item, index) => <li key={index}><InlineView text={item} onWiki={onWiki} /></li>);
      return block.ordered === true ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case 'quote': return <blockquote><InlineView text={block.text} onWiki={onWiki} /></blockquote>;
    case 'code': return <pre data-language={block.language ?? ''}><code>{block.text}</code></pre>;
    case 'rule': return <hr />;
    case 'paragraph': return <p><InlineView text={block.text} onWiki={onWiki} /></p>;
  }
}

/** The sidebar notes page: vault tree, editor, preview, backlinks, tags and search. */
function NotesPanel({ ctx, drafts, visible }: { ctx: NotesClientServices; drafts: Drafts; visible: boolean }): ReactNode {
  const locale: NotesLocale = useSyncExternalStore(
    listener => ctx.locale.subscribe(listener),
    () => ctx.locale.getSnapshot().active,
  ).startsWith('zh') ? 'zh-CN' : 'en-US';
  const copy = notesCopy(locale);
  const api = useMemo(() => new NotesApi((input, init) => fetch(input as string, init)), []);
  const [entries, setEntries] = useState<NoteEntry[]>();
  const [open, setOpen] = useState<NoteRead | undefined>(() => drafts.values().next().value?.note);
  const [draft, setDraft] = useState(() => drafts.values().next().value?.text ?? '');
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [status, setStatus] = useState<Status>({ state: 'idle' });
  const [backlinks, setBacklinks] = useState<NoteEntry[]>([]);
  const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [proposals, setProposals] = useState<Array<{ proposal: Proposal; diff: UnifiedDiff }>>([]);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<NoteMatch[]>();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmation, setConfirmation] = useState<'delete' | 'reload'>();
  const [wiki, setWiki] = useState<{ target: string; candidates: NoteEntry[] }>();
  const [renaming, setRenaming] = useState<string>();
  const [renameDraft, setRenameDraft] = useState('');
  const busy = useRef(false);
  const generation = useRef(0);
  const vaultVersion = useRef<string>();
  // Read through a ref so the poll below never restarts on a keystroke.
  const latest = useRef<{ open: NoteRead | undefined; draft: string }>({ open: undefined, draft: '' });
  latest.current = { open, draft };
  useEffect(() => () => { generation.current += 1; }, []);

  const fail = useCallback((error: unknown) => {
    if (error instanceof NotesApiError) {
      setStatus(error.code === 'conflict'
        ? { state: 'conflict', message: copy.conflict }
        : { state: 'error', message: `${copy.error}: ${error.message}` });
      return;
    }
    setStatus({ state: 'error', message: `${copy.error}: ${String(error)}` });
  }, [copy]);

  const refresh = useCallback(async () => {
    try {
      const [tree, tagList, pending] = await Promise.all([api.tree(), api.tags(), api.proposals()]);
      setEntries(tree.notes);
      setTags(tagList.tags);
      setProposals(pending.proposals);
    } catch (error) { fail(error); }
  }, [api, fail]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Live refresh: an external edit (an editor or the agent writing files) is noticed by
  // version, then applied without ever discarding an unsaved draft.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const current = await api.revision();
        if (cancelled) return;
        const previous = vaultVersion.current;
        vaultVersion.current = current;
        if (previous === undefined || previous === current) return;
        await refresh();
        if (cancelled) return;
        const { open: current_note, draft: current_draft } = latest.current;
        if (current_note === undefined) return;
        const fresh = await api.read(current_note.id);
        if (cancelled || fresh.revision === current_note.revision) return;
        if (current_draft !== current_note.text) {
          setStatus({ state: 'conflict', message: copy.external });
          return;
        }
        setOpen(fresh);
        setDraft(fresh.text);
      } catch { /* a failed poll is not something the user needs to act on */ }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, REVISION_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api, copy, refresh, visible]);

  const openNote = useCallback(async (id: string, reload = false) => {
    if (busy.current) return;
    const requestGeneration = ++generation.current;
    setConfirmation(undefined);
    setStatus({ state: 'loading' });
    try {
      const retained = reload ? undefined : drafts.get(id);
      const note = retained?.note ?? await api.read(id);
      if (requestGeneration !== generation.current) return;
      if (reload) drafts.delete(id);
      setOpen(note);
      setDraft(retained?.text ?? note.text);
      setMode('edit');
      setStatus({ state: 'idle' });
      setBacklinks([]);
      const linked = await api.backlinks(id);
      if (requestGeneration === generation.current) setBacklinks(linked.notes);
    } catch (error) { if (requestGeneration === generation.current) fail(error); }
  }, [api, drafts, fail]);

  const save = useCallback(async () => {
    if (!open || busy.current) return;
    busy.current = true;
    const requestGeneration = ++generation.current;
    setStatus({ state: 'saving' });
    try {
      const receipt = await api.command({ action: 'save', id: open.id, text: draft, expectedRevision: open.revision });
      if (receipt.revision === null) throw new NotesApiError('storage_unavailable', copy.invalidRevision);
      const head = parseFrontmatter(draft);
      const saved = { ...open, text: draft, revision: receipt.revision,
        title: noteTitle(open.id, head.data, head.body), ...extractLinks(draft) };
      if (drafts.get(open.id)?.text === draft) drafts.delete(open.id);
      if (requestGeneration !== generation.current) return;
      setOpen(saved);
      setStatus({ state: 'saved' });
      await refresh();
    } catch (error) { if (requestGeneration === generation.current) fail(error); }
    finally { busy.current = false; }
  }, [api, copy, draft, drafts, fail, open, refresh]);

  const createNote = useCallback(async () => {
    const name = newName.trim();
    if (name === '' || busy.current) return;
    busy.current = true;
    const id = name.endsWith('.md') ? name : `${name}.md`;
    setStatus({ state: 'saving' });
    try {
      await api.command({ action: 'create', id, text: `# ${name.replace(/\.md$/, '')}\n` });
      setCreating(false);
      setNewName('');
      await refresh();
      busy.current = false;
      await openNote(id);
    } catch (error) { fail(error); }
    finally { busy.current = false; }
  }, [api, fail, newName, openNote, refresh]);

  const removeNote = useCallback(async (id: string) => {
    if (busy.current) return;
    busy.current = true;
    const requestGeneration = ++generation.current;
    setConfirmation(undefined);
    setStatus({ state: 'saving' });
    try {
      await api.command({ action: 'delete', id });
      drafts.delete(id);
      if (requestGeneration !== generation.current) return;
      setOpen(undefined);
      setDraft('');
      setStatus({ state: 'idle' });
      await refresh();
    } catch (error) { if (requestGeneration === generation.current) fail(error); }
    finally { busy.current = false; }
  }, [api, drafts, fail, refresh]);

  /** Apply a reviewed proposal; the vault refuses when the note moved since it was drafted. */
  const applyProposal = useCallback(async (proposalId: string) => {
    if (busy.current) return;
    busy.current = true;
    setStatus({ state: 'saving' });
    try {
      const receipt = await api.command({ action: 'apply-proposal', proposalId });
      await refresh();
      busy.current = false;
      await openNote(receipt.id, true);
    } catch (error) { fail(error); }
    finally { busy.current = false; }
  }, [api, fail, openNote, refresh]);

  /** Drop a proposal without touching the note. */
  const discardProposal = useCallback(async (proposalId: string) => {
    if (busy.current) return;
    busy.current = true;
    setStatus({ state: 'saving' });
    try {
      await api.command({ action: 'discard-proposal', proposalId });
      setStatus({ state: 'idle' });
      await refresh();
    } catch (error) { fail(error); }
    finally { busy.current = false; }
  }, [api, fail, refresh]);

  const runSearch = useCallback(async () => {
    if (query.trim() === '') { setMatches(undefined); return; }
    try { setMatches((await api.search(query.trim())).matches); }
    catch (error) { fail(error); }
  }, [api, fail, query]);

  /** Resolve a wiki target to every candidate; ambiguity and absence are surfaced, never guessed. */
  const openWiki = useCallback((target: string) => {
    const wanted = target.endsWith('.md') ? target : `${target}.md`;
    const bare = target.replace(/\.md$/, '');
    const candidates = (entries ?? []).filter(entry => {
      const idBare = entry.id.replace(/\.md$/, '');
      return entry.id === target || entry.id === wanted || idBare === bare
        || idBare.split('/').pop() === bare || idBare.endsWith(`/${bare}`);
    });
    const [only] = candidates;
    if (candidates.length === 1 && only !== undefined) { void openNote(only.id); return; }
    setWiki({ target: bare, candidates });
  }, [entries, openNote]);

  /** Create the note a wiki link points at, then open it. */
  const createFromWiki = useCallback(async (target: string) => {
    const id = target.endsWith('.md') ? target : `${target}.md`;
    try {
      await api.command({ action: 'create', id, text: `# ${target.replace(/\.md$/, '')}\n` });
      setWiki(undefined);
      await refresh();
      await openNote(id);
    } catch (error) { fail(error); }
  }, [api, fail, openNote, refresh]);

  /** Rename the open note; the vault refuses to clobber an existing target. */
  const renameNote = useCallback(async (to: string) => {
    if (!open || busy.current) return;
    const trimmed = to.trim();
    const target = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
    if (trimmed === '' || target === open.id) { setRenaming(undefined); return; }
    busy.current = true;
    setStatus({ state: 'saving' });
    try {
      await api.command({ action: 'rename', id: open.id, to: target });
      drafts.delete(open.id);
      setRenaming(undefined);
      await refresh();
      busy.current = false;
      await openNote(target);
    } catch (error) { fail(error); }
    finally { busy.current = false; }
  }, [api, drafts, fail, open, openNote, refresh]);

  /** Open today's daily note, creating it when it does not exist yet. */
  const openToday = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setStatus({ state: 'saving' });
    try {
      const receipt = await api.command({ action: 'daily', text: '' });
      await refresh();
      busy.current = false;
      await openNote(receipt.id);
    } catch (error) { fail(error); }
    finally { busy.current = false; }
  }, [api, fail, openNote, refresh]);

  const dirty = open !== undefined && draft !== open.text;
  const isCanvas = open !== undefined && open.id.endsWith('.canvas');
  const blocks = useMemo(() => parseMarkdown(draft), [draft]);

  return <section className="cm-notes" aria-label={copy.tab}>
    <div className="cm-notes-bar">
      <input value={query} placeholder={copy.searchPlaceholder} aria-label={copy.search}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') void runSearch(); }} />
      <button type="button" onClick={() => { setQuery(''); setMatches(undefined); }}>{copy.cancel}</button>
      <button type="button" onClick={() => void openToday()}>{copy.todayNote}</button>
      <button type="button" onClick={() => setCreating(value => !value)}>{copy.newNote}</button>
    </div>
    {creating && <div className="cm-notes-create">
      <input autoFocus value={newName} placeholder={copy.noteName} aria-label={copy.noteName}
        onChange={event => setNewName(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') void createNote(); }} />
      <button type="button" onClick={() => void createNote()}>{copy.create}</button>
    </div>}
    <div className="cm-notes-body">
      {matches !== undefined
        ? matches.length === 0
          ? <p className="cm-notes-empty">{copy.noResults}</p>
          : matches.map(match => <div key={`${match.id}:${match.lineNumber}`}>
            <button type="button" className="cm-notes-item" disabled={status.state === 'saving'}
              onClick={() => void openNote(match.id)}>
              <span>{match.title}</span>{' '}<small>{copy.line} {match.lineNumber}</small>
            </button>
            <p className="cm-notes-match">{match.line}</p>
          </div>)
        : entries === undefined
          ? <p className="cm-notes-empty">{copy.loading}</p>
          : entries.length === 0
            ? <p className="cm-notes-empty">{copy.empty}</p>
            : entries.map(entry => <div key={entry.id}>
              <button type="button" className="cm-notes-item" data-active={open?.id === entry.id}
                disabled={status.state === 'saving'} onClick={() => void openNote(entry.id)}>
                <span>{entry.title}</span>
                {' '}<small>{drafts.has(entry.id) ? copy.dirty : entry.dir}</small>
              </button>
            </div>)}
    </div>
    {open && <div className="cm-notes-editor">
      <div className="cm-notes-head">
        <h2>{open.title}</h2>
        <div className="cm-notes-actions">
          {!isCanvas && <button type="button" disabled={status.state === 'saving'} onClick={() => { setRenaming(open.id); setRenameDraft(open.id.replace(/\.md$/, '')); }}>{copy.rename}</button>}
          <button type="button" onClick={() => setMode(value => value === 'edit' ? 'preview' : 'edit')}>
            {mode === 'edit' ? copy.preview : copy.edit}
          </button>
          <button type="button" disabled={isCanvas || !dirty || status.state === 'saving'} onClick={() => void save()}>{copy.save}</button>
          <button type="button" disabled={status.state === 'saving'} onClick={() => setConfirmation('delete')}>{copy.delete}</button>
        </div>
      </div>
      {confirmation && <div role="alertdialog" aria-label={confirmation === 'delete' ? copy.delete : copy.conflictReload}>
        <p>{confirmation === 'delete' ? copy.deleteConfirm : copy.reloadConfirm}</p>
        <button type="button" onClick={() => setConfirmation(undefined)}>{copy.cancel}</button>
        <button type="button" onClick={() => { if (confirmation === 'delete') void removeNote(open.id); else void openNote(open.id, true); }}>
          {confirmation === 'delete' ? copy.delete : copy.conflictReload}
        </button>
      </div>}
      {wiki && <div role="alertdialog" aria-label={copy.wikiMissing}>
        {wiki.candidates.length === 0
          ? <p>{copy.wikiMissing}</p>
          : <>
            <p>{copy.wikiAmbiguous}</p>
            {wiki.candidates.map(candidate => <button key={candidate.id} type="button" className="cm-notes-item"
              onClick={() => { setWiki(undefined); void openNote(candidate.id); }}><span>{candidate.title}</span></button>)}
          </>}
        <button type="button" onClick={() => setWiki(undefined)}>{copy.cancel}</button>
        {wiki.candidates.length === 0
          && <button type="button" onClick={() => void createFromWiki(wiki.target)}>{copy.wikiCreate}</button>}
      </div>}
      {renaming !== undefined && <div role="alertdialog" aria-label={copy.rename}>
        <input autoFocus value={renameDraft} aria-label={copy.renameLabel}
          onChange={event => setRenameDraft(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') void renameNote(renameDraft); }} />
        <button type="button" onClick={() => setRenaming(undefined)}>{copy.cancel}</button>
        <button type="button" onClick={() => void renameNote(renameDraft)}>{copy.rename}</button>
      </div>}
      {isCanvas
        ? <>
          <p className="cm-notes-canvas-notice">{copy.canvasReadOnly}</p>
          <pre className="cm-notes-canvas">{draft}</pre>
        </>
        : mode === 'edit'
          ? <textarea value={draft} readOnly={status.state === 'saving' || status.state === 'loading'} spellCheck={false} aria-label={copy.edit} onChange={event => {
            const text = event.target.value;
            setDraft(text);
            if (text === open.text) drafts.delete(open.id);
            else drafts.set(open.id, { note: open, text });
          }} />
          : <div className="cm-notes-preview">{blocks.map((block, index) => <BlockView key={index} block={block} onWiki={openWiki} />)}</div>}
      <div className="cm-notes-side">
        <h3>{copy.proposals}</h3>
        {proposals.length === 0 ? <p>{copy.noProposals}</p> : proposals.map(entry => <div key={entry.proposal.proposalId} className="cm-notes-proposal">
          <button type="button" className="cm-notes-item" disabled={status.state === 'saving'}
            onClick={() => void openNote(entry.proposal.id)}><span>{entry.proposal.id}</span></button>
          <pre className="cm-notes-diff">{entry.diff.lines.map(line => `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '} ${line.text}`).join('\n')}</pre>
          <div className="cm-notes-actions">
            <button type="button" disabled={status.state === 'saving'} onClick={() => void applyProposal(entry.proposal.proposalId)}>{copy.applyProposal}</button>
            <button type="button" disabled={status.state === 'saving'} onClick={() => void discardProposal(entry.proposal.proposalId)}>{copy.discardProposal}</button>
          </div>
        </div>)}
        <h3>{copy.backlinks}</h3>
        {backlinks.length === 0 ? <p>{copy.noBacklinks}</p> : backlinks.map(entry => <button key={entry.id} type="button" className="cm-notes-item" disabled={status.state === 'saving'} onClick={() => void openNote(entry.id)}><span>{entry.title}</span></button>)}
        <h3>{copy.tags}</h3>
        {tags.length === 0 ? <p>{copy.noTags}</p> : tags.map(tag => <span key={tag.tag} className="cm-notes-chip">{tag.tag} · {tag.count}</span>)}
      </div>
    </div>}
    <div className="cm-notes-notice" role="status" data-state={status.state}>
      <span className="cm-notes-status" data-state={status.state}>{dirty ? copy.dirty : copy[status.state === 'conflict' ? 'conflict' : status.state === 'error' ? 'error' : status.state === 'saving' ? 'saving' : status.state === 'saved' ? 'saved' : 'vault']}</span>
      {status.state === 'conflict' && open && <button type="button" onClick={() => setConfirmation('reload')}>{copy.conflictReload}</button>}
      {status.message !== undefined && <span className="cm-notes-status" data-state={status.state}> · {status.message}</span>}
    </div>
  </section>;
}

/** Register the notes tab and its scoped styles for the plugin lifetime. */
export function apply(ctx: NotesClientServices): void {
  // BetterSidebar has no close veto; drafts survive its tab unmounts until this plugin is disposed.
  const sessions = new Map<string, Drafts>();
  ctx.effect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (![...sessions.values()].some(drafts => drafts.size > 0)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); sessions.clear(); };
  }, 'clawmaster: unsaved note drafts');
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = name;
    style.textContent = styles;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'clawmaster: notes styles');
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'clawmaster:notes',
    title: () => notesCopy(ctx.locale.getSnapshot().active.startsWith('zh') ? 'zh-CN' : 'en-US').tab,
    description: () => notesCopy(ctx.locale.getSnapshot().active.startsWith('zh') ? 'zh-CN' : 'en-US').tabDescription,
    order: 30,
    single: true,
    component: ({ scope, visible }) => {
      let drafts = sessions.get(scope.sessionId);
      if (!drafts) { drafts = new Map(); sessions.set(scope.sessionId, drafts); }
      return <NotesPanel key={scope.sessionId} ctx={ctx} drafts={drafts} visible={visible} />;
    },
  }), 'clawmaster: notes tab');
}

/**
 * Built-in Voice panel: the Sidebar tab that records a meeting and shows who said what.
 *
 * The split of responsibility is deliberate and visible in this file: the panel owns the microphone
 * and the sentence boundaries (because only the client can reach the device), the Host owns
 * recognition, attribution and the durable timeline. The panel therefore never holds a transcript of
 * its own — it renders the state the Host reports, so what the user sees is exactly what was recorded.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { VoiceApi, VoiceApiError } from './voice-api.ts';
import { Recorder, browserAudioPlatform } from './recorder.ts';
import { timecode } from './notes-format.ts';
import { LevelDot, VoiceIcon } from './icons.tsx';
import { voiceCopy, type VoiceCopy } from './locales.ts';
import type { Speaker, VoiceModels, VoiceState } from './protocol.ts';

/** The services this plugin consumes from the client runtime. */
export interface VoiceClientServices {
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
export const name = 'clawmaster-voice';

/** The services this plugin must be given before it loads. */
export const inject = ['betterSidebar', 'locale'];

/**
 * The Voice tab.
 * @param props - The plugin context, the session it belongs to, and whether it is on screen.
 */
export function VoicePanel({ ctx, visible }: { ctx: VoiceClientServices; visible: boolean }): React.ReactElement {
  const copy = useCopy(ctx);
  const api = useMemo(() => new VoiceApi(fetch), []);
  const [state, setState] = useState<VoiceState | null>(null);
  const [models, setModels] = useState<VoiceModels | null>(null);
  const [enrolled, setEnrolled] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const recorderRef = useRef<Recorder | undefined>(undefined);

  const platform = useMemo(() => browserAudioPlatform(), []);
  const canRecord = platform !== undefined;

  // Poll the Host while the tab is on screen: a second client, a tool call or the agent can change
  // the same session, and the panel must show the recorded truth rather than its own guess.
  useEffect(() => {
    if (!visible) return undefined;
    let live = true;
    const load = async () => {
      try {
        const [next, modelState] = await Promise.all([api.live(), api.models()]);
        if (!live) return;
        setState(next);
        setModels(modelState);
        const listing = await api.speakers();
        if (live) setEnrolled(listing.enrolled);
      } catch (error) {
        if (live) setProblem(messageOf(error));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => { live = false; clearInterval(timer); };
  }, [api, visible, tick]);

  // Keep a level meter ticking while recording; the device frames arrive far more often than React
  // should re-render, so the meter reads the recorder on a fixed cadence instead.
  useEffect(() => {
    const recorder = recorderRef.current;
    if (recorder === undefined || state?.status === 'stopped') return undefined;
    const timer = setInterval(() => setTick(value => value + 1), 250);
    return () => clearInterval(timer);
  }, [state?.sessionId, state?.status]);

  // Release the microphone when the tab is removed, so the recording indicator cannot outlive it.
  useEffect(() => () => { void recorderRef.current?.stop(); }, []);

  const recorder = recorderRef.current;
  const recording = recorder?.recording ?? false;
  const status = recorder?.status();
  const turns = state?.utterances ?? [];
  const speakers = state?.speakers ?? [];

  const start = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const named = title.trim();
      const started = await api.start(named === '' ? { action: 'start' } : { action: 'start', title: named });
      setState(started);
      // The recorder is built here, not at mount, so no microphone is opened until the user asks.
      const runtime = new Recorder(platform!, api, { onStatus: () => setTick(value => value + 1) });
      recorderRef.current = runtime;
      await runtime.start(started.sessionId);
    } catch (error) {
      setProblem(messageOf(error));
      recorderRef.current = undefined;
    } finally {
      setBusy(false);
      setTick(value => value + 1);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await recorderRef.current?.stop();
      const live = state;
      if (live !== null) setState(await api.stop(live.sessionId));
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
      setTick(value => value + 1);
    }
  };

  const rename = async (speaker: Speaker) => {
    const name = window.prompt(copy.renameHint, speaker.name);
    if (name === null || name.trim() === '') return;
    try {
      await api.speakersCommand({ action: 'rename', sessionId: state!.sessionId, speakerId: speaker.id, name: name.trim() });
      setTick(value => value + 1);
    } catch (error) {
      setProblem(messageOf(error));
    }
  };

  const merge = async (from: Speaker, into: Speaker) => {
    try {
      await api.speakersCommand({ action: 'merge', sessionId: state!.sessionId, from: from.id, into: into.id });
      setTick(value => value + 1);
    } catch (error) {
      setProblem(messageOf(error));
    }
  };

  return (
    <div className="cm-voice">
      <header className="cm-voice-head">
        <div className="cm-voice-title">
          <VoiceIcon size={16} />
          <span>{recording ? copy.recording : copy.idle}</span>
          {recording ? <LevelDot level={status?.level ?? 0} speaking={(status?.level ?? 0) > 0.02} /> : null}
        </div>
        <div className="cm-voice-actions">
          {recording ? (
            <button type="button" onClick={() => void stop()} disabled={busy}>{copy.stop}</button>
          ) : (
            <>
              <input
                className="cm-voice-input"
                value={title}
                placeholder={copy.titlePlaceholder}
                aria-label={copy.sessionTitle}
                onChange={event => setTitle(event.target.value)}
                disabled={busy || !canRecord}
              />
              <button type="button" onClick={() => void start()} disabled={busy || !canRecord}>{copy.start}</button>
            </>
          )}
        </div>
      </header>

      {!canRecord ? <p className="cm-voice-note">{copy.notSupported}</p> : null}
      {models !== null && !models.engine ? (
        <p className="cm-voice-note cm-voice-warn">
          {copy.engineMissing}{models.reason ?? models.directory}
          {models.missing.length > 0 ? ` (${models.missing.join(', ')})` : ''}
        </p>
      ) : null}
      {problem !== undefined ? <p className="cm-voice-note cm-voice-warn">{copy.problem}: {problem}</p> : null}
      {status?.problem !== undefined ? <p className="cm-voice-note cm-voice-warn">{copy.problem}: {status.problem}</p> : null}

      <section className="cm-voice-speakers">
        <div className="cm-voice-section">
          {copy.speakers} · {speakers.length} · {copy.turns} {turns.length}
        </div>
        {speakers.map(speaker => (
          <div className="cm-voice-speaker" key={speaker.id}>
            <span className={speaker.named ? 'cm-voice-name' : 'cm-voice-name cm-voice-auto'}>{speaker.name}</span>
            <span className="cm-voice-count">{speaker.voiceprints}</span>
            <button type="button" onClick={() => void rename(speaker)} disabled={state === null}>{copy.rename}</button>
            {speakers.length > 1 && !speaker.named ? (
              <button
                type="button"
                title={copy.mergeHint}
                onClick={() => {
                  const target = speakers.find(candidate => candidate.id !== speaker.id && candidate.named)
                    ?? speakers.find(candidate => candidate.id !== speaker.id);
                  if (target !== undefined) void merge(speaker, target);
                }}
              >→</button>
            ) : null}
          </div>
        ))}
      </section>

      <section className="cm-voice-transcript">
        {turns.length === 0 ? <p className="cm-voice-note">{copy.noTurns}</p> : null}
        {turns.map(turn => (
          <p className="cm-voice-turn" key={turn.id}>
            <span className="cm-voice-time">{timecode(turn.startMs)}</span>
            <span className="cm-voice-who">{nameOf(speakers, turn.speakerId) ?? turn.speakerId}</span>
            <span className="cm-voice-text">{turn.text}</span>
          </p>
        ))}
      </section>

      {enrolled.length > 0 ? (
        <footer className="cm-voice-enrolled" title={copy.enrollHint}>
          {copy.enrolled}: {enrolled.join('、')}
        </footer>
      ) : null}
    </div>
  );
}

/** Resolve a turn's speaker id to the label the Host currently reports. */
function nameOf(speakers: readonly Speaker[], speakerId: string): string | undefined {
  return speakers.find(speaker => speaker.id === speakerId)?.name;
}

/** The copy for the locale the host is in. */
function useCopy(ctx: VoiceClientServices): VoiceCopy {
  const [locale, setLocale] = useState(ctx.locale.getSnapshot().active);
  useEffect(() => ctx.locale.subscribe(() => setLocale(ctx.locale.getSnapshot().active)), [ctx]);
  return voiceCopy(locale);
}

/** A short reason for a failed call, carrying the server's own code when there is one. */
function messageOf(error: unknown): string {
  if (error instanceof VoiceApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Register the Voice tab for the plugin lifetime.
 * @param ctx - The sidebar and locale services.
 */
export function apply(ctx: VoiceClientServices): void {
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = name;
    style.textContent = STYLES;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'clawmaster: voice styles');
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'clawmaster:voice',
    title: () => voiceCopy(ctx.locale.getSnapshot().active.startsWith('zh') ? 'zh-CN' : 'en-US').tab,
    description: () => voiceCopy(ctx.locale.getSnapshot().active.startsWith('zh') ? 'zh-CN' : 'en-US').tabDescription,
    icon: size => <VoiceIcon size={size} />,
    order: 40,
    single: true,
    component: ({ visible }) => <VoicePanel ctx={ctx} visible={visible} />,
  }), 'clawmaster: voice tab');
}

/**
 * Panel styles. Kept as a string because the host injects plugin CSS this way, and kept on the host's
 * own alias tokens so the panel follows the light and dark themes without a second palette.
 */
const STYLES = `
.cm-voice { display: flex; flex-direction: column; height: 100%; font-size: 13px; gap: 6px; }
.cm-voice-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.cm-voice-title { display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-text-secondary, #666); }
.cm-voice-actions { display: flex; align-items: center; gap: 6px; }
.cm-voice-input { min-width: 120px; height: 28px; padding: 0 6px; border-radius: 4px; border: 1px solid var(--dsw-alias-border, #d0d0d0); background: transparent; color: inherit; }
.cm-voice button { height: 28px; padding: 0 8px; border-radius: 4px; border: 1px solid var(--dsw-alias-border, #d0d0d0); background: transparent; color: inherit; cursor: pointer; }
.cm-voice button:disabled { opacity: 0.5; cursor: default; }
.cm-voice-meter { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-business-tertiary, #4c8dff); transition: transform 120ms linear; }
.cm-voice-meter-speaking { background: var(--dsw-alias-state-warning, #e8a33d); }
.cm-voice-note { margin: 0; color: var(--dsw-alias-text-secondary, #666); }
.cm-voice-warn { color: var(--dsw-alias-state-warning, #b26a00); }
.cm-voice-section { color: var(--dsw-alias-text-secondary, #666); letter-spacing: 0.02em; margin: 2px 0; }
.cm-voice-speaker { display: flex; align-items: center; gap: 6px; height: 34px; }
.cm-voice-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cm-voice-name.cm-voice-auto { font-style: italic; color: var(--dsw-alias-text-secondary, #666); }
.cm-voice-count { color: var(--dsw-alias-text-secondary, #666); font-size: 12px; }
.cm-voice-transcript { flex: 1; overflow: auto; }
.cm-voice-turn { display: grid; grid-template-columns: 44px 84px 1fr; gap: 6px; margin: 0 0 4px; line-height: 1.5; }
.cm-voice-time, .cm-voice-who { color: var(--dsw-alias-text-secondary, #666); }
.cm-voice-who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cm-voice-enrolled { color: var(--dsw-alias-text-secondary, #666); font-size: 12px; }
`;

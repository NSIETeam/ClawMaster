/** WatchDog introduction uses explicit navigation and never starts a model turn. */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProductLocale } from './locales/frontend.ts';
import { onboardingCopy } from './locales/onboarding.ts';

/** Actions are supplied by DSH's settings coordinator or the WatchDog entry. */
export interface WatchdogTutorialProps {
  locale: ProductLocale;
  onFinish(): Promise<void>;
  onSkip?: () => Promise<void>;
  onSettings?: (section: 'models' | 'xmanrui-dsh-im') => Promise<void>;
}
const steps = ['scope', 'brief', 'records', 'cadence', 'followup'] as const;

/**
 * Render the same guide in first-run onboarding and its settings page.
 * @param props - Localized copy and explicit owner navigation actions.
 * @returns A step-by-step tutorial with no model or integration side effects.
 */
export function WatchdogTutorial({ locale, onFinish, onSkip, onSettings }: WatchdogTutorialProps) {
  const copy = onboardingCopy(locale);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const pending = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const act = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(false);
    try { await operation(); }
    catch { if (active.current) setError(true); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  };
  const current = steps[step]!;
  const last = step === steps.length - 1;
  return <section className="cm-tutorial" aria-label={copy.title} aria-busy={busy}>
    <header><p className="cm-tutorial-eyebrow">{copy.settingsTitle}</p><h2>{copy.title}</h2><p>{copy.subtitle}</p></header>
    <ol className="cm-tutorial-progress" aria-label={copy.progress}>
      {steps.map((key, index) => <li key={key}><button type="button" aria-current={index === step ? 'step' : undefined}
        aria-label={copy[`${key}Title`]} disabled={busy} onClick={() => setStep(index)}>{index + 1}</button></li>)}
    </ol>
    <div className="cm-tutorial-step" aria-live="polite" aria-atomic="true">
      <h3>{copy[`${current}Title`]}</h3><p>{copy[`${current}Body`]}</p>
      <p className="cm-tutorial-tip">{copy[`${current}Tip`]}</p>
    </div>
    {error && <p className="cm-error" role="alert">{copy.saveError}</p>}
    <footer>
      {onSkip ? <button type="button" className="cm-tutorial-skip" disabled={busy} onClick={() => { void act(onSkip); }}>{copy.skip}</button>
        : <button type="button" disabled={busy || step === 0} onClick={() => setStep(0)}>{copy.replay}</button>}
      <div><button type="button" disabled={busy || step === 0} onClick={() => setStep(step - 1)}>{copy.back}</button>
        {last ? <button type="button" className="cm-primary" disabled={busy} onClick={() => { void act(onFinish); }}>{busy ? copy.saving : copy.finish}</button>
          : <button type="button" className="cm-primary" disabled={busy} onClick={() => setStep(step + 1)}>{copy.next}</button>}
      </div>
    </footer>
    {last && onSettings && <div className="cm-tutorial-destinations"><p>{copy.ready}</p>
      <button type="button" disabled={busy} onClick={() => { void act(() => onSettings('models')); }}>{copy.models}</button>
      <button type="button" disabled={busy} onClick={() => { void act(() => onSettings('xmanrui-dsh-im')); }}>{copy.im}</button>
    </div>}
  </section>;
}

/**
 * Native modal focus containment and Escape dismissal for the first-run guide.
 * @param props - Tutorial actions, including explicit skip persistence.
 * @returns A body portal whose modal lifetime is owned by the component.
 */
export function WatchdogTutorialDialog(props: WatchdogTutorialProps & { onSkip(): Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return createPortal(<dialog ref={dialog} className="cm-tutorial-dialog" aria-label={onboardingCopy(props.locale).title}
    onCancel={event => { event.preventDefault(); dialog.current?.querySelector<HTMLButtonElement>('.cm-tutorial-skip')?.click(); }}>
    <WatchdogTutorial {...props} />
  </dialog>, document.body);
}

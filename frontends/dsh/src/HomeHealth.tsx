/** Show independent service, model, schedule and business observations on WatchDog home. */
import { businessHealthSummary, productCopy, type ProductLocale } from './locales/frontend.ts';

export interface HomeHealthState {
  app: 'connected' | 'disconnected' | 'connecting';
  model: 'unverified' | 'verified';
  schedule: { error: boolean; observedAt: number | null; total: number | null; online: number; offline: number; degraded: number; failed: number; uncertain: number };
  business: { total: number; review: number; failed: number; overdue: number; error: boolean };
}

/** Render health facts without inferring model readiness from the app connection. */
export function HomeHealth({ locale, state }: { locale: ProductLocale; state: HomeHealthState }) {
  const copy = productCopy(locale);
  const scheduleStatus = state.schedule.error ? copy.scheduleUnavailable
    : state.schedule.total === null ? copy.scheduleUnobserved
      : state.schedule.online === 0 ? copy.scheduleNoWorker
        : state.schedule.offline + state.schedule.degraded > 0 ? copy.scheduleAttention : copy.scheduleOnline;
  return <section className="cm-home-health" aria-label={copy.healthHeading}>
    <h2>{copy.healthHeading}</h2>
    <dl>
      <div><dt>{copy.healthApp}</dt><dd data-health={state.app}>{copy[state.app]}</dd></div>
      <div><dt>{copy.healthModel}</dt><dd data-health={state.model}>{state.model === 'verified' ? copy.modelVerified : copy.modelUnverified}</dd>
        <small>{state.model === 'verified' ? copy.modelEvidenceLimit : copy.modelNextStep}</small></div>
      <div><dt>{copy.healthSchedule}</dt><dd data-health={state.schedule.error || state.schedule.offline + state.schedule.degraded > 0 || (state.schedule.total !== null && state.schedule.online === 0) ? 'attention' : 'observed'}>{scheduleStatus}</dd>
        {state.schedule.total !== null && <small>{copy.scheduleWorkers}: {state.schedule.online}/{state.schedule.total} · {copy.scheduleNeedsAttention}: {state.schedule.offline + state.schedule.degraded}</small>}
        {(state.schedule.failed > 0 || state.schedule.uncertain > 0) && <small role="alert">{copy.scheduleOccurrencesAttention.replace('{failed}', String(state.schedule.failed)).replace('{uncertain}', String(state.schedule.uncertain))}</small>}
        {state.schedule.observedAt !== null && <small>{copy.observedAt}: <time dateTime={new Date(state.schedule.observedAt).toISOString()}>{new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(state.schedule.observedAt)}</time></small>}
      </div>
      <div><dt>{copy.healthBusiness}</dt><dd data-health={state.business.error ? 'attention' : state.business.review + state.business.failed + state.business.overdue > 0 ? 'attention' : 'observed'}>
        {state.business.error ? copy.businessUnavailable : businessHealthSummary(locale, state.business)}
      </dd><small>{copy.businessNextStep}</small></div>
    </dl>
  </section>;
}

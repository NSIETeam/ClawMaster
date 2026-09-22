/** Show independent service, model, schedule and business observations on WatchDog home. */
import { businessHealthSummary, productCopy, type ProductLocale } from './locales/frontend.ts';

export interface HomeHealthState {
  app: 'connected' | 'disconnected' | 'connecting';
  model: 'unverified' | 'verified';
  schedule: { error: boolean; observedAt: number | null; total: number | null; online: number; offline: number; degraded: number; failed: number; uncertain: number };
  business: { total: number; review: number; failed: number; overdue: number; error: boolean };
  components: { observed: boolean; available: boolean; components: number | null; disabled: number; refused: boolean; observedAt: string | null };
}

/** Render health facts without inferring model readiness from the app connection. */
export function HomeHealth({ locale, state }: { locale: ProductLocale; state: HomeHealthState }) {
  const copy = productCopy(locale);
  const scheduleStatus = state.schedule.error ? copy.scheduleUnavailable
    : state.schedule.total === null ? copy.scheduleUnobserved
      : state.schedule.online === 0 ? copy.scheduleNoWorker
        : state.schedule.offline + state.schedule.degraded > 0 ? copy.scheduleAttention : copy.scheduleOnline;
  const scheduleHealth = state.schedule.error || state.schedule.offline + state.schedule.degraded + state.schedule.failed + state.schedule.uncertain > 0
    || (state.schedule.total !== null && state.schedule.online === 0) ? 'attention'
    : state.schedule.total === null ? 'unobserved' : 'observed';
  const componentsHealth = state.components.refused ? 'unobserved' : !state.components.observed || !state.components.available ? 'unobserved'
    : state.components.disabled > 0 ? 'attention' : 'observed';
  const componentsStatus = componentsHealth === 'unobserved' ? copy.componentsUnobserved
    : componentsHealth === 'attention' ? copy.componentsDisabled.replace('{count}', String(state.components.disabled))
      : copy.componentsLoaded.replace('{count}', String(state.components.components ?? 0));
  const attentionLayers = [
    state.app === 'connected' ? undefined : copy.healthApp,
    scheduleHealth === 'attention' ? copy.healthSchedule : undefined,
    state.business.error || state.business.review + state.business.failed + state.business.overdue > 0 ? copy.healthBusiness : undefined,
    componentsHealth === 'attention' ? copy.healthComponents : undefined,
  ].filter((layer): layer is string => layer !== undefined);
  return <section className="cm-home-health" aria-label={copy.healthHeading}>
    <div className="cm-home-outcomes">
      <h2>{copy.healthHeading}</h2>
      <dl className="cm-home-business">
        <div><dt>{copy.healthBusiness}</dt><dd data-health={state.business.error ? 'attention' : state.business.review + state.business.failed + state.business.overdue > 0 ? 'attention' : 'observed'}>
          {state.business.error ? copy.businessUnavailable : businessHealthSummary(locale, state.business)}
        </dd><small>{copy.businessNextStep}</small></div>
      </dl>
    </div>
    <p className="cm-home-attention" role="status" data-health={attentionLayers.length === 0 ? 'observed' : 'attention'}>
      {attentionLayers.length === 0 ? copy.healthObserved
        : copy.healthAttention.replace('{layers}', attentionLayers.join(locale === 'zh-CN' ? '、' : ', '))}
    </p>
    <details className="cm-home-system-details">
      <summary>{copy.systemDetails}</summary>
      <dl>
      <div><dt>{copy.healthApp}</dt><dd data-health={state.app}>{copy[state.app]}</dd></div>
      <div><dt>{copy.healthModel}</dt><dd data-health={state.model}>{state.model === 'verified' ? copy.modelVerified : copy.modelUnverified}</dd>
        <small>{state.model === 'verified' ? copy.modelEvidenceLimit : copy.modelNextStep}</small></div>
      <div><dt>{copy.healthSchedule}</dt><dd data-health={scheduleHealth}>{scheduleStatus}</dd>
        {state.schedule.total !== null && <small>{copy.scheduleWorkers}: {state.schedule.online}/{state.schedule.total} · {copy.scheduleNeedsAttention}: {state.schedule.offline + state.schedule.degraded}</small>}
        {(state.schedule.failed > 0 || state.schedule.uncertain > 0) && <small role="alert">{copy.scheduleOccurrencesAttention.replace('{failed}', String(state.schedule.failed)).replace('{uncertain}', String(state.schedule.uncertain))}</small>}
        {state.schedule.observedAt !== null && <small>{copy.observedAt}: <time dateTime={new Date(state.schedule.observedAt).toISOString()}>{new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(state.schedule.observedAt)}</time></small>}
      </div>
      <div><dt>{copy.healthComponents}</dt><dd data-health={componentsHealth}>
        {state.components.refused ? copy.componentsRefused : componentsStatus}</dd>
        <small>{state.components.refused ? copy.componentsNextStep : state.components.observed && state.components.available ? copy.componentsEvidenceLimit : copy.componentsNextStep}</small>
        {state.components.disabled > 0 && <small role="alert">{copy.componentsDisabled.replace('{count}', String(state.components.disabled))}</small>}
      </div>
      </dl>
    </details>
  </section>;
}

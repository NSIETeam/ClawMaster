import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client';

export interface SessionModelEvidenceSource {
  getSnapshot(): SessionEventWindow;
  subscribe(listener: () => void): () => void;
}

/** Whether a loaded Session window contains a durably recorded model response. */
export function hasRecordedModelResponse(window: SessionEventWindow): boolean {
  return window.entries.some(entry => entry.type === 'event' && entry.event.type === 'assistant/message'
    && !entry.event.data.interrupted);
}

/** Observe loaded Session windows and report when any records a model response. */
export function observeModelResponses(sources: readonly SessionModelEvidenceSource[], onObserved: () => void): () => void {
  let observed = false;
  const check = () => {
    if (!observed && sources.some(source => hasRecordedModelResponse(source.getSnapshot()))) {
      observed = true;
      onObserved();
    }
  };
  const unsubscribe = sources.map(source => source.subscribe(check));
  check();
  return () => { for (const dispose of unsubscribe) dispose(); };
}

/** Graph Memory sidebar registration and initial index status view. */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { GraphMemoryApi } from './client-api.ts';
import { graphMemoryCopy, type GraphMemoryLocale } from './locales.ts';
import type { z } from 'zod';
import type { graphPanelSchema } from './protocol.ts';
import { GraphMemoryContent } from './panel.tsx';
import styles from './styles.css';

export const name = 'clawmaster-graph-memory';
export const inject = ['betterSidebar', 'locale'];

export interface GraphMemoryClientServices {
  effect(install: () => () => void, label?: string): void;
  locale: { getSnapshot(): { active: string }; subscribe(listener: () => void): () => void };
  betterSidebar: {
    registerTab(descriptor: {
      id: string;
      title: string | (() => string);
      description?: string | (() => string);
      icon?: ReactNode | ((size: number) => ReactNode);
      order?: number;
      single?: boolean;
      component(props: { scope: { sessionId: string }; visible: boolean }): ReactNode;
    }): () => void;
  };
}

function GraphIcon({ size = 18 }: { size?: number }): ReactNode {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" />
    <path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6" />
  </svg>;
}

function GraphMemoryPanel({ ctx, visible }: { ctx: GraphMemoryClientServices; visible: boolean }): ReactNode {
  const locale: GraphMemoryLocale = useSyncExternalStore(
    listener => ctx.locale.subscribe(listener),
    () => ctx.locale.getSnapshot().active,
  ).startsWith('zh') ? 'zh-CN' : 'en-US';
  const text = graphMemoryCopy(locale);
  const api = useMemo(() => new GraphMemoryApi((input, init) => fetch(input as string, init)), []);
  const [data, setData] = useState<z.infer<typeof graphPanelSchema>>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void api.graph().then(value => { if (!cancelled) setData(value); }, reason => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [api, visible]);
  if (error !== undefined) return <section className="cm-graph-memory"><p>{text.error}: {error}</p></section>;
  if (data === undefined) return <section className="cm-graph-memory"><p>{text.loading}</p></section>;
  if (data.graph.generatedAt === '') return <section className="cm-graph-memory"><p>{text.empty}</p></section>;
  return <GraphMemoryContent data={data} locale={locale} />;
}

export function apply(ctx: GraphMemoryClientServices): void {
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'clawmaster-graph-memory',
    title: () => graphMemoryCopy(ctx.locale.getSnapshot().active.startsWith('zh') ? 'zh-CN' : 'en-US').tab,
    description: () => graphMemoryCopy(ctx.locale.getSnapshot().active.startsWith('zh') ? 'zh-CN' : 'en-US').description,
    icon: size => <GraphIcon size={size} />,
    order: 31,
    single: true,
    component: ({ visible }) => <GraphMemoryPanel ctx={ctx} visible={visible} />,
  }), 'clawmaster: graph memory sidebar');
}

export { styles };
export { GraphMemoryContent } from './panel.tsx';

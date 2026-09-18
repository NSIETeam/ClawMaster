/** Pure Graph Memory topic and similarity presentation. */
import type { ReactNode } from 'react';
import type { z } from 'zod';
import { graphMemoryCopy, type GraphMemoryLocale } from './locales.ts';
import type { graphPanelSchema } from './protocol.ts';

type GraphPanel = z.infer<typeof graphPanelSchema>;

/** Render topic pages and evidence-backed similar-file pairs. */
export function GraphMemoryContent({ data, locale }: { data: GraphPanel; locale: GraphMemoryLocale }): ReactNode {
  const text = graphMemoryCopy(locale);
  const byId = new Map(data.graph.nodes.map(node => [node.id, node]));
  const seen = new Set<string>();
  const similar = data.graph.edges.filter(edge => ['similar_to', 'co_cited', 'duplicate_of'].includes(edge.kind)).filter(edge => {
    const key = [edge.src, edge.dst].sort().join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => right.weight - left.weight).slice(0, 8);
  return <section className="cm-graph-memory">
    <dl>
      <div><dt>{text.nodes}</dt><dd>{data.graph.nodes.length}</dd></div>
      <div><dt>{text.edges}</dt><dd>{data.graph.edges.length}</dd></div>
      <div><dt>{text.themes}</dt><dd>{data.themes.length}</dd></div>
    </dl>
    <h3>{text.themes}</h3>
    <ul>{data.themes.map(theme => <li key={theme.id}><strong>{theme.title}</strong><span>{theme.size} {text.members}</span></li>)}</ul>
    <h3>{text.similar}</h3>
    <ul>{similar.map(edge => <li key={`${edge.src}:${edge.dst}:${edge.kind}`}>
      <strong>{byId.get(edge.src)?.title ?? edge.src} ↔ {byId.get(edge.dst)?.title ?? edge.dst}</strong>
      <span>{text.evidence}: {edge.evidence}</span>
    </li>)}</ul>
  </section>;
}

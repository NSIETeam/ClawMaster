/** Interactive, evidence-backed relationship graph for notes, memory and files. */
import { memo, useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, WheelEvent } from 'react';
import type { z } from 'zod';
import { graphMemoryCopy, type GraphMemoryLocale } from './locales.ts';
import type { GraphEdge, GraphNode } from './model.ts';
import type { graphPanelSchema } from './protocol.ts';

type GraphPanel = z.infer<typeof graphPanelSchema>;
type NodeKind = GraphNode['kind'];
type Point = GraphNode & { x: number; y: number; degree: number };
type Transform = { x: number; y: number; scale: number };

const WIDTH = 1120;
const HEIGHT = 720;
const MAX_NODES = 140;
const NODE_COLORS: Record<NodeKind, string> = {
  note: '#9b7cff', memory: '#4fd1c5', file: '#7890ad', tag: '#f2b866', stub: '#7d8290', cluster: '#ef7e9b',
};
const KIND_ORDER: NodeKind[] = ['note', 'memory', 'file', 'tag', 'cluster', 'stub'];

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return result >>> 0;
}

/** A bounded deterministic force pass keeps the graph stable between openings without a runtime dependency. */
function layout(nodes: GraphNode[], edges: GraphEdge[]): Point[] {
  const degree = new Map(nodes.map(node => [node.id, 0]));
  for (const edge of edges) {
    degree.set(edge.src, (degree.get(edge.src) ?? 0) + 1);
    degree.set(edge.dst, (degree.get(edge.dst) ?? 0) + 1);
  }
  const ranked = [...nodes].sort((left, right) => (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0)).slice(0, MAX_NODES);
  const accepted = new Set(ranked.map(node => node.id));
  const links = edges.filter(edge => accepted.has(edge.src) && accepted.has(edge.dst));
  const points = ranked.map((node, index) => {
    const kindIndex = KIND_ORDER.indexOf(node.kind);
    const sector = (kindIndex / KIND_ORDER.length) * Math.PI * 2;
    const jitter = ((hash(node.id) % 1000) / 1000 - .5) * 1.1;
    const radius = 110 + (index % 8) * 24 + (hash(`${node.id}:r`) % 46);
    return { ...node, x: WIDTH / 2 + Math.cos(sector + jitter) * radius, y: HEIGHT / 2 + Math.sin(sector + jitter) * radius * .72, degree: degree.get(node.id) ?? 0 };
  });
  const byId = new Map(points.map(point => [point.id, point]));
  for (let step = 0; step < 70; step += 1) {
    const force = new Map(points.map(point => [point.id, { x: (WIDTH / 2 - point.x) * .0018, y: (HEIGHT / 2 - point.y) * .0018 }]));
    for (let left = 0; left < points.length; left += 1) {
      for (let right = left + 1; right < points.length; right += 1) {
        const a = points[left]; const b = points[right];
        if (!a || !b) continue;
        const dx = a.x - b.x; const dy = a.y - b.y; const distance2 = Math.max(100, dx * dx + dy * dy);
        const strength = 1250 / distance2;
        const af = force.get(a.id); const bf = force.get(b.id);
        if (af && bf) { af.x += dx * strength; af.y += dy * strength; bf.x -= dx * strength; bf.y -= dy * strength; }
      }
    }
    for (const edge of links) {
      const a = byId.get(edge.src); const b = byId.get(edge.dst);
      if (!a || !b) continue;
      const dx = b.x - a.x; const dy = b.y - a.y; const distance = Math.max(1, Math.hypot(dx, dy));
      const pull = (distance - (edge.kind === 'in_cluster' ? 72 : 108)) * .0055 * Math.max(.35, edge.weight);
      const af = force.get(a.id); const bf = force.get(b.id);
      if (af && bf) { af.x += dx / distance * pull; af.y += dy / distance * pull; bf.x -= dx / distance * pull; bf.y -= dy / distance * pull; }
    }
    for (const point of points) {
      const delta = force.get(point.id);
      if (!delta) continue;
      point.x = Math.min(WIDTH - 36, Math.max(36, point.x + Math.max(-8, Math.min(8, delta.x))));
      point.y = Math.min(HEIGHT - 36, Math.max(36, point.y + Math.max(-8, Math.min(8, delta.y))));
    }
  }
  return points;
}

function nodeRadius(point: Point): number {
  return Math.min(13, 5.5 + Math.sqrt(point.degree + 1) * 1.45 + (point.kind === 'cluster' ? 2 : 0));
}

const Network = memo(function Network({ nodes, edges, selectedId, matches, transform, ariaLabel, onSelect, onPan, onWheel }: {
  nodes: Point[]; edges: GraphEdge[]; selectedId: string | undefined; matches: ReadonlySet<string>; transform: Transform;
  ariaLabel: string;
  onSelect(id: string): void; onPan(event: ReactPointerEvent<SVGSVGElement>): void; onWheel(event: WheelEvent<SVGSVGElement>): void;
}): ReactNode {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const connected = new Set<string>();
  if (selectedId) for (const edge of edges) {
    if (edge.src === selectedId) connected.add(edge.dst);
    if (edge.dst === selectedId) connected.add(edge.src);
  }
  const labelIds = new Set(nodes.filter(node => node.degree >= 3 || node.kind === 'cluster' || node.id === selectedId || matches.has(node.id)).map(node => node.id));
  const keySelect = (event: KeyboardEvent<SVGGElement>, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(id); }
  };
  return <svg className="cm-graph-canvas" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={ariaLabel}
    onPointerDown={onPan} onWheel={onWheel}>
    <defs>
      <pattern id="cm-graph-grid" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".7" fill="#414653" /></pattern>
      <filter id="cm-graph-glow"><feGaussianBlur stdDeviation="5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
    </defs>
    <rect width={WIDTH} height={HEIGHT} fill="url(#cm-graph-grid)" opacity=".28" />
    <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
      <g className="cm-graph-edges">{edges.map((edge, index) => {
        const source = byId.get(edge.src); const target = byId.get(edge.dst);
        if (!source || !target) return null;
        const active = selectedId === undefined || edge.src === selectedId || edge.dst === selectedId;
        return <line key={`${edge.src}:${edge.dst}:${edge.kind}:${index}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y}
          data-kind={edge.kind} data-active={active} style={{ strokeWidth: Math.max(.45, Math.min(2.4, edge.weight * 1.8)) }} />;
      })}</g>
      <g className="cm-graph-nodes">{nodes.map(node => {
        const selected = node.id === selectedId;
        const dimmed = selectedId !== undefined && !selected && !connected.has(node.id);
        const matched = matches.has(node.id);
        const radius = nodeRadius(node);
        return <g key={node.id} role="button" tabIndex={0} aria-label={`${node.title}, ${node.kind}`}
          className="cm-graph-node" data-selected={selected} data-dimmed={dimmed} data-matched={matched}
          transform={`translate(${node.x} ${node.y})`} onPointerDown={event => event.stopPropagation()}
          onClick={() => onSelect(node.id)} onKeyDown={event => keySelect(event, node.id)}>
          {selected && <circle r={radius + 8} className="cm-graph-node-halo" fill={NODE_COLORS[node.kind]} filter="url(#cm-graph-glow)" />}
          {matched && !selected && <circle r={radius + 5} className="cm-graph-node-match" />}
          <circle r={radius} fill={NODE_COLORS[node.kind]} />
          {labelIds.has(node.id) && <text x={radius + 7} y="4">{node.title.slice(0, 28)}</text>}
        </g>;
      })}</g>
    </g>
  </svg>;
});

/** Render a real relationship canvas and a contextual inspector from one graph snapshot. */
export function GraphMemoryContent({ data, locale }: { data: GraphPanel; locale: GraphMemoryLocale }): ReactNode {
  const text = graphMemoryCopy(locale);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const [mode, setMode] = useState<'global' | 'local'>('global');
  const [selectedId, setSelectedId] = useState<string | undefined>(() => data.graph.nodes.find(node => node.kind !== 'cluster')?.id ?? data.graph.nodes[0]?.id);
  const [kinds, setKinds] = useState<ReadonlySet<NodeKind>>(() => new Set(KIND_ORDER));
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number }>();

  const nodeById = useMemo(() => new Map(data.graph.nodes.map(node => [node.id, node])), [data.graph.nodes]);
  const selected = selectedId === undefined ? undefined : nodeById.get(selectedId);
  const neighborhood = useMemo(() => {
    if (mode === 'global' || selectedId === undefined) return undefined;
    const result = new Set([selectedId]);
    for (const edge of data.graph.edges) {
      if (edge.src === selectedId) result.add(edge.dst);
      if (edge.dst === selectedId) result.add(edge.src);
    }
    return result;
  }, [data.graph.edges, mode, selectedId]);
  const visibleNodes = useMemo(() => data.graph.nodes.filter(node => kinds.has(node.kind) && (neighborhood?.has(node.id) ?? true)), [data.graph.nodes, kinds, neighborhood]);
  const visibleIds = useMemo(() => new Set(visibleNodes.map(node => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(() => data.graph.edges.filter(edge => visibleIds.has(edge.src) && visibleIds.has(edge.dst)), [data.graph.edges, visibleIds]);
  const points = useMemo(() => layout(visibleNodes, visibleEdges), [visibleEdges, visibleNodes]);
  const pointIds = useMemo(() => new Set(points.map(point => point.id)), [points]);
  const drawnEdges = useMemo(() => visibleEdges.filter(edge => pointIds.has(edge.src) && pointIds.has(edge.dst)), [pointIds, visibleEdges]);
  const matches = useMemo(() => new Set(deferredQuery === '' ? [] : points.filter(node => `${node.title} ${node.path ?? ''}`.toLocaleLowerCase().includes(deferredQuery)).map(node => node.id)), [deferredQuery, points]);
  const connections = useMemo(() => selectedId === undefined ? [] : data.graph.edges.filter(edge => edge.src === selectedId || edge.dst === selectedId).map(edge => ({ edge, node: nodeById.get(edge.src === selectedId ? edge.dst : edge.src), incoming: edge.dst === selectedId })).filter((entry): entry is { edge: GraphEdge; node: GraphNode; incoming: boolean } => entry.node !== undefined).sort((a, b) => b.edge.weight - a.edge.weight), [data.graph.edges, nodeById, selectedId]);

  const toggleKind = (kind: NodeKind) => setKinds(current => {
    const next = new Set(current);
    if (next.has(kind)) next.delete(kind); else next.add(kind);
    return next;
  });
  const zoom = useCallback((factor: number) => setTransform(current => ({ ...current, scale: Math.max(.35, Math.min(2.8, current.scale * factor)) })), []);
  const panStart = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: transform.x, originY: transform.y };
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const active = drag.current; if (!active || active.pointerId !== moveEvent.pointerId) return;
      setTransform(current => ({ ...current, x: active.originX + moveEvent.clientX - active.x, y: active.originY + moveEvent.clientY - active.y }));
    };
    const up = (upEvent: PointerEvent) => {
      if (drag.current?.pointerId !== upEvent.pointerId) return;
      drag.current = undefined; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }, [transform.x, transform.y]);
  const wheel = useCallback((event: WheelEvent<SVGSVGElement>) => { event.preventDefault(); zoom(event.deltaY > 0 ? .9 : 1.1); }, [zoom]);

  return <section className="cm-graph-memory">
    <header className="cm-graph-toolbar">
      <div className="cm-graph-heading"><span className="cm-graph-mark"><i /><i /><i /></span><div><h2>{text.tab}</h2><p>{data.graph.nodes.length} {text.nodes} · {data.graph.edges.length} {text.edges}</p></div></div>
      <label className="cm-graph-search"><span aria-hidden="true">⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={text.search} aria-label={text.search} /></label>
      <div className="cm-graph-mode" role="group" aria-label={text.tab}>
        <button type="button" data-active={mode === 'global'} onClick={() => setMode('global')}>{text.global}</button>
        <button type="button" data-active={mode === 'local'} onClick={() => setMode('local')} disabled={selectedId === undefined}>{text.local}</button>
      </div>
    </header>
    <div className="cm-graph-stage">
      <div className="cm-graph-filter" aria-label={text.filters}>
        {KIND_ORDER.map(kind => <button key={kind} type="button" data-active={kinds.has(kind)} onClick={() => toggleKind(kind)}>
          <i style={{ background: NODE_COLORS[kind] }} />{text[kind]}
        </button>)}
      </div>
      <Network nodes={points} edges={drawnEdges} selectedId={selectedId} matches={matches} transform={transform} ariaLabel={text.tab}
        onSelect={setSelectedId} onPan={panStart} onWheel={wheel} />
      <div className="cm-graph-zoom">
        <button type="button" aria-label={text.zoomIn} title={text.zoomIn} onClick={() => zoom(1.2)}>+</button>
        <button type="button" aria-label={text.zoomOut} title={text.zoomOut} onClick={() => zoom(.8)}>−</button>
        <button type="button" aria-label={text.fit} title={text.fit} onClick={() => setTransform({ x: 0, y: 0, scale: 1 })}>⌗</button>
      </div>
      <div className="cm-graph-count">{text.showing} {points.length} {text.of} {data.graph.nodes.length}</div>
    </div>
    <aside className="cm-graph-inspector">
      {selected ? <>
        <div className="cm-graph-inspector-head"><span className="cm-graph-kind" style={{ color: NODE_COLORS[selected.kind] }}>{text[selected.kind]}</span><h3>{selected.title}</h3>{selected.path && <p>{selected.path}</p>}</div>
        <dl className="cm-graph-facts">
          <div><dt>{text.connections}</dt><dd>{connections.length}</dd></div>
          <div><dt>{text.updated}</dt><dd>{selected.mtimeMs > 0 ? new Date(selected.mtimeMs).toLocaleDateString(locale) : '—'}</dd></div>
        </dl>
        <section className="cm-graph-relations"><h4>{text.connections}<span>{connections.length}</span></h4>
          {connections.length === 0 ? <p className="cm-graph-muted">{text.isolated}</p> : connections.map(({ edge, node, incoming }, index) => <button type="button" key={`${edge.src}:${edge.dst}:${edge.kind}:${index}`} onClick={() => setSelectedId(node.id)}>
            <span className="cm-graph-relation-title"><i style={{ background: NODE_COLORS[node.kind] }} /><strong>{node.title}</strong></span>
            <span><b>{incoming ? '←' : '→'} {edge.kind.replaceAll('_', ' ')}</b><em>{Math.round(edge.weight * 100)}%</em></span>
            <small>{text.evidence}: {edge.evidence}</small>
          </button>)}
        </section>
      </> : <p className="cm-graph-empty">{text.noSelection}</p>}
    </aside>
  </section>;
}

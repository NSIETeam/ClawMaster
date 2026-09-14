/** Browser transport for Graph Memory's authenticated routes. */
import { GRAPH_MEMORY_GRAPH_PATH, GRAPH_MEMORY_QUERY_PATH, graphPanelSchema, graphQueryResultSchema, type GraphQuery, type GraphQueryResult } from './protocol.ts';

export class GraphMemoryApi {
  constructor(private readonly request: typeof fetch) {}

  private async call(path: string): Promise<unknown> {
    const response = await this.request(path, { credentials: 'same-origin' });
    const body = await response.json();
    if (!response.ok) throw new Error(`Graph Memory request failed with ${response.status}.`);
    return body;
  }

  async graph() {
    return graphPanelSchema.parse(await this.call(GRAPH_MEMORY_GRAPH_PATH));
  }

  async query(input: GraphQuery): Promise<GraphQueryResult> {
    const params = new URLSearchParams();
    if (input.query !== undefined) params.set('q', input.query);
    if (input.file !== undefined) params.set('file', input.file);
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    if (input.hops !== undefined) params.set('hops', String(input.hops));
    return graphQueryResultSchema.parse(await this.call(`${GRAPH_MEMORY_QUERY_PATH}?${params}`));
  }
}

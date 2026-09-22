export type GraphMemoryLocale = 'zh-CN' | 'en-US';

const copy = {
  'zh-CN': {
    tab: '知识图谱', description: '笔记、记忆与文件的关系网络', loading: '正在读取索引…', empty: '索引尚未建立',
    nodes: '节点', edges: '关系', themes: '主题', similar: '相似内容', evidence: '关系依据', members: '项', error: '读取失败',
    search: '搜索节点', global: '全局图谱', local: '局部图谱', filters: '显示节点', inspector: '节点详情',
    connections: '连接', backlinks: '反向链接', path: '来源', kind: '类型', updated: '索引时间',
    reset: '重置视图', fit: '适应画布', zoomIn: '放大', zoomOut: '缩小', noSelection: '选择一个节点查看关系',
    note: '笔记', memory: '记忆', file: '文件', tag: '标签', stub: '未解析', cluster: '主题',
    relation: '关系', weight: '强度', showing: '当前显示', of: '共', isolated: '这个节点没有可见连接',
  },
  'en-US': {
    tab: 'Knowledge Graph', description: 'Relationship network across notes, memory and files', loading: 'Loading index…', empty: 'The index has not been built',
    nodes: 'Nodes', edges: 'Relations', themes: 'Topics', similar: 'Similar content', evidence: 'Evidence', members: 'items', error: 'Could not load the graph',
    search: 'Search nodes', global: 'Global graph', local: 'Local graph', filters: 'Visible nodes', inspector: 'Node details',
    connections: 'Connections', backlinks: 'Backlinks', path: 'Source', kind: 'Type', updated: 'Indexed',
    reset: 'Reset view', fit: 'Fit canvas', zoomIn: 'Zoom in', zoomOut: 'Zoom out', noSelection: 'Select a node to inspect its relationships',
    note: 'Note', memory: 'Memory', file: 'File', tag: 'Tag', stub: 'Unresolved', cluster: 'Topic',
    relation: 'Relation', weight: 'Weight', showing: 'Showing', of: 'of', isolated: 'This node has no visible connections',
  },
} as const;

export function graphMemoryCopy(locale: GraphMemoryLocale) {
  return copy[locale];
}

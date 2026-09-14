export type GraphMemoryLocale = 'zh-CN' | 'en-US';

const copy = {
  'zh-CN': {
    tab: '记忆图谱', description: '笔记与记忆的统一检索', loading: '正在读取索引…', empty: '索引尚未建立',
    nodes: '节点', edges: '关系', themes: '主题', similar: '相似文件', evidence: '依据', members: '项', error: '读取失败',
  },
  'en-US': {
    tab: 'Memory Graph', description: 'Unified retrieval across notes and memory', loading: 'Loading index…', empty: 'The index has not been built',
    nodes: 'Nodes', edges: 'Relations', themes: 'Topics', similar: 'Similar files', evidence: 'Evidence', members: 'items', error: 'Could not load the graph',
  },
} as const;

export function graphMemoryCopy(locale: GraphMemoryLocale) {
  return copy[locale];
}

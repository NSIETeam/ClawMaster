/**
 * Panel copy. The PDF panel is a tool, so every string is a control or a result — no prose.
 */
export interface PdfCopy {
  tab: string;
  tabDescription: string;
  path: string;
  pathPlaceholder: string;
  inspect: string;
  pages: string;
  size: string;
  rotation: string;
  operation: string;
  pagesSelection: string;
  pagesHint: string;
  apply: string;
  rotate: string;
  delete: string;
  extract: string;
  reorder: string;
  watermark: string;
  watermarkText: string;
  pageNumbers: string;
  merge: string;
  inputs: string;
  inputsHint: string;
  inPlace: string;
  inPlaceHint: string;
  results: string;
  revision: string;
  noResults: string;
  stirling: string;
  stirlingMissing: string;
  delegated: string;
  working: string;
  invalidPath: string;
}

const ZH: PdfCopy = {
  tab: 'PDF',
  tabDescription: '合并、拆分、旋转、水印与元数据',
  path: '文件',
  pathPlaceholder: '相对任务目录，例如 合同.pdf',
  inspect: '查看结构',
  pages: '页数',
  size: '大小',
  rotation: '旋转',
  operation: '操作',
  pagesSelection: '页码',
  pagesHint: '如 1,3-5 / last / -2--1 / all',
  apply: '执行',
  rotate: '旋转',
  delete: '删除',
  extract: '拆分',
  reorder: '重排',
  watermark: '水印',
  watermarkText: '水印文字（仅拉丁字符）',
  pageNumbers: '页码',
  merge: '合并',
  inputs: '一起处理的文件',
  inputsHint: '用逗号分隔，例如 附件.pdf,封面.pdf',
  inPlace: '直接覆盖原文件',
  inPlaceHint: '默认在旁边生成新文件，原文件不动',
  results: '结果',
  revision: '修订',
  noResults: '还没有执行过操作。',
  stirling: '可选组件 Stirling-PDF',
  stirlingMissing: '未安装或未启用',
  delegated: '内置工具不做、留给它的能力',
  working: '处理中…',
  invalidPath: '路径必须相对任务目录，且以 .pdf 结尾。',
};

const EN: PdfCopy = {
  tab: 'PDF',
  tabDescription: 'Merge, split, rotate, watermark and metadata',
  path: 'File',
  pathPlaceholder: 'Relative to the task folder, e.g. contract.pdf',
  inspect: 'Inspect',
  pages: 'Pages',
  size: 'Size',
  rotation: 'Rotation',
  operation: 'Operation',
  pagesSelection: 'Pages',
  pagesHint: 'e.g. 1,3-5 / last / -2--1 / all',
  apply: 'Run',
  rotate: 'Rotate',
  delete: 'Delete',
  extract: 'Split',
  reorder: 'Reorder',
  watermark: 'Watermark',
  watermarkText: 'Watermark text (Latin only)',
  pageNumbers: 'Page numbers',
  merge: 'Merge',
  inputs: 'Files to use',
  inputsHint: 'Comma separated, e.g. annex.pdf,cover.pdf',
  inPlace: 'Overwrite the original',
  inPlaceHint: 'A new file is written beside it by default',
  results: 'Results',
  revision: 'Revision',
  noResults: 'Nothing has been run yet.',
  stirling: 'Optional Stirling-PDF component',
  stirlingMissing: 'not installed or not enabled',
  delegated: 'Left to it by the built-in tools',
  working: 'Working…',
  invalidPath: 'A path must be relative to the task folder and end in .pdf.',
};

/** The copy for one locale tag. */
export function pdfCopy(locale: string): PdfCopy {
  return locale.startsWith('zh') ? ZH : EN;
}

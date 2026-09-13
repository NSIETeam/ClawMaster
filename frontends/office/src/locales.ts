/** Office viewer copy follows the host's selected language. */
import type { OfficeLocale } from './protocol.ts';
const zh = {
  docx: 'Word 文档', xlsx: 'Excel 工作簿', pptx: 'PowerPoint 演示文稿',
  loading: '正在读取文档…', opening: '正在打开编辑器…', ready: '已打开', saving: '正在保存…', saved: '已保存',
  'load-error': '文档未能打开。请重新打开后重试。',
  'save-error': '未确认保存成功，草稿仍保留。可以在编辑器中重试，或下载当前副本。',
  conflict: '磁盘文件已变化，未覆盖原文件。请下载当前副本，或关闭后重新打开最新文件。',
  dirty: '未保存', recovery: '下载当前副本', legal: 'ONLYOFFICE · 许可与源码', editor: 'Office 编辑器',
};
const en: Record<keyof typeof zh, string> = {
  docx: 'Word document', xlsx: 'Excel workbook', pptx: 'PowerPoint presentation',
  loading: 'Reading document…', opening: 'Opening editor…', ready: 'Opened', saving: 'Saving…', saved: 'Saved',
  'load-error': 'The document could not be opened. Close it and reopen to retry.',
  'save-error': 'Saving was not confirmed. Your draft is retained. Retry in the editor or download a copy.',
  conflict: 'The file changed on disk and was not overwritten. Download your draft or reopen the latest file.',
  dirty: 'Unsaved', recovery: 'Download current copy', legal: 'ONLYOFFICE · License and source', editor: 'Office editor',
};
export function officeCopy(locale: OfficeLocale): typeof zh { return locale === 'zh-CN' ? zh : en; }

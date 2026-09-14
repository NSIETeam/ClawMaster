/** Additional enterprise-panel labels; shared product copy remains in frontend.locales. */
import type { ProductLocale } from './frontend.ts';
import type { EnterpriseCommand } from '../enterprise-types.ts';

const zh = {
  restoreUncertain: '恢复结果尚未确认。请刷新核对当前数据后再继续操作。',
  backupFailed: '备份下载失败，请检查连接后重试。',
  staleForm: '数据已恢复，当前表单或确认属于恢复前的数据。输入已保留；请复制需要的内容，取消并重新打开后核对再提交。',
  pending: '上次保存的结果尚未确认。请重试同一请求，系统会防止重复写入；当前输入已保留。',
  retryPending: '重试同一请求', deleteConfirm: '确认删除这条记录？删除操作会保留变更记录。',
  confirmDelete: '确认删除', confirmSubmit: '确认提交订单', before: '修改前', after: '修改后',
  allCustomers: '全部客户', onlyDue: '只看待跟进', onlyLowStock: '只看低库存', noFiltered: '没有符合筛选条件的记录。',
  contactsCount: '客户数', dueCount: '待跟进数', inventoryCount: '物料数', lowStockCount: '低库存数',
  sourceLocal: '本机工作台', stageFilter: '筛选客户阶段', orderKindFilter: '筛选订单类型', orderStatusFilter: '筛选订单状态',
  orderSearch: '搜索客户、供应商、备注或订单编号', orderId: '订单编号', recordId: '记录编号',
  required: '必填', optional: '选填', closeEditor: '关闭编辑器', stockUnit: '件',
  noDate: '未安排日期', noAction: '未填写跟进行动', noCompany: '未填写公司', noSupplier: '未填写供应商',
  addInventoryFirst: '请先建立物料，再创建采购或销售订单。', currency: '人民币（CNY）',
  saveDraft: '保存草稿', saved: '已保存到本机工作台。', deleted: '记录已删除，变更历史已保留。',
  submittedNotice: '订单已提交，库存和变更记录已更新。', emptyOrder: '至少添加一条订单明细。',
  duplicateLine: '同一物料不能重复出现，请合并数量。', priceHint: '最多两位小数，不使用科学计数法。',
  draftHint: '保存草稿不会改变库存；确认提交后才会入库或出库。',
  viewSubmitted: '已提交订单仅可查看。', submitImpact: '本次库存变化',
  selectLineItem: '订单物料', lineQuantity: '明细数量', linePrice: '明细单价（元）',
  historyShowing: '已显示记录', loadMore: '显示更多变更', next: '下一步',
  auditContactSave: '保存客户', auditContactDelete: '删除客户', auditItemSave: '保存物料 / 库存校正',
  auditItemDelete: '删除物料', auditOrderSave: '保存订单草稿', auditOrderDelete: '删除订单草稿', auditOrderSubmit: '提交订单 / 库存变动',
  noRecord: '无记录', lineSummary: '明细', allOrders: '全部订单', localBackup: '下载本机数据备份', restoreBackup: '恢复本机数据备份', restoreSelect: '选择备份文件', restorePreview: '备份预览', restoreConfirm: '确认恢复', restoreCancel: '取消恢复', restoreSuccess: '备份已恢复。', restoreInvalid: '备份文件无效或已损坏。',
} as const;

type EnterpriseCopy = { [K in keyof typeof zh]: string };
const en: EnterpriseCopy = {
  restoreUncertain: 'The restore outcome is unknown. Refresh and review the current records before continuing.',
  backupFailed: 'Backup download failed. Check the connection and retry.',
  staleForm: 'The database was restored after this form or confirmation was opened. Your inputs are retained. Copy anything you need, cancel, and reopen to review the current records before submitting.',
  pending: 'The last save has not been confirmed. Retry the same request to resolve it without duplicate writes. Your inputs are retained.',
  retryPending: 'Retry same request', deleteConfirm: 'Delete this record? The change history will be retained.',
  confirmDelete: 'Confirm deletion', confirmSubmit: 'Confirm order submission', before: 'Before', after: 'After',
  allCustomers: 'All contacts', onlyDue: 'Follow-ups due only', onlyLowStock: 'Low stock only', noFiltered: 'No records match these filters.',
  contactsCount: 'Contacts', dueCount: 'Follow-ups due', inventoryCount: 'Items', lowStockCount: 'Low stock items',
  sourceLocal: 'Local workbench', stageFilter: 'Filter contact stage', orderKindFilter: 'Filter order type', orderStatusFilter: 'Filter order status',
  orderSearch: 'Search customer, supplier, note or order ID', orderId: 'Order ID', recordId: 'Record ID',
  required: 'Required', optional: 'Optional', closeEditor: 'Close editor', stockUnit: 'units',
  noDate: 'No date scheduled', noAction: 'No next action', noCompany: 'No company', noSupplier: 'No supplier',
  addInventoryFirst: 'Create an inventory item before adding purchase or sale orders.', currency: 'Chinese yuan (CNY)',
  saveDraft: 'Save draft', saved: 'Saved to the local workbench.', deleted: 'Record deleted; change history retained.',
  submittedNotice: 'Order submitted. Stock and change history were updated.', emptyOrder: 'Add at least one order line.',
  duplicateLine: 'Each item can appear only once. Combine its quantities.', priceHint: 'Up to two decimal places; no scientific notation.',
  draftHint: 'Saving a draft does not change stock. Confirm submission to receive or dispatch items.',
  viewSubmitted: 'Submitted orders are read-only.', submitImpact: 'Stock changes on submission',
  selectLineItem: 'Order item', lineQuantity: 'Line quantity', linePrice: 'Line unit price (CNY)',
  historyShowing: 'Records displayed', loadMore: 'Show more changes', next: 'Next',
  auditContactSave: 'Save contact', auditContactDelete: 'Delete contact', auditItemSave: 'Save item / correct stock',
  auditItemDelete: 'Delete item', auditOrderSave: 'Save order draft', auditOrderDelete: 'Delete order draft', auditOrderSubmit: 'Submit order / move stock',
  noRecord: 'No record', lineSummary: 'Lines', allOrders: 'All orders', localBackup: 'Download local data backup', restoreBackup: 'Restore local backup', restoreSelect: 'Choose backup file', restorePreview: 'Backup preview', restoreConfirm: 'Confirm restore', restoreCancel: 'Cancel restore', restoreSuccess: 'Backup restored.', restoreInvalid: 'The backup file is invalid or damaged.',
};

/** Resolve labels owned by the enterprise panels. */
export function enterpriseCopy(locale: ProductLocale): EnterpriseCopy { return locale === 'zh-CN' ? zh : en; }

/**
 * Resolve a human-readable action label for a persisted audit entry.
 * @param type Business command discriminant.
 * @param locale Product language.
 * @returns The localized action name.
 */
export function enterpriseActionLabel(type: EnterpriseCommand['type'], locale: ProductLocale): string {
  const t = enterpriseCopy(locale);
  const labels: Record<EnterpriseCommand['type'], string> = {
    'contact.upsert': t.auditContactSave, 'contact.remove': t.auditContactDelete,
    'item.upsert': t.auditItemSave, 'item.remove': t.auditItemDelete,
    'order.save': t.auditOrderSave, 'order.remove': t.auditOrderDelete, 'order.submit': t.auditOrderSubmit,
  };
  return labels[type];
}

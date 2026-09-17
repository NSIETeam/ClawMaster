/** Product copy shared by WatchDog navigation and enterprise panels. */
export type ProductLocale = 'zh-CN' | 'en-US';
export type ProductModule = 'editor' | 'browser' | 'terminal' | 'crm' | 'erp';

const zh = {
  brand: 'ClawMaster',
  watchdog: 'WatchDog', slogan: '开启AI时代的企业协作', connected: '应用服务已连接', disconnected: '应用服务连接已断开', connecting: '正在连接应用服务', connectionScope: '此状态仅表示界面与应用服务的连接；模型、定时执行和业务结果需要分别核实。',
  healthHeading: '运行状态与待处理结果', healthApp: '应用服务', healthModel: '模型', healthSchedule: '定时执行', healthBusiness: '业务结果', modelVerified: '已记录成功的模型响应', modelEvidenceLimit: '这证明会话中曾有成功响应，不代表模型此刻仍可用。', modelUnverified: '尚未在已载入会话中观察到成功响应', modelNextStep: '发送一次实际任务；收到模型响应后会更新此状态。', scheduleUnavailable: '读取失败，请刷新巡检状态', scheduleUnobserved: '尚未取得执行器心跳', scheduleNoWorker: '当前没有在线执行器', scheduleAttention: '有执行器离线或状态异常', scheduleOnline: '执行器在线', scheduleWorkers: '在线执行器', scheduleNeedsAttention: '需关注', scheduleOccurrencesAttention: '定时实例待处理：失败 {failed} 项，投递结果待核实 {uncertain} 项。请检查记录；系统不会自动重放不确定投递。', observedAt: '最近观测', businessUnavailable: '业务任务暂不可读取，请刷新后核对。', businessSummary: '已载入 {total} 项；待审核 {review}，失败 {failed}，逾期 {overdue}', businessNextStep: '下一步：先处理待审核、失败和逾期事项；责任人及截止时间见任务卡片。',
  retryTask: '重试原请求', openDraftTask: '打开原会话核查', taskStartFailed: '目标尚未确认受理，草稿已保留。请检查模型与连接后重试。', taskRetryHint: '原请求可能已经受理，请重试原请求或打开原会话核查。确认受理结果前，目标与频率暂时锁定。' ,
  attention: '待处理', approval: '等待审批', question: '等待回答', planReview: '等待计划审核',
  workspace: '工作空间', newTask: '新建执行会话', preparing: '正在准备…', start: '开始检查',
  goal: '需要关注什么？', goalHint: '告诉 AI 要处理哪些表格、跟进哪些客户，或检查哪些库存与订单。',
  cadence: '会话内提醒频率', once: '单次检查', hourly: '每小时', daily: '每天',
  scheduleHint: '此处请 AI 创建会话内提醒，须由 AI 确认创建成功；应用与对应会话活动时执行。持久化巡检请使用上方的巡检计划。',
  allocationHint: '系统按任务创建工作空间，无需先选择目录。',
  toolDisabled: '该工具已在侧栏设置中关闭，请启用后再打开。',
  scheduleHourlyPrompt: '请先检查一次上述目标，再使用 schedule_create 创建每 60 分钟重复的检查提醒。只在实际创建成功后报告已安排；说明应用与会话须保持活动，以及如何停止提醒。',
  scheduleDailyPrompt: '请先检查一次上述目标，再使用 schedule_create 创建每 24 小时重复的检查提醒。只在实际创建成功后报告已安排；说明应用与会话须保持活动，以及如何停止提醒。',
  tasks: '执行会话', all: '全部', running: '执行中', idle: '当前未运行', search: '搜索执行会话', refresh: '刷新', refreshing: '正在刷新…',
  noTasks: '还没有执行会话', noMatches: '没有匹配的执行会话', noTasksHint: '从上方描述一个目标开始。',
  loading: '正在读取会话…', refreshError: '刷新失败，请重试。', actionError: '操作未完成，请重试。',
  modules: 'AI 工具与结果', editor: '文档编辑器', browser: '网页浏览器', terminal: '终端', crm: 'CRM 客户', erp: 'ERP 库存与订单',
  editorHint: '文件、代码与 Markdown', browserHint: '工作空间中的网页标签', terminalHint: '持久终端与命令输出', crmHint: '复核客户信息与跟进记录', erpHint: '复核库存、采购与销售订单',
  untitled: '未命名会话', open: '打开', openInSidebar: '在右侧打开', error: '操作失败', retry: '重试', cancel: '取消', save: '保存', saving: '正在保存…',
  remove: '删除', edit: '编辑', add: '新建', export: '导出备份', loadingData: '正在读取数据…',
  name: '姓名', company: '公司', stage: '阶段', nextAction: '下一步行动', nextDate: '跟进日期',
  lead: '新线索', contacted: '沟通中', proposal: '方案确认', won: '已成交', lost: '已结束',
  crmDescription: '可让 AI 查询和整理客户、阶段与跟进计划，在这里复核或手动修改。本机记录与 AI 共用。',
  noContacts: '还没有客户记录', contactSearch: '搜索姓名、公司或跟进事项', contactNew: '新建客户', contactEdit: '编辑客户',
  due: '待跟进', allStages: '所有阶段',
  inventory: '库存', orders: '订单', audit: '变更记录', sku: 'SKU', itemName: '品名', stock: '当前库存', reorderAt: '补货线', supplier: '供应商',
  erpDescription: '可让 AI 检查库存、准备采购与销售草稿。AI 修改库存、删除记录或提交订单前会请求审批，在这里查看结果或接手操作。',
  lowStock: '需要补货', normalStock: '库存正常', noInventory: '还没有物料', itemNew: '新建物料', itemEdit: '编辑物料', inventorySearch: '搜索 SKU、品名或供应商',
  orderNew: '新建订单', orderEdit: '编辑草稿', noOrders: '还没有订单', purchase: '采购', sale: '销售', draft: '草稿', submitted: '已提交',
  counterparty: '客户 / 供应商', orderDate: '订单日期', quantity: '数量', price: '单价（元）', total: '金额', note: '备注', lines: '订单明细',
  addLine: '添加明细', removeLine: '移除明细', chooseItem: '选择物料', submitOrder: '提交并更新库存', orderDetails: '订单详情',
  submitHint: '提交后订单不可修改，采购增加库存，销售扣减库存。', stockCorrection: '直接修改库存属于库存校正，会记录前后数量。',
  noAudit: '还没有变更记录', time: '时间', action: '操作', revision: '版本', details: '详情',
  invalid_request: '请检查必填字段、日期和数字。数量须为整数，金额最多两位小数。',
  revision_conflict: '数据已更新。请刷新查看最新记录，并在表单中核对后再保存；当前输入已保留。',
  command_conflict: '该请求编号已被其他操作使用，请刷新后重试。', not_found: '记录已不存在，请刷新列表。',
  duplicate_sku: 'SKU 已存在，请使用另一个编号。', referenced_item: '该物料被订单引用，不能删除。',
  submitted_order: '已提交的订单不能再次修改或提交。', insufficient_stock: '库存不足，订单未提交。',
  numeric_overflow: '数量或金额超出支持范围。', storage_unavailable: '本机数据暂不可用，请重试。', storage_invalid: '本机数据无法读取，请保留原文件并检查。',
  networkError: '无法连接本机服务，请检查应用连接后重试。', invalidResponse: '服务返回了无法识别的数据，请更新应用后重试。',
} as const;

export type ProductCopy = { [K in keyof typeof zh]: string };
const en: ProductCopy = {
  brand: 'ClawMaster',
  watchdog: 'WatchDog', slogan: 'Enterprise collaboration for the AI era', connected: 'App service connected', disconnected: 'App service disconnected', connecting: 'Connecting to app service', connectionScope: 'This status covers the connection between this interface and the app service. Model availability, scheduled execution and business outcomes require separate verification.',
  healthHeading: 'Service health and business outcomes', healthApp: 'App service', healthModel: 'Model', healthSchedule: 'Scheduled execution', healthBusiness: 'Business outcomes', modelVerified: 'Successful model response recorded', modelEvidenceLimit: 'This proves a Session response succeeded before; it does not prove current availability.', modelUnverified: 'No successful response observed in loaded Sessions', modelNextStep: 'Run a real task; this state updates when a model response is recorded.', scheduleUnavailable: 'Could not read; refresh schedule status', scheduleUnobserved: 'No worker heartbeat observed', scheduleNoWorker: 'No worker is currently online', scheduleAttention: 'Some workers are offline or degraded', scheduleOnline: 'Workers online', scheduleWorkers: 'Workers online', scheduleNeedsAttention: 'Need attention', scheduleOccurrencesAttention: 'Scheduled instances need attention: {failed} failed, {uncertain} delivery outcomes uncertain. Inspect records; uncertain deliveries are not replayed automatically.', observedAt: 'Last observed', businessUnavailable: 'Business tasks are unavailable; refresh and review.', businessSummary: '{total} loaded; {review} awaiting review, {failed} failed, {overdue} overdue', businessNextStep: 'Next: handle reviews, failures and overdue items first; task cards show owners and deadlines.',
  retryTask: 'Retry original request', openDraftTask: 'Inspect existing session', taskStartFailed: 'Task admission is not confirmed. Your draft is retained. Check the model and connection, then retry.', taskRetryHint: 'The original request may already be accepted. Retry it or inspect the existing session. The goal and frequency stay locked until admission is confirmed.',
  attention: 'Needs attention', approval: 'Waiting for approval', question: 'Waiting for answer', planReview: 'Waiting for plan review',
  workspace: 'Workspace', newTask: 'New execution session', preparing: 'Preparing…', start: 'Start check',
  goal: 'What should WatchDog watch?', goalHint: 'Tell AI which tables to process, customers to follow up with, or stock and orders to check.',
  cadence: 'Session reminder frequency', once: 'One check', hourly: 'Every hour', daily: 'Every day',
  scheduleHint: 'This asks AI to create a session reminder. Wait for its creation confirmation; reminders run while the app and session are active. Use the check plans above for persistent schedules.', allocationHint: 'The system creates a workspace for each task. No directory selection is required.',
  toolDisabled: 'This tool is disabled in sidebar settings. Enable it before opening.',
  scheduleHourlyPrompt: 'Check the goal above once, then use schedule_create to create a repeating check every 60 minutes. Report scheduling only after creation succeeds. Explain that the app and session must stay active, and how to stop reminders.',
  scheduleDailyPrompt: 'Check the goal above once, then use schedule_create to create a repeating check every 24 hours. Report scheduling only after creation succeeds. Explain that the app and session must stay active, and how to stop reminders.',
  tasks: 'Execution sessions', all: 'All', running: 'Running', idle: 'Not running', search: 'Search execution sessions', refresh: 'Refresh', refreshing: 'Refreshing…', noTasks: 'No execution sessions yet', noMatches: 'No matching execution sessions', noTasksHint: 'Start by describing a goal above.', loading: 'Loading sessions…', refreshError: 'Refresh failed. Please retry.', actionError: 'The action could not be completed. Please retry.',
  modules: 'AI tools and results', editor: 'Document editor', browser: 'Web browser', terminal: 'Terminal', crm: 'CRM contacts', erp: 'ERP inventory and orders', editorHint: 'Files, code and Markdown', browserHint: 'Web tabs in your workspace', terminalHint: 'Persistent terminals and output', crmHint: 'Review contacts and follow-ups', erpHint: 'Review stock, purchases and sales',
  untitled: 'Untitled session', open: 'Open', openInSidebar: 'Open in sidebar', error: 'Action failed', retry: 'Retry', cancel: 'Cancel', save: 'Save', saving: 'Saving…', remove: 'Delete', edit: 'Edit', add: 'New', export: 'Export backup', loadingData: 'Loading data…',
  name: 'Name', company: 'Company', stage: 'Stage', nextAction: 'Next action', nextDate: 'Follow-up date', lead: 'Lead', contacted: 'Contacted', proposal: 'Proposal', won: 'Won', lost: 'Closed', crmDescription: 'Ask AI to query and organize contacts, stages and follow-ups. Review or edit the same local records here.', noContacts: 'No contacts yet', contactSearch: 'Search names, companies or follow-ups', contactNew: 'New contact', contactEdit: 'Edit contact', due: 'Follow-up due', allStages: 'All stages',
  inventory: 'Inventory', orders: 'Orders', audit: 'Change history', sku: 'SKU', itemName: 'Item name', stock: 'Stock', reorderAt: 'Reorder level', supplier: 'Supplier', erpDescription: 'Ask AI to check stock and prepare orders. AI requests approval before stock changes, deletions or order submission. Review results or take over here.', lowStock: 'Reorder needed', normalStock: 'Stock available', noInventory: 'No inventory items yet', itemNew: 'New item', itemEdit: 'Edit item', inventorySearch: 'Search SKU, item or supplier',
  orderNew: 'New order', orderEdit: 'Edit draft', noOrders: 'No orders yet', purchase: 'Purchase', sale: 'Sale', draft: 'Draft', submitted: 'Submitted', counterparty: 'Customer / supplier', orderDate: 'Order date', quantity: 'Quantity', price: 'Unit price (CNY)', total: 'Amount', note: 'Note', lines: 'Order lines', addLine: 'Add line', removeLine: 'Remove line', chooseItem: 'Select item', submitOrder: 'Submit and update stock', orderDetails: 'Order details', submitHint: 'Submitted orders are immutable. Purchases add stock; sales deduct stock.', stockCorrection: 'Editing stock directly records an inventory correction with before and after quantities.', noAudit: 'No changes yet', time: 'Time', action: 'Action', revision: 'Revision', details: 'Details',
  invalid_request: 'Check required fields, dates and numbers. Quantities must be integers; prices allow two decimal places.', revision_conflict: 'Records changed. Refresh to see the latest record, then review it in the form before saving; your inputs are retained.', command_conflict: 'This request ID was used by another action. Refresh and retry.', not_found: 'The record no longer exists. Refresh the list.', duplicate_sku: 'This SKU already exists. Choose another.', referenced_item: 'An order references this item, so it cannot be deleted.', submitted_order: 'Submitted orders cannot be edited or submitted again.', insufficient_stock: 'Insufficient stock. The order was not submitted.', numeric_overflow: 'A quantity or amount exceeds the supported range.', storage_unavailable: 'Local data is temporarily unavailable. Please retry.', storage_invalid: 'Local data cannot be read. Preserve the original file and inspect it.', networkError: 'Cannot connect to the local service. Check the app connection and retry.', invalidResponse: 'The service returned unrecognized data. Update the app and retry.',
};

/** Resolve the product dictionary from the DSH locale selection. */
export function productCopy(locale: ProductLocale): ProductCopy { return locale === 'zh-CN' ? zh : en; }

/** Format bounded home counts without implying work beyond the loaded task page. */
export function businessHealthSummary(locale: ProductLocale, counts: { total: number; review: number; failed: number; overdue: number }): string {
  const template = productCopy(locale).businessSummary;
  return template.replace('{total}', String(counts.total)).replace('{review}', String(counts.review))
    .replace('{failed}', String(counts.failed)).replace('{overdue}', String(counts.overdue));
}

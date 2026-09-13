/** English and Chinese tutorial for managing a customer and delivery risk review. */
import type { ProductLocale } from './frontend.ts';

const zh = {
  title: '用 WatchDog 管好企业日常', subtitle: '以“本周客户跟进与交付风险巡检”为例，从明确管理目标到复核整改。',
  settingsTitle: 'WatchDog 教程', replay: '从头再看', next: '下一步', back: '上一步', skip: '跳过教程',
  progress: '企业管理步骤', finish: '进入 WatchDog 管理台', models: '模型设置（按需）', im: '聊天连接（可选）',
  saveError: '教程进度未能保存，请重试。现有模型与会话未更改。', saving: '正在保存…',
  reviewHint: '随时重看范围、分工、资料、巡检与整改这五步。辅助配置在左侧“模型”和“IM”设置中。',
  scopeTitle: '确定本周要管的范围',
  scopeBody: '先选一个具体问题：哪些客户本周需要跟进，哪些订单可能因库存不足影响交付。在 WatchDog 任务说明中写明时间、客户或订单范围，以及要收到的风险清单。',
  scopeTip: '示例目标：巡检本周客户跟进与交付风险，列出待跟进客户、缺货订单和需要补充的资料，供我复核。',
  briefTitle: '写清负责人、期限和验收标准',
  briefBody: '把分工约定写进同一段任务说明：由谁跟进、何时反馈、怎样算处理完成。负责人和期限是说明文字；需要安排同事时，由你确认并落实分工。',
  briefTip: '接着补充：由销售负责人复核客户跟进，采购负责人核对缺货，周五 17:00 前反馈；每项结论附客户或订单依据、建议措施和待确认问题。',
  recordsTitle: '让业务资料支撑管理结论',
  recordsBody: '让任务核查 CRM 的客户阶段与跟进日期、ERP 的库存和采购销售订单，并指定要使用的办公文件。交付承诺以提供的资料为准；资料缺失或无法读取时，先列出需要补充的内容。',
  recordsTip: 'AI 使用业务工具整理结果，你复核结论。要查原始记录，在“设置 → 侧边卡片”找到 CRM、ERP，从功能设置选择“在右侧打开”。',
  cadenceTitle: '选择巡检节奏，确认业务变更',
  cadenceBody: '先用“单次检查”核对结果。需要重复巡检时，在 WatchDog 填写目标，选择“每小时”或“每天”，再点“开始检查”创建新的巡检任务。是否安排成功以任务结果为准；需保持应用与会话活动。',
  cadenceTip: '任务若请求修改库存、删除记录或提交订单，先在对话中核对操作范围和影响，再决定是否批准；不符合要求就拒绝并补充说明。',
  followupTitle: '跟踪任务，复核结果并落实整改',
  followupBody: '在 WatchDog 任务列表查看“执行中”的任务，搜索或打开这次巡检。逐项核对资料来源、异常和处理建议，在任务中补充整改要求，再核对后续结果。',
  followupTip: '例如：请补齐缺货订单的库存依据，列出建议补货量与待确认事项，交采购负责人复核。“当前未运行”只表示此刻未执行，是否完成以任务结果为准。',
  ready: '进入管理台后再填写并启动巡检。若尚未配置模型或需要聊天连接，可使用这些辅助入口；已有配置可直接复用。',
};
type OnboardingCopy = { [K in keyof typeof zh]: string };
const en: OnboardingCopy = {
  title: 'Manage everyday business with WatchDog', subtitle: 'Review this week’s customer follow-ups and delivery risks, from setting goals to checking corrective action.',
  settingsTitle: 'WatchDog tutorial', replay: 'Read from the start', next: 'Next', back: 'Back', skip: 'Skip tutorial',
  progress: 'Business management steps', finish: 'Open WatchDog management', models: 'Model settings (if needed)', im: 'Chat connections (optional)',
  saveError: 'Could not save tutorial progress. Please retry. Existing models and sessions are unchanged.', saving: 'Saving…',
  reviewHint: 'Revisit scope, responsibilities, records, checks and corrective action here. Auxiliary setup is in Models and IM on the left.',
  scopeTitle: 'Define what to review this week',
  scopeBody: 'Choose a concrete question: which customers need follow-up this week, and which orders could face delivery risks from low stock? In the WatchDog task description, specify the period, customers or orders, and the risk list you need.',
  scopeTip: 'Example goal: review this week’s customer follow-ups and delivery risks; list customers awaiting follow-up, orders with stock shortages, and missing information for my review.',
  briefTitle: 'State owners, deadlines and acceptance criteria',
  briefBody: 'Write responsibilities in the same task description: who follows up, when they report back, and what counts as resolved. Owners and deadlines are written instructions; confirm and arrange colleagues’ responsibilities yourself.',
  briefTip: 'Add: the sales lead reviews customer follow-ups and the purchasing lead checks shortages by Friday at 17:00. Each finding includes customer or order evidence, suggested action and unresolved questions.',
  recordsTitle: 'Base management conclusions on business records',
  recordsBody: 'Ask the task to check CRM stages and follow-up dates, ERP stock and purchase or sale orders, and the office files you specify. Use supplied documents for delivery commitments. List information to provide if records are missing or unreadable.',
  recordsTip: 'AI uses business tools to organize results; you review the conclusions. To inspect original records, find CRM or ERP in Settings → Side Cards and choose Open in sidebar in its feature settings.',
  cadenceTitle: 'Choose a review frequency and approve changes',
  cadenceBody: 'Start with One check and review its results. For recurring reviews, enter the goal in WatchDog, choose Every hour or Every day, then select Start check to create a new task. Confirm scheduling from its result; keep the app and session active.',
  cadenceTip: 'If the task requests a stock change, record deletion or order submission, inspect its scope and effects in the conversation before approving. Reject it and clarify your requirements when needed.',
  followupTitle: 'Track tasks, verify findings and follow through',
  followupBody: 'Use the WatchDog task list to see Running tasks, search for this review and open it. Check sources, exceptions and proposed actions. Add corrective requirements in the task, then verify the follow-up results.',
  followupTip: 'For example: provide stock evidence for affected orders, suggest replenishment quantities and list questions for the purchasing lead to review. Not running only describes current activity; check task results to determine completion.',
  ready: 'Open management, then write and start your review. Use these auxiliary settings if you need a model or chat connection; existing configuration can be reused.',
};

/**
 * Resolve tutorial copy using the product's DSH locale.
 * @param locale - Active product locale.
 * @returns A complete localized tutorial dictionary.
 */
export function onboardingCopy(locale: ProductLocale): OnboardingCopy { return locale === 'zh-CN' ? zh : en; }

/** Schedule copy distinguishes approval, prompt delivery and business acceptance. */
import type { ProductLocale } from './frontend.ts';
const zh = {
  heading: '定时巡检', create: '建立巡检计划', close: '收起计划表单', refresh: '刷新调度状态', loading: '正在读取调度状态…',
  desktop: '桌面调度：应用运行且关联会话已打开时才能投递，关机或休眠期间不会执行。',
  server: '服务器调度：由已配置的常驻服务投递，仍需关联会话在线；此处不会安装服务器服务。',
  unavailableMode: '尚未读取到调度状态。', noWorkers: '没有可确认在线的调度进程。',
  activePlanWorkerUnavailable: '仍有有效计划，但当前没有在线调度进程。巡检不会按时投递。此告警来自本应用最近一次状态读取；主机离线时不会发送外部通知。',
  online: '调度在线', offline: '心跳已过期', degraded: '调度异常', stopped: '调度已停止', heartbeat: '最近心跳', observedAt: '以下状态读取于',
  workerCount: '调度进程总数', workerDetails: '查看调度进程', refreshWorkers: '刷新调度进程首页', nextWorkers: '下一页调度进程',
  hint: '每次到期都需要单独批准。已投递只表示请求进入执行会话，不代表模型成功或业务已验收。',
  prompt: '巡检目标与范围', session: '执行会话', choose: '选择已有会话', rule: '执行时间', every: '固定间隔', at: '指定时间',
  minutes: '间隔（分钟，至少 5）', date: '日期', time: '时间', timezone: '时区', missed: '错过时间后的处理',
  skip: '跳过错过的巡检', coalesce: '只补最近一次', 'catch-up': '补最近若干次', catchUpLimit: '最多补几次', save: '保存巡检计划',
  empty: '还没有巡检计划。', active: '计划有效', inactive: '已停止生成后续巡检', nextAt: '下次到期', missedCount: '已跳过次数',
  noNext: '没有后续到期时间', nextPlan: '下一页计划', openSession: '打开执行会话', cancelPlan: '停止后续巡检',
  cancelHint: '停止计划不会取消已经生成或已经投递的巡检。', reason: '操作理由', occurrences: '本计划的巡检记录', refreshInstances: '刷新本计划记录',
  noInstances: '尚未生成巡检记录。', nextInstance: '下一页巡检记录', dueAt: '本次到期', expiresAt: '批准与投递期限', attempts: '尝试次数',
  waiting_approval: '等待本次批准', ready: '已批准，等待投递', leased: '正在准备投递', dispatching: '正在确认投递',
  dispatched: '请求已投递', uncertain: '投递结果待核实', failed: '本次巡检失败', cancelled: '本次巡检已取消',
  approve: '批准本次投递', cancelInstance: '取消本次巡检', inspected: '已在原会话核对本次巡检编号与投递记录',
  acknowledge: '确认已投递', resolveCancel: '结束本次记录', uncertainHint: '不要重新投递。先打开原会话核对；结束记录不会撤销已经产生的外部操作。',
  history: '调度操作历史', loadHistory: '读取调度历史', nextHistory: '下一页调度历史',
  technicalDetails: '技术详情', unknownAction: '其他调度操作',
  saved: '操作已保存。可刷新查看后续状态。', saving: '正在保存调度操作…', pending: '操作结果尚未确认，其他修改已暂停。请重试原请求。', retry: '重试原调度请求',
  network: '调度连接中断，输入已保留。', invalid: '计划字段或服务响应无效，请核对后再试。', denied: '当前身份无权执行此操作。',
  conflict: '计划或巡检状态已变化，请刷新后核对。', unavailable: '调度服务暂不可用，请稍后刷新。',
} as const;
type Copy = { [K in keyof typeof zh]: string };
const en: Copy = {
  heading: 'Scheduled checks', create: 'Create check plan', close: 'Close plan form', refresh: 'Refresh scheduler status', loading: 'Reading scheduler status…',
  desktop: 'Desktop scheduling requires the app running and the bound session open. Nothing runs while the computer is off or asleep.',
  server: 'Server scheduling uses the configured running service and a live bound session. This page does not install a server service.',
  unavailableMode: 'Scheduler status has not been read.', noWorkers: 'No scheduler worker is confirmed online.',
  activePlanWorkerUnavailable: 'An active plan has no online scheduler worker. Checks will not be delivered on time. This alert reflects the latest in-app status read; it does not notify you while the host is offline.',
  online: 'Scheduler online', offline: 'Heartbeat expired', degraded: 'Scheduler degraded', stopped: 'Scheduler stopped', heartbeat: 'Last heartbeat', observedAt: 'Status observed at',
  workerCount: 'Scheduler workers', workerDetails: 'Inspect scheduler workers', refreshWorkers: 'Refresh first worker page', nextWorkers: 'Next worker page',
  hint: 'Each occurrence requires its own approval. Delivered means the request reached its execution session, not model success or business acceptance.',
  prompt: 'Check goal and scope', session: 'Execution session', choose: 'Choose an existing session', rule: 'Timing', every: 'Fixed interval', at: 'Specific time',
  minutes: 'Interval (minutes, at least 5)', date: 'Date', time: 'Time', timezone: 'Time zone', missed: 'Missed-time handling',
  skip: 'Skip missed checks', coalesce: 'Admit the latest missed check', 'catch-up': 'Admit recent missed checks', catchUpLimit: 'Maximum catch-up count', save: 'Save check plan',
  empty: 'No check plans yet.', active: 'Plan active', inactive: 'No further occurrences', nextAt: 'Next due', missedCount: 'Skipped occurrences',
  noNext: 'No next due time', nextPlan: 'Next plan page', openSession: 'Open execution session', cancelPlan: 'Stop future checks',
  cancelHint: 'Stopping the plan does not cancel occurrences already created or delivered.', reason: 'Action reason', occurrences: 'Occurrences for this plan', refreshInstances: 'Refresh plan occurrences',
  noInstances: 'No occurrences yet.', nextInstance: 'Next occurrence page', dueAt: 'Occurrence due', expiresAt: 'Approval and delivery deadline', attempts: 'Attempts',
  waiting_approval: 'Waiting for this approval', ready: 'Approved, waiting for delivery', leased: 'Preparing delivery', dispatching: 'Confirming delivery',
  dispatched: 'Request delivered', uncertain: 'Delivery needs verification', failed: 'Occurrence failed', cancelled: 'Occurrence cancelled',
  approve: 'Approve this delivery', cancelInstance: 'Cancel this occurrence', inspected: 'I checked this occurrence ID and delivery record in the original session',
  acknowledge: 'Confirm delivered', resolveCancel: 'End this record', uncertainHint: 'Do not resend. Inspect the original session first. Ending this record does not undo external effects.',
  history: 'Schedule action history', loadHistory: 'Read schedule history', nextHistory: 'Next schedule history page',
  technicalDetails: 'Technical details', unknownAction: 'Other schedule action',
  saved: 'The action was saved. Refresh to see later status.', saving: 'Saving schedule action…', pending: 'The action is not confirmed. Other changes are paused. Retry the original request.', retry: 'Retry original schedule request',
  network: 'Scheduler connection interrupted. Inputs are retained.', invalid: 'Plan fields or service response are invalid. Check before retrying.', denied: 'The current identity cannot perform this action.',
  conflict: 'The plan or occurrence changed. Refresh and inspect its state.', unavailable: 'The scheduler service is unavailable. Refresh later.',
};
/** Return all visible schedule management text for the product locale. */
export function scheduleCopy(locale: ProductLocale): Copy { return locale === 'zh-CN' ? zh : en; }

const actions: Record<ProductLocale, Readonly<Record<string, string>>> = {
  'zh-CN': {
    create: '已创建计划', 'cancel-plan': '已停止后续巡检', approve: '已批准本次投递', 'cancel-instance': '已取消本次巡检',
    'resolve-uncertain': '已人工核实投递结果', materialized: '已生成到期巡检', deferred: '会话忙碌，已延后尝试',
    'approval-requested': '正在核验独立审批', 'dispatch-authorized': '独立审批已核验', 'approval-recovery-required': '恢复后需要重新批准',
  },
  'en-US': {
    create: 'Plan created', 'cancel-plan': 'Future checks stopped', approve: 'Occurrence delivery approved', 'cancel-instance': 'Occurrence cancelled',
    'resolve-uncertain': 'Delivery outcome reviewed by a human', materialized: 'Due occurrence created', deferred: 'Session busy; attempt deferred',
    'approval-requested': 'Checking independent approval', 'dispatch-authorized': 'Independent approval checked', 'approval-recovery-required': 'Recovery requires fresh approval',
  },
};

/** Localize recorded actions, keeping unknown action codes available in the separate details.
 * @param locale - Selected product locale.
 * @param action - Persisted schedule action or outcome.
 * @returns Human-readable action label; unknown future actions use a generic label.
 */
export function scheduleHistoryAction(locale: ProductLocale, action: string): string {
  const copy = scheduleCopy(locale);
  switch (action) {
    case 'waiting_approval': case 'ready': case 'leased': case 'dispatching': case 'dispatched': case 'uncertain': case 'failed': case 'cancelled': return copy[action];
    default: return actions[locale][action] ?? copy.unknownAction;
  }
}

/** Management copy describes business outcomes independently of Session activity. */
import type { ProductLocale } from './frontend.ts';
const zh = {
  heading: '业务任务与验收', hint: '负责人、期限和验收结论保存在任务里；会话空闲不代表工作已经完成。',
  create: '建立业务任务', refresh: '刷新业务任务', more: '下一页任务', loading: '正在读取业务任务…', empty: '还没有业务任务。先明确目标、负责人和验收标准。',
  goal: '业务目标', scope: '范围与资料', owner: '负责人', ownerKind: '负责人类型', local: '本地负责人（未认证成员）', member: '企业成员 ID',
  deadline: '期限', timezone: '时区', risk: '风险等级', low: '低', medium: '中', high: '高', criteria: '验收标准（每行一项）',
  saveDraft: '保存业务草稿', saving: '正在保存业务任务…', closeForm: '收起表单', savedHint: '保存后可重新打开；历史会话只能显式关联，不会自动变成已完成任务。',
  edit: '调整任务定义', saveChanges: '保存任务变更', importSession: '从旧会话建立草稿（可选）', noImport: '不导入旧会话', recordWaiting: '记录等待条件', clearWaiting: '清除等待条件',
  status: '业务状态', draft: '草稿', ready: '待执行', in_progress: '处理中', awaiting_review: '待验收', accepted: '验收通过', failed: '失败待处理', cancelled: '已取消',
  overdue: '已逾期', waiting: '等待外部条件', failureReason: '失败原因', cancelReason: '取消原因', noDeadline: '未设期限', revision: '修订', details: '任务详情', queue: '安排执行',
  session: '关联执行会话', selectSession: '选择已有会话', start: '记录开始执行', link: '关联会话', openSession: '打开执行会话',
  sessionHint: '选择承担本任务的实际会话。此操作只记录关联，不重复发送模型请求。可在下方启动检查或打开已有会话。',
  submit: '提交结果待验收', evidenceLocation: '证据位置', evidenceSummary: '证据说明', evidenceObserved: '证据观测时间',
  checkedCriteria: '已完成的验收项', evidence: '结果证据', evidenceUnchecked: '证据尚未核对；验收前请打开来源确认内容和可用性。',
  openEvidence: '打开证据来源', review: '人工验收', reviewComment: '验收意见或操作理由', accept: '验收通过', reject: '驳回补做',
  cancel: '取消任务', reopen: '重新打开', fail: '记录失败', history: '历史证据与验收', loadHistory: '读取历史记录', moreHistory: '下一页历史',
  noHistory: '展开历史可查看先前提交与验收意见。', imported: '从旧会话显式关联', newSource: '新建业务任务',
  pending: '上次保存结果尚未确认。请重试原请求；确认前其他写入已暂停。', retry: '重试原保存请求',
  network: '连接中断，已保留输入。保存结果可能尚未确认。', invalid: '任务内容或服务响应无效，请核对必填项。',
  listChanged: '任务列表已变化，请刷新业务任务后重新翻页。当前详情与输入仍保留。', denied: '权限或独立审批不足；请联系有权限的成员处理。', conflict: '任务已被修改。请重新打开详情、核对最新修订后再操作。',
  unavailable: '任务服务暂不可用，请稍后重试。', tooLarge: '任务内容超过当前容量限制，请缩短描述或分成多个任务。',
  running: '会话正在运行', idle: '会话当前空闲', loaded: '已加载任务', dateInvalid: '请填写有效的时间。',
} as const;
type Copy = { [K in keyof typeof zh]: string };
const en: Copy = {
  heading: 'Business tasks and acceptance', hint: 'Owners, deadlines and acceptance belong to the task. An idle session does not mean the work is complete.',
  create: 'Create business task', refresh: 'Refresh business tasks', more: 'Next task page', loading: 'Loading business tasks…', empty: 'No business tasks yet. Define a goal, owner and acceptance criteria.',
  goal: 'Business goal', scope: 'Scope and source material', owner: 'Owner', ownerKind: 'Owner type', local: 'Local owner (not an authenticated member)', member: 'Organization member ID',
  deadline: 'Deadline', timezone: 'Time zone', risk: 'Risk', low: 'Low', medium: 'Medium', high: 'High', criteria: 'Acceptance criteria (one per line)',
  saveDraft: 'Save business draft', saving: 'Saving business task…', closeForm: 'Close form', savedHint: 'Saved drafts survive reopening. Existing sessions are linked explicitly and never inferred as completed work.',
  edit: 'Edit task definition', saveChanges: 'Save task changes', importSession: 'Create draft from existing session (optional)', noImport: 'Do not import a session', recordWaiting: 'Record waiting condition', clearWaiting: 'Clear waiting condition',
  status: 'Business status', draft: 'Draft', ready: 'Ready', in_progress: 'In progress', awaiting_review: 'Awaiting review', accepted: 'Accepted', failed: 'Failure needs attention', cancelled: 'Cancelled',
  overdue: 'Overdue', waiting: 'Waiting on an external condition', failureReason: 'Failure reason', cancelReason: 'Cancellation reason', noDeadline: 'No deadline', revision: 'Revision', details: 'Task details', queue: 'Queue for execution',
  session: 'Execution session', selectSession: 'Choose an existing session', start: 'Record execution start', link: 'Link session', openSession: 'Open execution session',
  sessionHint: 'Choose the session actually performing this task. Linking records the association without resending a model request. Start a check below or open an existing session.',
  submit: 'Submit results for review', evidenceLocation: 'Evidence location', evidenceSummary: 'Evidence summary', evidenceObserved: 'Evidence observed at',
  checkedCriteria: 'Completed acceptance criteria', evidence: 'Result evidence', evidenceUnchecked: 'Evidence has not been verified. Open its source to check content and availability before acceptance.',
  openEvidence: 'Open evidence source', review: 'Human review', reviewComment: 'Review comment or action reason', accept: 'Accept result', reject: 'Request rework',
  cancel: 'Cancel task', reopen: 'Reopen task', fail: 'Record failure', history: 'Evidence and review history', loadHistory: 'Read task history', moreHistory: 'Next history page',
  noHistory: 'Read history to see earlier submissions and review comments.', imported: 'Explicitly linked from an existing session', newSource: 'New business task',
  pending: 'The previous save is not confirmed. Retry the original request; other writes are paused until its outcome is known.', retry: 'Retry original save',
  network: 'Connection interrupted. Inputs are retained; the save may remain unconfirmed.', invalid: 'Task content or server response is invalid. Check the required fields.',
  listChanged: 'The task list changed. Refresh business tasks before paging again. Current details and inputs are retained.', denied: 'Permission or independent approval is missing. Ask an authorized member to handle this action.', conflict: 'The task has changed. Reopen details and review the current revision before continuing.',
  unavailable: 'The task service is unavailable. Try again later.', tooLarge: 'Task content exceeds the configured capacity. Shorten it or split it into smaller tasks.',
  running: 'Session running', idle: 'Session idle', loaded: 'Loaded tasks', dateInvalid: 'Enter a valid time.',
};
/** Return all visible business-task text for the selected product locale. */
export function taskCopy(locale: ProductLocale): Copy { return locale === 'zh-CN' ? zh : en; }

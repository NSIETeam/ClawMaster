/** Plan stage: what the reviewer asks of a plan, and when it makes that binding. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.ts';
import { DEFAULT_OPTIONS, parseOptions, planDecision, planTextOf } from '../src/policy.ts';
import { inspectPlan, planReviewReason } from '../src/plan.ts';

/** A plan that states its own acceptance criteria and the evidence for them. */
const reviewedPlan = `# 对齐笔记面板的间距

## 目标

把面板的行高、缩进与图标间距对齐宿主自带的文件管理器，让侧栏面板看起来是宿主的一部分，而不是外挂上去的列表。

## 步骤

1. 读 dsh-better-sidebar 的 explorerRow 与 explorerDir 规则，取出实测数值
2. 用 --cm-* 变量重写 styles.css，行高 34px、缩进 depth * 22 + 6、图标间距 6px
3. 用内联 SVG 图标替换位图，保持 16px 网格

## 验收

- 行高实测 34px、缩进 depth * 22 + 6、工具栏控件 28px
- \`pnpm run test:notes-client\` 全绿，证据为命令输出与截图
`;

/** The same plan with the acceptance section removed. */
const unreviewablePlan = `# 对齐笔记面板的间距

## 步骤

1. 读宿主规则
2. 重写 styles.css
`;

describe('plan inspection', () => {
  it('accepts a plan that says how its result will be checked', () => {
    const review = inspectPlan(reviewedPlan);
    assert.deepEqual(review.findings, []);
    assert.equal(review.verdict, 'ok');
  });

  it('treats a missing acceptance criterion as binding', () => {
    const review = inspectPlan(unreviewablePlan);
    assert.equal(review.verdict, 'block');
    const binding = review.findings.filter(finding => finding.binding).map(finding => finding.code);
    assert.deepEqual(binding, ['plan.no-acceptance']);
    assert.match(planReviewReason(review), /plan\.no-acceptance — The plan never says how its result will be checked/);
  });

  it('keeps the softer findings advisory', () => {
    // Acceptance and evidence are present, so nothing is binding; the plan is still short and
    // unstructured, which is exactly what the advisory findings are for.
    const short = inspectPlan('# 计划\n\n清理临时文件并重启。\n\n## 验收\n\n命令输出为准。');
    assert.equal(short.verdict, 'advise');
    const codes = short.findings.map(finding => finding.code);
    assert.ok(codes.includes('plan.thin'), JSON.stringify(codes));
    assert.ok(codes.includes('plan.no-steps'), JSON.stringify(codes));
    assert.equal(short.findings.some(finding => finding.binding), false);
  });

  it('flags destructive work that names no evidence', () => {
    const risky = inspectPlan('# 计划\n\n## 步骤\n\n1. 清理旧产物并重新部署服务。\n\n## 验收\n\n一切正常。');
    assert.equal(risky.verdict, 'advise');
    const codes = risky.findings.map(finding => finding.code);
    assert.ok(codes.includes('plan.unscoped-risk'), JSON.stringify(codes));
    assert.ok(codes.includes('plan.no-evidence'), JSON.stringify(codes));
  });

  it('says nothing about a plan it cannot fault', () => {
    assert.equal(planReviewReason(inspectPlan(reviewedPlan)), '');
  });
});

describe('plan stage wiring', () => {
  const call = (plan, name = 'exit_plan_mode') => ({ name, arguments: { plan } });

  it('reviews only the configured plan tool, and only when the stage is on', () => {
    assert.equal(planTextOf(call(reviewedPlan), DEFAULT_OPTIONS), reviewedPlan);
    assert.equal(planTextOf(call(reviewedPlan, 'bash'), DEFAULT_OPTIONS), undefined);
    assert.equal(planTextOf(call(reviewedPlan), { ...DEFAULT_OPTIONS, planReview: 'off' }), undefined);
    assert.equal(planTextOf({ name: 'exit_plan_mode', arguments: { plan: '  ' } }, DEFAULT_OPTIONS), undefined);
    assert.equal(planTextOf(call(reviewedPlan), { ...DEFAULT_OPTIONS, planTool: 'submit_plan' }), undefined);
  });

  it('records findings without deciding while advisory', () => {
    const logs = [];
    const decision = planDecision(call(unreviewablePlan), DEFAULT_OPTIONS, { info: message => logs.push(message) });
    assert.equal(decision, undefined);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /plan review \(block\)/);
  });

  it('asks the user before accepting an unreviewable plan while enforcing', () => {
    const logs = [];
    const options = { ...DEFAULT_OPTIONS, planReview: 'enforce' };
    const decision = planDecision(call(unreviewablePlan), options, { info: message => logs.push(message) });
    assert.equal(decision.kind, 'ask');
    assert.match(decision.reason, /plan\.no-acceptance/);
    assert.match(decision.reason, /Destructive|acceptance criteria/);
    assert.deepEqual(logs, []);
  });

  it('lets a reviewed plan through even while enforcing', () => {
    const options = { ...DEFAULT_OPTIONS, planReview: 'enforce' };
    assert.equal(planDecision(call(reviewedPlan), options, { info() {} }), undefined);
  });

  it('mounts the plan review onto the same pre-execute listener', async () => {
    const listeners = new Map();
    const logs = [];
    apply({
      on: (event, listener) => { listeners.set(event, listener); },
      get: () => undefined,
      logger: { info: message => logs.push(message), warn: message => logs.push(message) },
    }, { planReview: 'enforce' });
    const listener = listeners.get('tools/pre-execute');
    let delegated = 0;
    const next = async () => { delegated += 1; return { kind: 'allow' }; };

    const asked = await listener({ name: 'exit_plan_mode', arguments: { plan: unreviewablePlan } }, next);
    assert.equal(asked.kind, 'ask');
    assert.equal(delegated, 0, 'a plan that cannot be reviewed must not slip through');

    const allowed = await listener({ name: 'exit_plan_mode', arguments: { plan: reviewedPlan } }, next);
    assert.equal(allowed.kind, 'allow');
    assert.equal(delegated, 1);
  });

  it('reads the plan stage out of configuration', () => {
    assert.equal(parseOptions({}).planReview, 'advisory');
    assert.equal(parseOptions({ planReview: 'off' }).planReview, 'off');
    assert.equal(parseOptions({ planReview: 'enforce' }).planReview, 'enforce');
    assert.equal(parseOptions({ planReview: 'nonsense' }).planReview, 'advisory');
    assert.equal(parseOptions({ planTool: 'submit_plan' }).planTool, 'submit_plan');
  });
});

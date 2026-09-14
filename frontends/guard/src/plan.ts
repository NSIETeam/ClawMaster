/**
 * Plan stage: review a plan before it is accepted.
 *
 * The plan tool hands the user a markdown plan and asks them to approve it; this module reads the
 * same text and states what a reviewer would ask for. It is deliberately narrow: one finding is
 * treated as binding — a plan that never says how its result will be checked cannot be reviewed at
 * all — and everything else is advice, because taste in plan writing is not the guard's business.
 * @module @clawmaster/dsh-guard/plan
 */

/** One thing the plan review noticed. */
export interface PlanFinding {
  /** Stable code (`plan.no-acceptance`, …). */
  code: string;
  /** One sentence naming what is missing and what would fix it. */
  message: string;
  /** True when the finding alone justifies asking the user before the plan is accepted. */
  binding: boolean;
}

/** The review's verdict for one plan. */
export interface PlanReview {
  /** `ok` when nothing fired, `advise` for advisory findings, `block` for a binding one. */
  verdict: 'ok' | 'advise' | 'block';
  /** Every finding, in rule order. */
  findings: PlanFinding[];
}

/** A plan that never states how its result is verified. */
const ACCEPTANCE = /(验收|验证标准|验证方式|完成标准|验收标准|如何验证|acceptance|acceptance criteria|verify|verification|definition of done|done when|test plan|测试计划)/i;

/** A plan that never says what evidence would prove it. */
const EVIDENCE = /(证据|日志|输出|哈希|sha256|diff|截图|复现|命令输出|evidence|log output|reproduce)/i;

/** Work a plan should scope before it starts. */
const DESTRUCTIVE = /(删除|清理|清空|覆盖|迁移|回滚|重装|重启|格式化|rm -rf|git clean|reset --hard|drop\s+(table|database)|delete|purge|migrate|rewrite history|deploy|publish|release)/i;

/** Any list item or numbered step. */
const STEPS = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/m;

/**
 * Body length below which a plan is too thin to review. The title line does not count: a heading
 * says what the plan is about, never what it will do.
 */
const THIN = 160;

/**
 * Review one plan.
 * @param plan - The markdown plan as the model wrote it.
 * @returns The verdict and every finding behind it.
 */
export function inspectPlan(plan: string): PlanReview {
  const text = plan.trim();
  const body = text.replace(/^#\s+.*$/m, '').trim();
  const findings: PlanFinding[] = [];
  if (!ACCEPTANCE.test(text)) {
    findings.push({
      code: 'plan.no-acceptance',
      message: 'The plan never says how its result will be checked; add the acceptance criteria a reviewer can verify.',
      binding: true,
    });
  }
  if (!STEPS.test(text)) {
    findings.push({
      code: 'plan.no-steps',
      message: 'The plan lists no ordered steps, so its scope cannot be read from it.',
      binding: false,
    });
  }
  if (body.length < THIN) {
    findings.push({
      code: 'plan.thin',
      message: `The plan body is ${body.length} characters; that is too little to review before work starts.`,
      binding: false,
    });
  }
  if (DESTRUCTIVE.test(text) && !EVIDENCE.test(text)) {
    findings.push({
      code: 'plan.unscoped-risk',
      message: 'The plan touches something destructive or irreversible without naming the evidence that will show the result.',
      binding: false,
    });
  }
  if (!EVIDENCE.test(text)) {
    findings.push({
      code: 'plan.no-evidence',
      message: 'The plan does not say what evidence will prove the result (a command, a hash, a diff, a test run).',
      binding: false,
    });
  }
  const verdict = findings.some(finding => finding.binding) ? 'block' : findings.length > 0 ? 'advise' : 'ok';
  return { verdict, findings };
}

/**
 * The reviewer's sentence for a plan, as the reason on an approval request.
 * @param review - The plan review.
 * @returns One line listing every finding, or an empty string when nothing fired.
 */
export function planReviewReason(review: PlanReview): string {
  if (review.findings.length === 0) return '';
  return `ClawMaster Guard plan review (${review.verdict}): ${review.findings.map(finding => `${finding.code} — ${finding.message}`).join(' ')}`;
}

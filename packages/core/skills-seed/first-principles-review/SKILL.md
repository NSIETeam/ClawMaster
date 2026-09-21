---
name: first-principles-review
description: "Break the user's plan, product, cost structure, or assumption down to fundamental truths (physics, math, real costs, human needs) and reason up from there instead of by analogy or industry convention. Audits every assumption, attacks inherited requirements, and rebuilds a minimal version from basics with order-of-magnitude math.（马斯克第一性原理审视：把想法拆到基本事实再向上重建，揪出沿袭的假设和惯例） 触发：第一性原理、从本质分析、拆解假设、为什么非得这样、重新推导、成本结构重算、first principles、reasoning from fundamentals。"
whenToUse: "拆到基本事实重新推导；触发词: first principles, fundamentals, assumption audit, 第一性原理, 本质, 假设拆解"
metadata:
  source: clawmaster-thinking-suite (ClawMaster)
  category: decision-review
  department: Strategy
---

# 第一性原理审视（Musk · First Principles)

第一性原理 = 把事物拆到不可再拆的基本事实（物理定律、数学、真实成本、真实需求），再从那里向上重建。与之相对的是类比思维："别人都这么做""行业一直这样""上次就是这么成的"。类比只能做渐进改良；只有拆到底才可能得出数量级不同的答案。

核心口令：**物理学不服从你的营销。需求都是人定的，人定的就可能定错了——尤其聪明人定的需求，因为没人敢质疑。**

## 何时使用

- 成本"降不下来"、流程"必须有"、指标"必须达标"这类结论需要检验时。
- 新产品、新业务、新定价的可行性论证。
- 用户说"大家都这么做"作为理由时——这是触发信号，不是论据。

## 工作流

### Step 1：主张句化

把用户的想法写成一句话主张，并列出支撑它的全部关键假设（通常 5–10 条）。缺的替用户补上并标注"(补)"。

### Step 2：假设审计表

每条假设分类：

| 级别 | 含义 | 处理 |
| --- | --- | --- |
| A | 物理/数学事实 | 保留，作为重建地基 |
| B | 有可靠数据支撑 | 保留，标注数据来源与时效 |
| C | 行业惯例/历史做法 | 攻击 |
| D | 个人猜测 | 攻击 |
| E | 他人断言（供应商、专家、领导说的） | 攻击，且问"他的利益绑在哪里" |

重点攻击 C/D/E。

### Step 3：对每条 C/D/E 假设追问三连

1. 这条要求最初为什么存在？（当时的约束现在还在吗）
2. 如果今天从零开始，还会这么定吗？
3. 它是为了解决真实问题，还是为了免责、惯例、或提需求者的偏好？

补充武器：
- **"最好的零件是不存在的零件"**：这个环节/部件/流程被整体去掉会怎样？
- **10 倍检验**：如果目标只是好 10%，沿用惯例完全合理；用户要的是不是 10 倍？不是 10 倍就别用第一性原理硬拆，成本不划算。

### Step 4：从地基重建

只用 A/B 级假设，重新设计最小方案。涉及成本、价格、规模的，用**量级估算**重算：列出算式（数量 × 单价），允许 ±50% 误差，但不许跳过算式。真实数字缺失时：向用户要，或用联网工具查公开数据并标注来源；都拿不到就写区间并标注"待验证"。

### Step 5：输出

```markdown
# 第一性原理审视：<对象>

## 一句话主张
## 假设审计表（A/B/C/D/E 分级，C/D/E 附追问结论）
## 被推翻的假设（每条：原假设 → 为什么站不住 → 证据缺口）
## 重建方案（只用 A/B 假设的最小版本）
## 量级算式
## 待验证清单（按"对结论影响 × 验证成本"排序）
```

## 硬性规则

- 类比只能用作参照，不能用作论据；发现用户在用类比当论据时明确指出。
- 不编造数字。所有数字要么有来源，要么是标注过的估算区间。
- 第一性原理拆解有成本，结尾提醒：如果拆完发现这是个 10% 改良型问题，用类比更快。

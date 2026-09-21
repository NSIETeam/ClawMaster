# Agent Note: Thinking-review skill suite seeded for in-box distribution

Status: implemented

English | [中文](2026-09-21-thinking-review-skill-suite.zh.md)

## Problem

ClawMaster users bring ideas, plans, products, and decisions and need an objective stress test before committing resources. The installed skills produce artifacts or execute workflows — none challenges the user's own thinking. Product management asked for five mental models as a review capability: Naval Ravikant's leverage and long-term-games thinking, Charlie Munger's inversion, Elon Musk's first principles and five-step algorithm, and Steve Jobs's product and brand standards. The capability had to reach every install, including offline desktop installs, without a marketplace setup step.

## Decision

Six seed skills ship in [packages/core/skills-seed](../../../../packages/core/skills-seed/): `thinking-council` orchestrates a full multi-model review, and `first-principles-review`, `five-steps-review`, `inversion-review`, `naval-lens`, and `product-brand-review` each carry one framework at full depth. `seedDefaultSkills()` copies every new seed directory into `~/.clawmaster-user/skills/` at boot, so the suite installs itself on fresh installs and on existing installs alike; a user-modified skill is never overwritten.

Each skill fixes a review contract rather than free-form advice. The council restates the idea in its strongest form before challenging it, grades findings fatal/important/minor, scores five dimensions, and ends in exactly one verdict — GO, GO WITH FIXES, or NO-GO — plus a must-answer question list and kill criteria. The lens skills pin their framework's mechanics: assumption audit with first-principles reasoning, requirement-questioning with the delete-before-optimize ordering of the five steps, pre-mortem with a misjudgment checklist and stop-loss terms, the four-leverage audit with compounding assessment, and the simplicity/say-no/end-to-end walkthrough with a brand-promise test. Every skill requires sources for numbers or a marked estimate, and states that the verdict assists the user's judgment instead of replacing it.

Skill descriptions carry Chinese and English trigger phrases. Proactive invocation rides on the existing skill-discipline system-prompt section and the `<available_skills>` catalog; no code change beyond the seed directory is involved.

## Testing

A `FileSystemSkillProvider` scan over the user skill directory — the production discovery path, driven with a stub context outside any running session — discovers all six skills from their frontmatter with zero parse warnings. Frontmatter YAML was also validated independently, including `name`-to-directory agreement. On this machine the suite additionally runs live from the user layer; the installed desktop 0.2.3 build keeps seeding only its bundled office skills until a packaged build contains this directory.

## Alternatives considered

**One monolithic skill containing all five frameworks.** Catalog matching and trigger phrases lose granularity, and a user who names one framework would load instructions for all five. The council already composes the five lenses in a quick or deep mode; the separate lens skills keep per-framework loading.

**Encode the frameworks in the system prompt or the agent loop.** That prices every session, including ones that never review an idea, and repo convention puts new behavior on extension points rather than loop changes.

**Distribute through the marketplace plugin channel that carries the enterprise skill set.** That channel's source lives outside this repository, and it requires a marketplace install step; seeds are the distribution path this repository owns and ship in-box.

## Consequences

Every install built from this source gains the suite on next boot, and the content is version-controlled and reviewable with the product. The uniform output contract makes reviews comparable across ideas and over time.

The cost is output length: a deep five-lens review is a long response, which is why the council defines a quick mode for daily-use decisions. The frameworks are opinionated by design; the skills contain that risk with evidence rules, falsification notes per finding, and the explicit decision-support statement.

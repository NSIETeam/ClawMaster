---
description: "Deterministic review of destructive tool calls before they run — blocks irreversible commands and raises anything destructive for the user's own approval."
kind: "package-reference"
---

# @clawmaster/dsh-guard

English | [中文](README.zh.md)

## Summary

ClawMaster Guard is the review layer ClawMaster runs around an agent's work. It covers the three
moments a review can still change the outcome:

- **Process** (`tools/pre-execute`, the same interception point the Claude Code and Codex hook
  bridges use): refuses the calls that destroy something the user did not ask to destroy.
- **Result** (`session/event`, at every `turn/end`): reduces the finished turn to checkable facts
  and archives them into the notes vault.
- **Plan** (`exit_plan_mode`): reads the plan the model is about to submit and states what a
  reviewer would ask for — an acceptance criterion above all.

It never approves a destructive action on the model's behalf. Critical patterns (a root, home or
wildcard deletion, a device or filesystem writer, a fork bomb, deleting `.git`, a command that
shadows `HOME` before deleting) are denied outright. Everything else destructive is raised as an
approval request, and **an approval request in a session with no answerer fails closed**: with the
`never` approval policy the action is blocked rather than waved through, which is what makes the
guard useful unattended.

## What it decides

| Risk | Examples | Decision |
| --- | --- | --- |
| `critical` | `rm -rf /`, `rm -rf ~`, `rm -rf *`, `rm -rf .`, `rm -rf .git`, `HOME=/tmp rm -rf ~/x`, `find / -delete`, `mkfs.* /dev/…`, `dd of=/dev/…`, `chmod -R 777 /`, a fork bomb | deny |
| `high` | any other `rm`/`unlink`/`shred`, `git reset --hard`, `git clean -fdx`, `git push --force`, `git branch -D`, `npm publish`, `docker system prune`, `kubectl delete`, `terraform destroy`, `rsync --delete`, `DROP TABLE`, an unqualified `DELETE FROM`, `kill -9`, `truncate -s 0`, a redirect over a home-level file | ask |
| `medium` | another redirect that replaces a file's contents | allow, recorded |
| `low` | reads, builds, tests, `git status`/`commit`, creating files | allow |

Rules run on the command line as a shell reader sees it: quoted text is not mistaken for a
command, `sudo` and `env …` wrappers are stripped so `sudo rm -rf /` is reviewed as an `rm`,
subshells and `&&` chains are read as separate commands, and targets are expanded (`~`, `$HOME`,
same-line assignments) before they are judged.

Before it decides, the guard takes one read-only look at the targets a command names and puts what
it found in the reason both the user and the model read — `file, 5 bytes, exists`, `directory,
exists`, `missing — nothing exists there to destroy`, `a link to /srv/data`. That look can only make
the answer stricter: a target whose *resolved* path sits under a protected prefix is denied however
its own text reads, and a missing target is still raised for approval, because existence says
nothing about what the command will do to it.

## Use this package

Mount the plugin in the profile. All three stages are on with no other configuration: a reviewed
call is denied or raised for approval, a plan must say how its result will be checked, and every
finished turn is archived to the notes vault.

```yaml
- name: '@clawmaster/dsh-guard'
```

Optional configuration, where every field overrides one of those defaults:

```yaml
- name: '@clawmaster/dsh-guard'
  config:
    mode: observe
    shellTools: [bash, shell, run_command, exec]
    denyPaths: ['/Users/me/Documents']
    allowPaths: ['/tmp/scratch']
    resultReview: archive
    resultProject: ClawMaster
    planReview: enforce
```

`mode: observe` is the way to measure the rule set against real work before trusting it: the guard
logs its verdict and delegates.

## Result review

With `resultReview: archive` (the default) the guard subscribes to the session event stream and, at each
`turn/end`, composes a review of that turn from the turn's own events: which tools ran, which files
and commands they named, whether anything reported a failure, and whether a test, build or lint run
appeared. It states what it could not establish instead of implying success ("No test, build or lint
run appeared in this turn, so the result rests on inspection alone.").

The review is appended through the notes plugin's published vault access
(`ctx.provide('clawmasterNotes')`), so the daily note keeps one writer and one revision chain — the
same one the agent's own `notes_digest` uses. A turn that ran no tools is not archived, which is
what keeps the archive worth reading. If the notes plugin is not mounted, the guard says so and
skips; if the vault write fails, the session continues and the failure is logged.

## Model Experience

A denial or an approval request reaches the model as the reason string: the rule code, why the
rule fired, the resolved targets, and what the guard expects instead ("Destructive actions need the
user's own approval; the guard never grants one on the model's behalf"). The model is expected to
report the block and ask the user rather than work around it — the same instruction Codex's
auto-reviewer gives.

## Plan review

`planReview` reads the plan text before the plan is submitted for the user's approval:

| Finding | Binding? |
| --- | --- |
| `plan.no-acceptance` — the plan never says how its result will be checked | **yes** |
| `plan.unscoped-risk` — the plan touches something destructive or irreversible without naming the evidence that will show the result | no |
| `plan.no-evidence` — no command, hash, diff or test run is named as proof | no |
| `plan.no-steps` — no ordered steps, so the scope cannot be read from the plan | no |
| `plan.thin` — the body is too short to review | no |

With `enforce` (the default) a **binding** finding turns into an approval request, so a plan that
never says how it will be verified needs the user's own yes before work starts. With `advisory` the
findings are only logged and the plan proceeds. A plan that satisfies the rules passes
untouched in both modes. `planTool` names the submitting tool (default `exit_plan_mode`) if a
profile uses a different one.

## Known limitations and deferred work

- The classifier is deterministic and rule-based. It does not model whether *the user* authorized a
  specific target; anything destructive is raised instead, so a user-requested `rm` of a scratch
  file also needs a confirmation unless it sits under `allowPaths`.
- Shell text is read, not evaluated: a command assembled at runtime through variables, `eval`, a
  script file, or an interpreter (`python -c "shutil.rmtree(…)"`) is not resolved to its real
  target. `denyPaths` and the rule set are the backstop, not a sandbox.
- The read-only [target probe](src/probe.ts) never decides in the permissive direction. It adds
  facts to the reason and can refuse a target that resolves into a protected prefix, but it will not
  wave a command through because a path looked small or absent.
- Non-shell tools are not reviewed. A tool that deletes through its own API (for example the notes
  vault's own delete) keeps its own approval gate.

## Verification

`npm --prefix frontends/guard test` builds and then runs the suite: 95 cases covering the risk
table above, target expansion, `sudo`/`env` prefixes, subshells and chains, the quoted-prose
false-positive case, decision mapping, `observe` mode, `allowPaths`/`denyPaths`, workdir
resolution, and the mount itself — including that a denial never reaches the pipeline and that a
throwing review delegates instead of breaking the agent. The read-only probe has its own cases
against a real scratch tree: what a file, directory, link and missing path report, the inspection
bound, a link that resolves into a protected prefix, a path that merely resolves elsewhere, a
throwing inspection, and that a missing target is never waved through. The result stage has its own
cases: turn facts from representative events, unrecognized payloads, first-line-only commands, the
composed review text, per-session buffering, the `off` switch, a missing vault, and a failing vault
write.

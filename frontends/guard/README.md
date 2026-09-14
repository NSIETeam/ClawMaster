---
description: "Deterministic review of destructive tool calls before they run — blocks irreversible commands and raises anything destructive for the user's own approval."
kind: "package-reference"
---

# @clawmaster/dsh-guard

English | [中文](README.zh.md)

## Summary

ClawMaster Guard reviews every tool call just before it executes and refuses the ones that destroy
something the user did not ask to destroy. It mounts on the harness's `tools/pre-execute`
waterfall — the same interception point the Claude Code and Codex hook bridges use — so it works
for the shell tool, for subagents, and for any other tool that reaches that pipeline.

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

## Use this package

Mount the plugin in the profile. It needs no other configuration:

```yaml
- name: '@clawmaster/dsh-guard'
```

Optional configuration:

```yaml
- name: '@clawmaster/dsh-guard'
  config:
    mode: observe
    shellTools: [bash, shell, run_command, exec]
    denyPaths: ['/Users/me/Documents']
    allowPaths: ['/tmp/scratch']
```

`mode: observe` is the way to measure the rule set against real work before trusting it: the guard
logs its verdict and delegates.

## Model Experience

A denial or an approval request reaches the model as the reason string: the rule code, why the
rule fired, the resolved targets, and what the guard expects instead ("Destructive actions need the
user's own approval; the guard never grants one on the model's behalf"). The model is expected to
report the block and ask the user rather than work around it — the same instruction Codex's
auto-reviewer gives.

## Known limitations and deferred work

- The classifier is deterministic and rule-based. It does not model whether *the user* authorized a
  specific target; anything destructive is raised instead, so a user-requested `rm` of a scratch
  file also needs a confirmation unless it sits under `allowPaths`.
- Shell text is read, not evaluated: a command assembled at runtime through variables, `eval`, a
  script file, or an interpreter (`python -c "shutil.rmtree(…)"`) is not resolved to its real
  target. `denyPaths` and the rule set are the backstop, not a sandbox.
- No file-inspection step yet: Codex's reviewer stats the target before deciding a narrow deletion
  is safe. Adding a read-only target probe is the next step, not this version.
- Non-shell tools are not reviewed. A tool that deletes through its own API (for example the notes
  vault's own delete) keeps its own approval gate.

## Verification

`npm --prefix frontends/guard test` builds and then runs the suite: 62 cases covering the risk
table above, target expansion, `sudo`/`env` prefixes, subshells and chains, the quoted-prose
false-positive case, decision mapping, `observe` mode, `allowPaths`/`denyPaths`, workdir
resolution, and the mount itself — including that a denial never reaches the pipeline and that a
throwing review delegates instead of breaking the agent.

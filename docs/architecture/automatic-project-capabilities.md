# Automatic project capabilities

ClawMaster keeps automatic organization outside the Dawn turn kernel. The
native desktop runtime owns project inference, reads only bounded redacted
audit records, and exposes typed results to the renderer.

## Session project inference

An unassigned session is associated with a project only at a turn boundary and
only when one of these deterministic signals identifies a real directory:

1. A file, folder, or code reference resolves under a directory containing a
   `.git`, `Cargo.toml`, `package.json`, or `.agents` marker.
2. An absolute path in the user message resolves under such a directory.
3. Exactly one previously used real project has a sufficiently long directory
   name mentioned in the message.

Ambiguous or missing evidence leaves the session unassigned. Existing manual
assignment always wins.

## Skill and module candidates

Successful tool names are grouped by project and session. Three successful
occurrences of one tool or an adjacent two-tool path create a project Skill
candidate. Arguments, file contents, credentials, and raw tool output are never
copied from audit data. Confirmation writes a new file below
`.clawmaster/skills/<name>/SKILL.md`; rejection suppresses that exact candidate.

A failed call becomes a module candidate only when its bounded error detail
explicitly identifies a missing or unavailable capability. Ordinary input,
permission, network, provider, or execution errors do not qualify. Three
matching failures create a project-scoped proposal that appears as a dashed
module tile. No file is written before confirmation.

Confirmation writes `.clawmaster/modules/<name>/module.json`. The generated
module is a guided task that first composes installed Skills, MCP tools, and
signed capability packs. If a real implementation is still missing, it must use
the isolated self-development candidate, tests, permission review, resource
gates, and explicit installation approval. It must never report the missing
capability as successful.

## Trust boundary

Project module files are user-controlled input. Discovery canonicalizes the
module root, rejects symlink escapes and files over 1 MiB, and accepts only
schema version 1, `project-module:` IDs, `ready` status, and bounded required
text fields. Modules are loaded only for the active session's project.

The dashed tile and generated manifest prove candidate handling, not that a new
native capability exists. Capability completion still requires its own signed
package, policy, installation, runtime, rollback, and installed-path evidence.

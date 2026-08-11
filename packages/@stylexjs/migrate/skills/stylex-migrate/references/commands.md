# Command reference

Run commands from the repository whose `.stylex-migrate` state owns the task.
Use `--json` when consuming output programmatically.

```text
stylex-migrate init
stylex-migrate scan
stylex-migrate readiness
stylex-migrate plan
stylex-migrate mechanical propose <cluster-id>
stylex-migrate candidate diff <candidate-id>
stylex-migrate context open <cluster-id> "<goal>"
stylex-migrate context open <task-id>
stylex-migrate context inspect <task-id>
stylex-migrate context submit <task-id> <agent|human> <name> <version> [skill-version]
stylex-migrate context abandon <task-id>
stylex-migrate theme draft <json-file> <author>
stylex-migrate theme inspect <draft-id>
stylex-migrate theme approve <draft-id> <reviewer> --human-confirm
stylex-migrate theme propose <draft-id>
stylex-migrate verify <candidate-id>
stylex-migrate review <candidate-or-verdict-id>
stylex-migrate explain <cluster-or-candidate-id>
stylex-migrate status
```

`readiness` summarizes binding-backed Emotion styled definitions, theme facts,
and css-prop classifications from the current scan. Styled samples remain
unplanned observations until the kernel builds a definition/consumer cluster; do
not convert one merely because it appears in this report.

`mechanical propose` accepts only a current planned mechanical cluster. It runs
the deterministic conversion and its static comparison checks, then freezes the
exact checked bytes without modifying the source checkout. `candidate diff`
prints that exact frozen patch for review. Its output is intentionally verbatim,
so do not send it to an external system without the developer's authorization.

The first `context open` creates a task from the current plan. The second form
opens attempt two only when the kernel recorded `needs-replan`. It cannot reopen
an owner decision, blocked task, abandoned task, or exhausted task.

`context submit` freezes the worktree diff, validates its actual paths, stores a
content-addressed candidate, removes the external worktree, and returns the
candidate ID. The name and versions describe the proposer; they grant no
authority.

`theme draft` validates a complete token map against the current inventory and
stores an immutable draft. `theme inspect` reports whether it is drafted,
active, or superseded. The agent may use both commands.

`theme approve` is a human-only boundary. An agent must never invoke it or pass
`--human-confirm`, including when operating with broad shell permissions. The
named reviewer must inspect the map and run the command. `theme propose` is
allowed only after inspection reports `active`; it deterministically freezes a
candidate and does not write the source checkout.

`verify` executes configured repository checks in an isolated candidate
worktree. Runtime providers additionally execute the same argv against a
retained baseline worktree at the candidate's base commit. Exit code 0 means
eligible under the reported policy, 3 means blocked by missing requirements, and
4 means rejected by failed evidence. Always read the JSON claims, runtime
coverage, warnings, and limitations rather than relying only on the exit code.

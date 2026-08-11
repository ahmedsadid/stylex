# Command reference

Run commands from the repository whose `.stylex-migrate` state owns the task.
Use `--json` when consuming output programmatically.

```text
stylex-migrate context open <cluster-id> "<goal>"
stylex-migrate context open <task-id>
stylex-migrate context inspect <task-id>
stylex-migrate context submit <task-id> <agent|human> <name> <version> [skill-version]
stylex-migrate context abandon <task-id>
stylex-migrate verify <candidate-id>
stylex-migrate review <candidate-or-verdict-id>
stylex-migrate explain <cluster-or-candidate-id>
stylex-migrate status
```

The first `context open` creates a task from the current plan. The second form
opens attempt two only when the kernel recorded `needs-replan`. It cannot reopen
an owner decision, blocked task, abandoned task, or exhausted task.

`context submit` freezes the worktree diff, validates its actual paths, stores a
content-addressed candidate, removes the external worktree, and returns the
candidate ID. The name and versions describe the proposer; they grant no
authority.

`verify` executes configured repository checks in an isolated candidate
worktree. Runtime providers additionally execute the same argv against a
retained baseline worktree at the candidate's base commit. Exit code 0 means
eligible under the reported policy, 3 means blocked by missing requirements, and
4 means rejected by failed evidence. Always read the JSON claims, runtime
coverage, warnings, and limitations rather than relying only on the exit code.

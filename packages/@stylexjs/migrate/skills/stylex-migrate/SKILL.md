---
name: stylex-migrate
description:
  Execute a StyleX migration through a stylex-migrate contextual task capsule.
  Use when asked to inspect, implement, submit, retry, or diagnose a contextual
  Emotion-to-StyleX candidate produced by the stylex-migrate CLI.
---

# StyleX Migrate

Use the task capsule as the contract. The kernel owns scope, candidate identity,
checks, outcomes, and the two-attempt limit; do not replace those controls with
prose or agent judgment.

## Run the workflow

1. Run `stylex-migrate context inspect <task-id>` and read the entire task and
   current attempt.
2. Read [protocol.md](references/protocol.md) before editing. Use
   [commands.md](references/commands.md) for exact CLI forms.
3. Work only in `attempt.workspace.path`. Never edit the user's source checkout
   or `.stylex-migrate` directly.
4. Treat every fact status literally. `unknown` and `resolution-failed` do not
   mean false. Stop when a capsule stop condition applies.
5. Select only the relevant playbooks:
   - Read [emotion-css-prop.md](references/emotion-css-prop.md) for `css` prop
     conversion and declaration composition.
   - Read
     [themes-and-runtime-values.md](references/themes-and-runtime-values.md) for
     themes, identifiers, functions, and runtime-dependent values.
   - Read [component-contracts.md](references/component-contracts.md) for custom
     components, class names, props, refs, and public API behavior.
6. Keep the patch inside `task.scope.allowedPaths`. Protected paths and
   undeclared deletions are hard failures even if the change seems necessary.
7. Submit through `stylex-migrate context submit`; do not hand-build or edit a
   candidate record.
8. Run `stylex-migrate verify <candidate-id>`, then inspect the task again.
   - `eligible-for-review`: report the exact checks and limitations; do not call
     the result equivalent or runtime-matched.
   - `needs-replan`: open the kernel-authorized retry with
     `stylex-migrate context open <task-id>` and address the recorded failure.
   - `needs-owner-decision`: stop and report the decision or evidence required.
   - `blocked`: stop. Do not create another attempt outside the protocol.

Do not apply, commit, or claim runtime equivalence. The tool converts and tests;
source-tree application and commits remain the developer's responsibility.

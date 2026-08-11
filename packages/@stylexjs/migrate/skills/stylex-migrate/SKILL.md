---
name: stylex-migrate
description:
  'Guide agents through vendor-neutral stylex-migrate repository readiness,
  mechanical and contextual tasks, and approved theme token-map migrations.'
---

# StyleX Migrate

Use the task capsule as the contract. The kernel owns scope, candidate identity,
checks, outcomes, and the two-attempt limit; do not replace those controls with
prose or agent judgment.

## Choose the workflow

Run `stylex-migrate readiness` after a scan when selecting representative
migration work. Treat `emotion-styled-readiness` facts as syntax observations
and `emotion-styled-usage` facts as same-file component-boundary observations
only. `firstSliceEligible` means that the binding has no known boundary blocker;
it does not accept the CSS grammar, create a cluster, authorize edits, or claim
that a styled definition is convertible. A styled edit is authorized only when
the current plan contains an isolated `styled-intrinsic` cluster. Stop if the
requested work has no planned cluster.

`themeSliceEligible` is a separate structural observation for an intrinsic
styled template whose only modeled runtime input is the theme. It does not
approve a token map or authorize an edit. Continue only when the plan contains
a `styled-theme-intrinsic` site and the exact token map is the active
human-approved theme decision. Route that site through `theme propose`, never
through `styled propose` or an ad hoc rewrite.

Use `stylex-migrate explain <cluster-id>` to follow the current plan's route.
Use the mechanical workflow only for a planned `mechanical` cluster. Use the
theme-decision workflow when inventory facts show bounded literal theme
definitions plus mapped Emotion theme reads or providers. Use the contextual
task workflow for other non-mechanical clusters. Do not force a cluster into a
different lane.

## Run a mechanical proposal

1. Run `stylex-migrate mechanical propose <cluster-id>`. A refusal is a result;
   do not bypass it with an untracked rewrite.
2. Run `stylex-migrate candidate diff <candidate-id>` and inspect the exact
   frozen patch. This command emits source verbatim and intentionally does not
   redact it.
3. Run `stylex-migrate verify <candidate-id>`, then
   `stylex-migrate review <candidate-id>`.
4. Report the exact claims, comparison models, repository checks, coverage,
   warnings, and limitations. Static CSS matching is bounded to the named models
   and does not imply runtime equivalence.

## Run a closed intrinsic styled proposal

1. Inspect the current readiness and plan. Continue only for an isolated,
   planned `styled-intrinsic` cluster; do not choose an unplanned readiness or
   usage fact manually.
2. Run `stylex-migrate styled propose <cluster-id>`. A refusal is a result; do
   not rewrite only the definition or bypass an escape/grammar boundary.
3. Inspect the exact frozen patch with
   `stylex-migrate candidate diff <candidate-id>`.
4. Configure applicable repository checks, then run
   `stylex-migrate verify <candidate-id>` and
   `stylex-migrate review <candidate-id>`.
5. Report the exact static comparison model, repository-check coverage,
   runtime coverage, warnings, and limitations. Built-in static checks do not
   establish component-tree identity, refs, hydration, or rendered behavior.

## Run a contextual task

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
   - Read [runtime-evidence.md](references/runtime-evidence.md) when runtime
     providers are configured or the conversion depends on rendered state.
6. Keep the patch inside `task.scope.allowedPaths`. Protected paths and
   undeclared deletions are hard failures even if the change seems necessary.
7. Submit through `stylex-migrate context submit`; do not hand-build or edit a
   candidate record.
8. Run `stylex-migrate verify <candidate-id>`, then inspect the task again.
   - `eligible-for-review`: report the exact claims, scopes, checks, runtime
     cases, and limitations. Say `runtime-matched` only when the verdict
     contains that claim, and name its cases and recorded environment.
   - `needs-replan`: open the kernel-authorized retry with
     `stylex-migrate context open <task-id>` and address the recorded failure.
   - `needs-owner-decision`: stop and report the decision or evidence required.
   - `blocked`: stop. Do not create another attempt outside the protocol.

## Run a theme decision

1. Run `stylex-migrate scan`, then read
   [themes-and-runtime-values.md](references/themes-and-runtime-values.md) and
   the relevant facts with `stylex-migrate explain`.
2. Draft a complete token map from known literal definitions. Put the temporary
   JSON input outside the source checkout and run
   `stylex-migrate theme draft <json-file> <agent-name>`.
3. Run `stylex-migrate theme inspect <draft-id>` and present the exact map,
   limitations, and approval command to a human.
4. Stop. Never run `stylex-migrate theme approve`, never pass `--human-confirm`,
   and never describe agent assent as human approval. Resume only after a human
   says they ran the approval command.
5. Inspect the draft again. Continue only when its state is `active`; then run
   `stylex-migrate theme propose <draft-id>`. This command also owns eligible
   `styled-theme-intrinsic` consumers. It must rewrite the styled definition and
   every closed same-file JSX consumer atomically. Every consumer must remain
   inside a provider subtree that the same proposal converts from a declared
   Emotion variant to the corresponding StyleX theme. A token-only rewrite or
   partial provider rewrite is a refusal, not a task for agent improvisation.
6. Run `stylex-migrate verify <candidate-id>` and
   `stylex-migrate review <candidate-id>`. Inspect the frozen patch with
   `stylex-migrate candidate diff <candidate-id>`. Report the decision artifact
   hash, exact claims and checks, site/runtime coverage, and every warning.

For styled theme candidates, inspect the configured runtime cases for every
declared light/dark state that matters to the approved map. Repository checks
may still make a permissive verdict eligible for human review when runtime is
not configured, but that verdict carries a prominent no-runtime warning and no
`runtime-matched` claim. Never summarize that outcome as theme behavior having
been verified.

Changing or superseding the active map makes prior dependent candidates stale.
Do not reuse their evidence or try to recreate the older activation.

Do not apply, commit, or claim runtime equivalence. A `runtime-matched` claim is
sampled evidence for named cases, not equivalence. The tool converts and tests;
source-tree application and commits remain the developer's responsibility.

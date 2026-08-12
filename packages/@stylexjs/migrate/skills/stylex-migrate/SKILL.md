---
name: stylex-migrate
description:
  'Guide agents through vendor-neutral stylex-migrate repository readiness,
  StyleX dependency/build bootstrap, mechanical and contextual tasks, dynamic
  styled values, and approved theme token-map migrations.'
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
approve a token map or authorize an edit. A same-file provider conversion may
appear as a planned `styled-theme-intrinsic` site. A repository-managed bridge
consumer may instead be selected explicitly in a human-reviewed theme draft; the
draft must pin bridge boundary files and cover the consumer path. Route either
form through `theme propose`, never through `styled propose` or an ad hoc
rewrite.

`dynamicSliceEligible` is the bounded contextual route for a local, non-exported
intrinsic styled definition with prop-dependent callbacks and a closed same-file
consumer graph. Read its `emotion-styled-dynamic-value` fact before editing. The
fact records syntax, prop paths, finite literal branches, operation risks, and
existing merge surfaces; its `unknowns` remain unknown. Before opening the
planned `styled-dynamic-intrinsic` cluster, persist and inspect an exact
strategy for every observed definition/prop path with `dynamic strategy draft`
and `dynamic strategy inspect`. Then use `context open`. Never pass it to
`styled propose`.

Use `stylex-migrate explain <cluster-id>` to follow the current plan's route.
Use the mechanical workflow only for a planned `mechanical` cluster. Use the
theme-decision workflow when inventory facts show bounded literal theme
definitions plus mapped Emotion theme reads or providers. Use the contextual
task workflow for other non-mechanical clusters. Do not force a cluster into a
different lane.

Before choosing runtime evidence for theme or dynamic work, run
`stylex-migrate runtime inspect`. Prefer a repository-native surface whose
status is `known`. `inferred` means supporting packages exist but no executable
rendering surface was established; do not invent an argv from that. When no
known surface can exercise the exact named behavior, follow the generated-probe
workflow in [runtime-evidence.md](references/runtime-evidence.md). Run
`stylex-migrate theme topology` before proposing a root/global theme host. Its
observations may justify a labelled test assumption, but they are syntactic
facts rather than topology approval.

## Bootstrap StyleX in the repository

Use this workflow when the repository has Emotion migration work but no usable
StyleX build integration.

1. Run `stylex-migrate scan`, then `stylex-migrate bootstrap inspect`. Treat
   package-manager and build-integration statuses literally. Stop on ambiguity
   or `resolution-failed`; do not choose a lockfile or compiler by guesswork.
2. Run `stylex-migrate bootstrap open "<goal>"`. Continue only when it returns
   an open `bootstrap` task. Read its complete capsule and stop conditions.
3. Work only in the returned workspace. For this task alone, the exact
   `scope.bootstrapPaths` entries authorize the discovered package manifest,
   lockfile, and Rspack config. They do not authorize any other configuration or
   application source.
4. Run each exact argv array in `task.origin.installCommands` directly in the
   workspace without a shell. Do not substitute another version, source,
   package, package manager, flag, or working tree. Then wire the unplugin's
   `.rspack(...)` adapter into the discovered config while preserving existing
   plugins and options. Do not add unrelated dependencies, scripts, entry files,
   or migrations.
5. Submit with `stylex-migrate context submit`, then inspect the frozen patch
   and run `stylex-migrate verify <candidate-id>` and
   `stylex-migrate review <candidate-id>`.
6. Report the two different evidence boundaries. The frozen wiring guard proves
   required declarations and syntactic adapter wiring. The built-in Rspack
   sentinel performs a frozen-lockfile install and requires transformed
   JavaScript plus emitted CSS, then runs the capsule's exact repository build
   argv against the candidate config. Until a real migrated StyleX consumer is
   in that build, the sentinel—not the application output—is the emitted-CSS
   proof. Keep that limitation explicit.

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
5. Report the exact static comparison model, repository-check coverage, runtime
   coverage, warnings, and limitations. Built-in static checks do not establish
   component-tree identity, refs, hydration, or rendered behavior.

## Run a contextual task

1. Run `stylex-migrate context inspect <task-id>` and read the entire task and
   current attempt.
2. Read [protocol.md](references/protocol.md) before editing. Use
   [commands.md](references/commands.md) for exact CLI forms.
3. Work only in `attempt.workspace.path`. Never edit the user's source checkout
   or `.stylex-migrate` directly. If `task.requiredOutputs` is non-empty, treat
   every listed file as kernel-generated and immutable. Do not format, rename,
   regenerate, annotate, or otherwise change its bytes; submission enforces the
   recorded hash.
4. Treat every fact status literally. `unknown` and `resolution-failed` do not
   mean false. Stop when a capsule stop condition applies. When a developer
   authorizes a disposable test assumption, record it with
   `stylex-migrate assumption record`, inspect it, and pass its ID after the
   goal in `context open`. Bound assumptions are exact test inputs, never owner
   decisions. Do not delete their warnings from reports.
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

An `evidence-surface` task is different: both allowed files are generated and
immutable, so make no edits. Submit it immediately. Verify its candidate
together with every migration candidate named by its runtime cases; verifying
the surface alone cannot establish coverage of unchanged application paths.

For a `styled-dynamic-intrinsic` cluster, first follow the dynamic strategy
workflow in
[themes-and-runtime-values.md](references/themes-and-runtime-values.md).
Submission runs a frozen-byte wiring guard before repository verification. A
guard pass is a syntax claim only; it does not resolve the dynamic fact's
unknowns or earn `runtime-matched`.

## Run a theme decision

1. Run `stylex-migrate scan`, then read
   [themes-and-runtime-values.md](references/themes-and-runtime-values.md) and
   the relevant facts with `stylex-migrate explain`. Run
   `stylex-migrate theme candidates` to select exact consumer files; treat
   `bridgeReady` as a syntax/usage result, not proof that bridge coverage
   exists.
2. Put the temporary JSON input outside the source checkout. Declare variants,
   their root source module, the target module, and exact consumer files. The
   input may instead declare a bounded `consumerSelection` with a readiness
   mode, explicit include globs, and `maxFiles` from 1 to 100. The `tokens`
   array may be omitted: the tool will scaffold known consumer reads with stable
   full-path names, resolve only those requested paths through bounded object
   composition and imports, and pin every transitive source file. Run
   `stylex-migrate theme draft <json-file> <agent-name>`.
3. Run `stylex-migrate theme inspect <draft-id>` and present every exact
   `mappings` entry, variant source, bridge declaration, limitation, and the
   approval command to a human. If a bridge is declared and
   `bridgeEvidence.complete` is not true, do not recommend approval. Run
   `stylex-migrate theme bridge open <draft-id> "<goal>" [assumption-id...]` to
   open the bounded prerequisite integration task. Its generated theme module is
   a locked required output. Edit only the named boundary files, keep the
   Emotion provider, reuse its exact variant-selection source, avoid new
   semantic DOM wrappers or unreviewed global DOM mutation. A body/document host
   experiment requires a bound test assumption. Split
   `stylex.props(theme).className` on whitespace, filter empty tokens, and
   spread the same token list into both `classList.add` and `classList.remove`;
   the frozen guard rejects unsplit or asymmetric wiring. Then submit through
   the normal contextual protocol. Every generated variant must reach
   `stylex.props` in the frozen candidate. Static observation remains only a
   wiring guard; require repository checks and relevant light/dark runtime
   cases. The developer, not the tool or agent, decides whether and how to apply
   the reviewed bridge candidate. Rescan and create a current draft after
   external application. For a disposable, assumption-bound root/body-portal
   experiment, create the small v2 probe JSON described in
   [runtime-evidence.md](references/runtime-evidence.md), then run
   `stylex-migrate theme probe open <draft-id> <assumption-id> <json-file> "<goal>"`.
   Select `surface: "repository"` only for a real executable route; select
   `surface: "generated-rspack"` when no such route is usable. Do not
   hand-author the four cases or copy browser-normalized values into expected
   observations. The tool derives light/dark × root/portal cases and source
   token values from the exact persisted draft. Submit the immutable surface
   unchanged. A repository surface must be verified with the matching theme
   module, bridge, and tested consumers. A generated Rspack surface exercises
   only the generated theme module unless it names exactly one
   `generatedConsumer`; that narrower mode renders the exact exported consumer
   and may claim only that consumer plus the generated theme module. It never
   proves the repository bridge or application route.
4. Stop at approval. Never run `stylex-migrate theme approve`, never pass
   `--human-confirm`, and never describe agent assent as human approval. Resume
   only after a human says they ran the approval command for production-intent
   migration. For a disposable test explicitly authorized by a current test
   assumption, run `stylex-migrate theme experiment <draft-id> <assumption-id>`
   instead. Its deterministic candidate binds the draft and assumption hashes,
   never earns `approved`, and must retain the warning in review output.
5. Inspect the draft again. Continue only when its state is `active`; then run
   `stylex-migrate theme propose <draft-id>`. This command also owns eligible
   `styled-theme-intrinsic` consumers. It must rewrite the styled definition and
   every closed same-file JSX consumer atomically. Without a bridge declaration,
   every consumer must remain inside a provider subtree that the same proposal
   converts from a declared Emotion variant to the corresponding StyleX theme.
   With repository-managed bridge coverage, the boundary implementation must
   already exist in the pinned boundary files and the consumer must match the
   approved coverage globs. Coverage is a human assertion, not a static
   provider-graph proof. A token-only rewrite or partial definition/consumer
   rewrite is a refusal, not a task for agent improvisation.
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

Never draft bridge coverage merely to bypass the same-file provider refusal. Use
it only for a repository integration that applies every generated StyleX variant
at the real root, nested, portal, and inverted boundaries required by the
selected consumers. `theme bridge open` checks exact generated bytes and
syntactic wiring on the frozen candidate; it does not prove variant selection or
provider topology. The approval warning remains material even when boundary
files are hash-pinned. Require runtime cases that traverse the claimed scope.

Changing or superseding the active map makes prior dependent candidates stale.
Do not reuse their evidence or try to recreate the older activation.

Do not apply, commit, or claim runtime equivalence. A `runtime-matched` claim is
sampled evidence for named cases, not equivalence. The tool converts and tests;
source-tree application and commits remain the developer's responsibility.

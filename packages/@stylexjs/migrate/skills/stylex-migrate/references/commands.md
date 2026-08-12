# Command reference

Run commands from the repository whose `.stylex-migrate` state owns the task.
Use `--json` when consuming output programmatically.

```text
stylex-migrate init
stylex-migrate scan
stylex-migrate readiness
stylex-migrate plan
stylex-migrate mechanical propose <cluster-id>
stylex-migrate styled propose <cluster-id>
stylex-migrate bootstrap inspect
stylex-migrate bootstrap open "<goal>" [package-root] [stylex-spec] [integration-spec] [unplugin-spec] [integration-kind]
stylex-migrate candidate diff <candidate-id>
stylex-migrate dynamic strategy draft <json-file> <agent|human> <author>
stylex-migrate dynamic strategy inspect <draft-id>
stylex-migrate assumption record <json-file> <agent|human> <author>
stylex-migrate assumption inspect <assumption-id>
stylex-migrate runtime inspect
stylex-migrate runtime probe open <assumption-id> <json-file> "<goal>"
stylex-migrate theme probe open <draft-id> <assumption-id> <json-file> "<goal>"
stylex-migrate theme topology
stylex-migrate context open <cluster-id> "<goal>" [assumption-id...]
stylex-migrate context open <task-id>
stylex-migrate context inspect <task-id>
stylex-migrate context submit <task-id> <agent|human> <name> <version> [skill-version]
stylex-migrate context abandon <task-id>
stylex-migrate theme candidates
stylex-migrate theme draft <json-file> <author>
stylex-migrate theme inspect <draft-id>
stylex-migrate theme bridge open <draft-id> "<goal>" [assumption-id...]
stylex-migrate theme approve <draft-id> <reviewer> --human-confirm
stylex-migrate theme propose <draft-id>
stylex-migrate theme experiment <draft-id> <assumption-id>
stylex-migrate verify <candidate-id>
stylex-migrate review <candidate-or-verdict-id>
stylex-migrate explain <cluster-or-candidate-id>
stylex-migrate status
```

`readiness` summarizes binding-backed Emotion styled definitions, same-file
usage and escape graphs, theme facts, and css-prop classifications from the
current scan. `firstSliceEligible` means only that the initial binding and JSX
boundary is closed; `flatTemplateGrammarEligible` adds only the bounded CSS
syntax screen. Neither alone authorizes an edit. Continue only when the current
plan contains an isolated `styled-intrinsic` cluster.

For prop-dependent styled callbacks, `dynamicValueFacts` counts exact syntax
observations, `dynamicSliceEligible` counts definitions that pass the first
local intrinsic/consumer boundary, and `plannedDynamicSites` counts contextual
sites. These are not deterministic eligibility. Open only a planned
`styled-dynamic-intrinsic` cluster through `context open` and preserve every
unknown listed by its fact.

`mechanical propose` accepts only a current planned mechanical cluster. It runs
the deterministic conversion and its static comparison checks, then freezes the
exact checked bytes without modifying the source checkout. `candidate diff`
prints that exact frozen patch for review. Its output is intentionally verbatim,
so do not send it to an external system without the developer's authorization.

`styled propose` atomically rewrites one planned closed intrinsic definition and
all of its known direct JSX consumers. It freezes only output that passed the
built-in StyleX and static CSS checks. The candidate remains
repeatable-contextual: repository checks are mandatory, and missing runtime
evidence remains a prominent limitation.

`bootstrap inspect` reports the exact package-manager, package ownership,
lockfile, build integration, config inputs, and existing StyleX dependencies
seen from the current inventory. `bootstrap open` accepts an exact Rspack or
Babel target and creates a normal contextual task whose `bootstrapPaths`
authorize only the discovered manifest, lockfile, and config. Submission
requires the integration-specific StyleX packages, a changed lockfile, and
bounded syntactic wiring. Verification automatically installs the locked
candidate dependencies, compiles a real emitted-CSS sentinel (including runtime
injection for Babel), and runs the exact selected repository application build
command. Without a real migrated consumer, only the isolated sentinel proves
emitted StyleX CSS. The optional StyleX and integration specs default to the
migrate package version; omitting only the integration spec reuses the StyleX
spec. The unplugin peer defaults to `^2.3.11`. Supplying another literal is an
explicit developer choice recorded in the task origin. The agent must run the
returned `installCommands` argv arrays exactly.

`dynamic strategy draft` validates exact coverage of every observed prop path in
one current planned `styled-dynamic-intrinsic` cluster and activates the
content-addressed draft. A newer draft for that cluster supersedes the old one.
The command records migration intent and evidence requirements; it is neither
human approval nor behavioral evidence. `dynamic strategy inspect` reports the
exact entries and whether the draft remains active. Put its temporary JSON input
outside the source checkout.

The first `context open` creates a task from the current plan. The second form
opens attempt two only when the kernel recorded `needs-replan`. It cannot reopen
an owner decision, blocked task, abandoned task, or exhausted task.

`assumption record` persists a content-addressed test-only artifact with exact
facts, repository input fingerprints, rationale, scope, alternatives, author,
and limitations. Both agents and humans may author one. It never becomes
`approved`. `assumption inspect` reports current or stale. Passing IDs after a
context or bridge goal binds them separately from decision artifacts through the
task, candidate, and evidence subject.

`runtime inspect` reports repository-native Playwright, Storybook, and
component-test surfaces as `known`, dependency-only possibilities as `inferred`,
and absence as `unknown`. `theme topology` records direct global hosts, class
mutations, portals, secondary windows, and secondary-document access. Neither
command supplies runtime proof.

`runtime probe open` creates an immutable `evidence-surface` task from a strict
declarative definition and a bound test assumption. It generates the collector
and config rather than accepting an agent-authored script. Submit it unchanged,
then verify the resulting candidate together with every migration candidate
named by its runtime cases. The generated provider is attached automatically to
that exact candidate set.

`theme probe open` compiles a smaller repository-wiring definition plus an exact
persisted theme draft into the standard light/dark root/portal matrix. It
derives expected source values from the draft and browser-normalizes them using
the mapped CSS property; the agent does not supply expected computed values. The
result remains generated-probe evidence bound to a test assumption, not a
retained application baseline or owner approval.

`context submit` freezes the worktree diff, validates its actual paths, stores a
content-addressed candidate, removes the external worktree, and returns the
candidate ID. The name and versions describe the proposer; they grant no
authority. Dynamic tasks additionally require their bound strategy to remain
active and run a frozen-byte wiring guard before candidate persistence. That
guard does not replace repository or runtime evidence.

`theme bridge open` creates a contextual task directly from an exact current
theme draft before approval. It permits changes only to the draft's boundary
files and target module, seeds the deterministic module as an immutable required
output, and binds the draft definition hash to the snapshot and candidate. Bound
test assumptions may authorize named global-host experiments without claiming
production intent. Global-host wiring must split the StyleX class name and
spread identical tokens into DOMTokenList add/remove calls. Use the normal
`context inspect`, `context submit`, `candidate diff`, `verify`, and `review`
commands afterward. The command never edits the source checkout.

`theme candidates` reports each exact styled-theme file's definitions,
`themePaths`, local-provider readiness, bridge readiness, and blockers. It is a
selection report only; `bridgeReady` does not assert that a repository bridge
exists or covers the path.

`theme draft` may accept an explicit token map or scaffold one from known theme
reads in the declared consumer files. A bounded `consumerSelection` may select
`bridge-ready` or `local-provider-ready` files under explicit include globs, up
to a required `maxFiles` from 1 to 100. Scaffolded names use the full source
path so later batches do not rename existing entries. The command resolves the
requested paths through a bounded static evaluator, pins each variant entry
module and all transitive source files, validates against the current inventory,
and stores an immutable draft. `theme inspect` reports whether it is drafted,
active, or superseded and shows the exact reviewable entries under `mappings`.
The agent may use both commands.

`theme approve` is a human-only boundary. An agent must never invoke it or pass
`--human-confirm`, including when operating with broad shell permissions. The
named reviewer must inspect the map and run the command. `theme propose` is
allowed only after inspection reports `active`; it deterministically freezes a
candidate and does not write the source checkout.

`theme experiment` is the test-only counterpart to `theme propose`. It accepts a
current draft plus a current test assumption whose file scope contains the
target module and every selected consumer. A bridge boundary need only be in
scope when the experiment also changes or claims runtime coverage for it. It
uses the same deterministic rewriter but binds the draft definition hash and
assumption hash instead of creating or consuming an approval. It cannot earn
`approved` or establish repository intent. Keep its warning and exact assumption
scope in every report.

A draft may declare repository-managed bridge `coverageGlobs` and
`boundaryFiles`. The boundary files are hash-pinned inputs, but the coverage is
still a human scope assertion. It does not earn a provider-graph or runtime
claim; configure runtime cases for the covered theme states and boundaries.
Inspection reports `complete` only when every generated variant is referenced
through `stylex.props` across parseable pinned boundaries. This observation is
only a minimum wiring signal. When it is incomplete, use `theme bridge open`
before recommending approval. Human approval remains technically permissive with
warnings; incomplete observation never becomes runtime evidence.

`verify` executes configured repository checks in an isolated candidate
worktree. Runtime providers additionally execute the same argv against a
retained baseline worktree at the candidate's base commit. Exit code 0 means
eligible under the reported policy, 3 means blocked by missing requirements, and
4 means rejected by failed evidence. Always read the JSON claims, runtime
coverage, warnings, and limitations rather than relying only on the exit code.

# Contextual task protocol

The task capsule is immutable JSON bound to its origin, goal, current inventory,
optional plan, work unit, base commit, input hashes, facts, scope, decisions,
required generated outputs, checks, limitations, stop conditions, and maximum
attempt count. The attempt capsule is also immutable and binds the external
worktree, required outputs, and prior failures. A `plan-cluster` origin comes
from normal planning. A `theme-bridge` origin is a first-class workflow bound to
one exact theme draft; it does not pretend to be a persisted plan cluster. A
`bootstrap` origin binds one inspected package manager, package root, build
integration, and exact configuration surface without pretending configuration
edits are ordinary migration edits. An `evidence-surface` origin binds one test
assumption, exact runtime cases/expectations, and two immutable generated probe
files; it is test scaffolding, not application migration or owner intent.

## Authority

The kernel is authoritative for:

- the bytes frozen into a candidate;
- changed-path scope and protected-path enforcement;
- candidate, snapshot, evidence, and verdict identities;
- configured repository checks;
- task and attempt state;
- the maximum of two attempts;
- active decision artifacts and their binding to snapshots, candidates,
  evidence, and verdicts.

The proposer is responsible only for editing files in the supplied worktree. An
explanation cannot widen scope, turn missing evidence into a pass, or create an
additional attempt.

Every `requiredOutputs` entry is kernel-generated and immutable. The kernel
stores its bytes by content hash, seeds them when opening and retrying, and
rejects submission if the file is missing, symlinked, or changed. Never run a
formatter over a required output.

Theme token-map approval is reserved for a named human. Agents may draft,
inspect, propose from an already active decision, and verify; they may not run
the approval command or pass its human-confirmation flag.

## Fact certainty

- `known`: supported by the recorded provenance and exact input files.
- `inferred`: useful evidence, but not established as fact.
- `unknown`: no supported answer was established. Never interpret as false.
- `resolution-failed`: an attempted resolution failed. Never interpret as
  absence.

If the proposed conversion depends on an inferred, unknown, or resolution-failed
fact, either derive evidence from the declared inputs or stop under the
capsule's conditions. Do not execute dynamic project configuration to
manufacture certainty.

## State sequence

`open` permits edits in the attempt worktree. Submission freezes the patch and
moves the task to `awaiting-verification`. Verification can produce:

- `eligible-for-review` when the configured checks applicable to the exact
  candidate passed;
- `needs-replan` after a rejected first attempt;
- `needs-owner-decision` when required evidence or intent is missing;
- `blocked` after the second failed attempt;
- `abandoned` when the user stops an open attempt.

These are task states, not semantic-equivalence claims. A verdict emits
`runtime-matched` only when every case declared by the configured runtime
providers matched between the retained baseline and candidate worktrees. Its
scope is limited to those cases, states, sites, viewports, and environments.

## Scope and safety

Edit only `scope.allowedPaths`. Treat `scope.protectedPaths`, lockfiles,
configuration, `.stylex-migrate`, undeclared deletions, symlinks, submodules,
binary files, and mode changes as unavailable. If a correct conversion requires
one, stop and request replanning or an owner decision.

The only exception is a kernel-created `bootstrap` task: its exact
`scope.bootstrapPaths` entries authorize the named manifest, lockfile, and build
config. Wildcards and any other configuration path remain forbidden. This
exception authorizes proposal bytes in the external worktree, not direct writes
to the source checkout and not application or commit authority.

An `evidence-surface` task may add only its exact generated collector and config
paths. Both are required outputs; the proposer edits neither. Its provider runs
only when that candidate participates in the exact verified candidate set.

The source checkout may contain unrelated dirt. Never copy it into the task.
Declared task inputs are already bound to HEAD and a dirty declared input blocks
opening the task.

A theme bridge task may change only the exact bridge boundary files and emitted
theme module. Preserve the existing Emotion provider during bridge coexistence.
Do not add semantic wrappers or mutate global DOM state merely to carry StyleX
props. Submission requires every declared generated variant to be referenced by
`stylex.props` in the frozen boundary set. This syntactic check does not prove
correct runtime selection, portal coverage, inversion, SSR, or hydration.

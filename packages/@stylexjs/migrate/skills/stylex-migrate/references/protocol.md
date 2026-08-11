# Contextual task protocol

The task capsule is immutable JSON bound to its goal, current plan and
inventory, cluster, base commit, input hashes, facts, scope, decisions, checks,
limitations, stop conditions, and maximum attempt count. The attempt capsule is
also immutable and binds the external worktree plus prior failures.

## Authority

The kernel is authoritative for:

- the bytes frozen into a candidate;
- changed-path scope and protected-path enforcement;
- candidate, snapshot, evidence, and verdict identities;
- configured repository checks;
- task and attempt state;
- the maximum of two attempts.

The proposer is responsible only for editing files in the supplied worktree. An
explanation cannot widen scope, turn missing evidence into a pass, or create an
additional attempt.

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

These are task states, not semantic-equivalence claims. M7 does not emit a
`runtime-matched` claim.

## Scope and safety

Edit only `scope.allowedPaths`. Treat `scope.protectedPaths`, lockfiles,
configuration, `.stylex-migrate`, undeclared deletions, symlinks, submodules,
binary files, and mode changes as unavailable. If a correct conversion requires
one, stop and request replanning or an owner decision.

The source checkout may contain unrelated dirt. Never copy it into the task.
Declared task inputs are already bound to HEAD and a dirty declared input blocks
opening the task.

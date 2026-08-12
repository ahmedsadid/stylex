/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

/**
 * The migration state machine.
 *
 * Two rules are enforced here rather than in prose:
 *
 *   1. Only the kernel advances a candidate. A proposer — deterministic rule or
 *      agent alike — can create a candidate and nothing else. It can never mark
 *      its own work auto-eligible, approved, or applied.
 *   2. Approval is a human act. No automated actor can produce `approved`.
 */

export type MigrationState =
  | 'discovered'
  | 'classified'
  | 'planned'
  | 'candidate-created'
  | 'evidence-collected'
  | 'rejected'
  | 'blocked'
  | 'eligible-for-review'
  | 'auto-eligible'
  | 'approved'
  | 'write-ready'
  | 'applied'
  | 'stale';

export type Actor = 'kernel' | 'proposer' | 'human';

const TRANSITIONS: { +[MigrationState]: $ReadOnlyArray<MigrationState> } = {
  discovered: ['classified', 'blocked'],
  classified: ['planned', 'blocked'],
  planned: ['candidate-created', 'blocked', 'stale'],
  'candidate-created': ['evidence-collected', 'rejected', 'blocked', 'stale'],
  'evidence-collected': [
    'eligible-for-review',
    'auto-eligible',
    'rejected',
    'blocked',
    // A new attempt discards the collected evidence with the candidate.
    'candidate-created',
    'stale',
  ],
  'eligible-for-review': ['approved', 'rejected', 'blocked', 'stale'],
  'auto-eligible': ['write-ready', 'rejected', 'blocked', 'stale'],
  approved: ['write-ready', 'stale'],
  'write-ready': ['applied', 'stale', 'rejected'],
  rejected: ['candidate-created'],
  blocked: ['candidate-created'],
  stale: ['planned'],
  applied: [],
};

const ACTORS_ALLOWED: { +[MigrationState]: $ReadOnlyArray<Actor> } = {
  'candidate-created': ['kernel', 'proposer'],
  approved: ['human'],
};

export function allowedTransitions(
  from: MigrationState,
): $ReadOnlyArray<MigrationState> {
  return TRANSITIONS[from] ?? [];
}

export function canTransition(
  from: MigrationState,
  to: MigrationState,
  actor: Actor,
): boolean {
  if (!allowedTransitions(from).includes(to)) {
    return false;
  }
  const actors = ACTORS_ALLOWED[to] ?? ['kernel'];
  return actors.includes(actor);
}

/**
 * Returns the new state, or throws. A rejected transition is a protocol error
 * in the caller, not an expected outcome of a migration, so it fails loudly.
 */
export function transition(
  from: MigrationState,
  to: MigrationState,
  actor: Actor,
): MigrationState {
  if (!allowedTransitions(from).includes(to)) {
    throw new Error(
      `Invalid migration state transition: ${from} -> ${to}. ` +
        `Allowed from ${from}: ${allowedTransitions(from).join(', ') || '(none)'}.`,
    );
  }
  const actors = ACTORS_ALLOWED[to] ?? ['kernel'];
  if (!actors.includes(actor)) {
    throw new Error(
      `Actor "${actor}" may not set state "${to}". Allowed: ${actors.join(', ')}.`,
    );
  }
  return to;
}

export function isTerminal(state: MigrationState): boolean {
  return allowedTransitions(state).length === 0;
}

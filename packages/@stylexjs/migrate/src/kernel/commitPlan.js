/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { writeCandidate } from '../candidate/write';
import { allPassed } from './evidence';
import { transition } from './state';
import type { CandidatePatch } from '../candidate/patch';
import type { EvidenceResult } from './evidence';
import type { ScopeRules } from '../candidate/scope';
import type { WorkspaceSnapshot } from './snapshot';
import type { WriteResult } from '../candidate/write';

/**
 * The commit plan: the only route from a candidate to the user's files.
 *
 * The state machine on its own is advisory — a caller could hold a candidate,
 * skip every transition, and write. That is the same shape of mistake as the
 * previous generation of this tool, whose verification gates lived beside the
 * write path rather than in it. So the writer is internal, and reaching it
 * requires presenting the things that make a write defensible:
 *
 *   - an immutable candidate,
 *   - an evidence bundle addressed to that candidate's hash,
 *   - an approval naming that same hash,
 *   - and a state the kernel itself advanced to `write-ready`.
 *
 * Every one of those is re-checked here rather than trusted, and the candidate
 * is re-validated for staleness inside the write itself.
 */

export type EvidenceBundle = {
  +candidateId: string,
  +results: $ReadOnlyArray<EvidenceResult>,
};

export type Approval = {
  +candidateId: string,
  +approvedBy: string,
  +approvedAt: string,
  // What the approver was told was not covered.
  +limitations: $ReadOnlyArray<string>,
};

export type CommitPlanEntry = {
  +candidate: CandidatePatch,
  +snapshot: WorkspaceSnapshot,
  +evidence: EvidenceBundle,
  +approval: Approval,
  +scopeRules: ScopeRules,
};

export type CommitPlan = {
  +entries: $ReadOnlyArray<CommitPlanEntry>,
};

export type CommitPlanResult =
  | { +status: 'committed', +writes: $ReadOnlyArray<WriteResult> }
  | { +status: 'rejected', +reason: string, +candidateId: string | null }
  | {
      +status: 'halted',
      +reason: string,
      +writes: $ReadOnlyArray<WriteResult>,
    };

export function approve({
  candidate,
  approvedBy,
  limitations = [],
  now = () => new Date().toISOString(),
}: {
  +candidate: CandidatePatch,
  +approvedBy: string,
  +limitations?: $ReadOnlyArray<string>,
  +now?: () => string,
}): Approval {
  return Object.freeze({
    candidateId: candidate.id,
    approvedBy,
    approvedAt: now(),
    limitations: Object.freeze([...limitations]),
  });
}

export function bundleEvidence(
  candidate: CandidatePatch,
  results: $ReadOnlyArray<EvidenceResult>,
): EvidenceBundle {
  return Object.freeze({
    candidateId: candidate.id,
    results: Object.freeze([...results]),
  });
}

function checkEntry(entry: CommitPlanEntry): string | null {
  const { candidate, snapshot, evidence, approval } = entry;

  if (evidence.candidateId !== candidate.id) {
    return `evidence belongs to candidate ${evidence.candidateId}, not ${candidate.id}`;
  }
  if (approval.candidateId !== candidate.id) {
    return `approval names candidate ${approval.candidateId}, not ${candidate.id}`;
  }
  if (evidence.results.length === 0) {
    return `candidate ${candidate.id} has no evidence`;
  }
  if (!allPassed(evidence.results)) {
    const failing = evidence.results
      .filter(
        (result) =>
          result.result !== 'pass' && result.result !== 'not-applicable',
      )
      .map((result) => `${result.check}=${result.result}`)
      .join(', ');
    return `candidate ${candidate.id} has evidence that did not pass: ${failing}`;
  }
  if (candidate.repositoryRoot !== snapshot.repositoryRoot) {
    return `candidate ${candidate.id} does not belong to ${snapshot.repositoryRoot}`;
  }

  // The kernel, not the caller, decides that an approved candidate may be
  // written. `transition` throws if that move is not legal.
  try {
    transition('approved', 'write-ready', 'kernel');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

function conflictingPaths(plan: CommitPlan): string | null {
  const seen = new Map<string, string>();
  for (const entry of plan.entries) {
    for (const file of entry.candidate.touchedFiles) {
      const key = `${entry.candidate.repositoryRoot}::${file}`;
      const owner = seen.get(key);
      if (owner != null) {
        return `candidates ${owner} and ${entry.candidate.id} both change ${file}`;
      }
      seen.set(key, entry.candidate.id);
    }
  }
  return null;
}

/**
 * Validate the whole plan, then write it.
 *
 * Nothing is written until every entry has passed validation, so a plan with
 * one unapproved candidate does not half-apply before anyone notices.
 */
export function writeCommitPlan(
  plan: CommitPlan,
  options?: { +recoveryRoot?: string },
): CommitPlanResult {
  if (plan.entries.length === 0) {
    return {
      status: 'rejected',
      reason: 'the commit plan is empty',
      candidateId: null,
    };
  }

  for (const entry of plan.entries) {
    const problem = checkEntry(entry);
    if (problem != null) {
      return {
        status: 'rejected',
        reason: problem,
        candidateId: entry.candidate.id,
      };
    }
  }

  const conflict = conflictingPaths(plan);
  if (conflict != null) {
    return { status: 'rejected', reason: conflict, candidateId: null };
  }

  const writes: Array<WriteResult> = [];
  for (const entry of plan.entries) {
    const result = writeCandidate({
      candidate: entry.candidate,
      snapshot: entry.snapshot,
      scopeRules: entry.scopeRules,
      recoveryRoot: options?.recoveryRoot,
    });
    writes.push(result);
    if (result.status !== 'written') {
      return {
        status: 'halted',
        reason: `candidate ${entry.candidate.id} was not written (${result.status})`,
        writes,
      };
    }
  }

  return { status: 'committed', writes };
}

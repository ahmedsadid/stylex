/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { writeCandidate } from '../candidate/write';
import { validateCandidatePatch } from '../candidate/patch';
import { hashFields } from './hash';
import { snapshotHash } from './snapshot';
import type { CandidatePatch } from '../candidate/patch';
import type { EvidenceResult } from './evidence';
import type { ScopeRules } from '../candidate/scope';
import type { WorkspaceSnapshot } from './snapshot';
import type { WriteResult } from '../candidate/write';

/**
 * The apply plan: the only route from a candidate to the user's files.
 *
 * The state machine on its own is advisory — a caller could hold a candidate,
 * skip every transition, and write. That is the same shape of mistake as the
 * previous generation of this tool, whose verification gates lived beside the
 * write path rather than in it. So the writer is internal, and reaching it
 * requires presenting the things that make a write defensible:
 *
 *   - an immutable candidate,
 *   - an evidence bundle addressed to that candidate's hash,
 *   - the exact mechanical policy's mandatory checks,
 *   - and, for policies that require it, an approval naming the evidence and
 *     limitations it accepted.
 *
 * Every one of those is re-checked here rather than trusted, and the candidate
 * is re-validated for staleness inside the write itself.
 */

export type EvidenceBundle = {
  +id: string,
  +candidateId: string,
  +snapshotId: string,
  +policyId: string,
  +results: $ReadOnlyArray<EvidenceResult>,
  +limitations: $ReadOnlyArray<string>,
  +limitationsHash: string,
};

export type Approval = {
  +candidateId: string,
  +evidenceBundleId: string,
  +policyId: string,
  +limitationsHash: string,
  +approvedBy: string,
  +approvedAt: string,
  // What the approver was told was not covered.
  +limitations: $ReadOnlyArray<string>,
};

export type ApplyPlanEntry = {
  +candidate: CandidatePatch,
  +snapshot: WorkspaceSnapshot,
  +evidence: EvidenceBundle,
  // Mechanical policy is auto-eligible after all mandatory evidence passes.
  // Supplying an approval is optional, but when present it must address this
  // exact evidence bundle and limitation set.
  +approval?: Approval,
  +scopeRules: ScopeRules,
};

export type ApplyPlan = {
  +entries: $ReadOnlyArray<ApplyPlanEntry>,
};

export type ApplyPlanResult =
  | { +status: 'applied', +writes: $ReadOnlyArray<WriteResult> }
  | { +status: 'rejected', +reason: string, +candidateId: string | null }
  | {
      +status: 'halted',
      +reason: string,
      +writes: $ReadOnlyArray<WriteResult>,
    };

export const MECHANICAL_POLICY_ID: string = 'mechanical-static-v8';
const LEGACY_MECHANICAL_POLICY_ID: string = 'mechanical-static-v1';
const CONDITIONAL_MECHANICAL_POLICY_ID: string = 'mechanical-static-v2';
const PSEUDO_ELEMENT_MECHANICAL_POLICY_ID: string = 'mechanical-static-v3';
const MEDIA_QUERY_MECHANICAL_POLICY_ID: string = 'mechanical-static-v4';
const SUPPORTS_NESTING_MECHANICAL_POLICY_ID: string = 'mechanical-static-v5';
const KEYFRAMES_MECHANICAL_POLICY_ID: string = 'mechanical-static-v6';
const SHORTHAND_MECHANICAL_POLICY_ID: string = 'mechanical-static-v7';
export const MECHANICAL_COMPARISON_MODEL: string = 'static-css-v3';
export const MECHANICAL_COMPARISON_MODELS: $ReadOnlyArray<string> =
  Object.freeze([
    MECHANICAL_COMPARISON_MODEL,
    'cascade-referee-v1',
    'pseudo-element-referee-v1',
    'media-query-referee-v1',
    'supports-nesting-referee-v1',
    'keyframes-referee-v1',
    'box-shorthand-referee-v1',
    'directional-referee-v1',
  ]);

export function isMechanicalComparisonModel(model: mixed): boolean {
  return (
    typeof model === 'string' && MECHANICAL_COMPARISON_MODELS.includes(model)
  );
}

function policyAcceptsComparisonModel(policyId: string, model: mixed): boolean {
  if (policyId === LEGACY_MECHANICAL_POLICY_ID) {
    return model === MECHANICAL_COMPARISON_MODEL;
  }
  if (policyId === CONDITIONAL_MECHANICAL_POLICY_ID) {
    return (
      model === MECHANICAL_COMPARISON_MODEL || model === 'cascade-referee-v1'
    );
  }
  if (policyId === PSEUDO_ELEMENT_MECHANICAL_POLICY_ID) {
    return (
      model === MECHANICAL_COMPARISON_MODEL ||
      model === 'cascade-referee-v1' ||
      model === 'pseudo-element-referee-v1'
    );
  }
  if (policyId === MEDIA_QUERY_MECHANICAL_POLICY_ID) {
    return (
      isMechanicalComparisonModel(model) &&
      model !== 'supports-nesting-referee-v1'
    );
  }
  if (policyId === SUPPORTS_NESTING_MECHANICAL_POLICY_ID) {
    return (
      isMechanicalComparisonModel(model) && model !== 'keyframes-referee-v1'
    );
  }
  if (policyId === KEYFRAMES_MECHANICAL_POLICY_ID) {
    return (
      isMechanicalComparisonModel(model) && model !== 'box-shorthand-referee-v1'
    );
  }
  if (policyId === SHORTHAND_MECHANICAL_POLICY_ID) {
    return (
      isMechanicalComparisonModel(model) && model !== 'directional-referee-v1'
    );
  }
  return (
    policyId === MECHANICAL_POLICY_ID && isMechanicalComparisonModel(model)
  );
}

const REQUIRED_MECHANICAL_CHECKS: $ReadOnlyArray<{
  +check: string,
  +provider: string,
}> = [
  { check: 'stylex-plugin-transform', provider: '@stylexjs/babel-plugin' },
  { check: 'stylex-lint', provider: '@stylexjs/eslint-plugin' },
  { check: 'binding-integrity', provider: 'stylex-migrate' },
  { check: 'static-css-comparison', provider: 'stylex-migrate' },
];

function uniqueLimitations(
  results: $ReadOnlyArray<EvidenceResult>,
): $ReadOnlyArray<string> {
  return [...new Set(results.flatMap((result) => result.limitations))].sort();
}

function evidenceBundleId({
  candidateId,
  snapshotId,
  policyId,
  results,
  limitationsHash,
}: {
  +candidateId: string,
  +snapshotId: string,
  +policyId: string,
  +results: $ReadOnlyArray<EvidenceResult>,
  +limitationsHash: string,
}): string {
  const resultIds = results.map((result) =>
    hashFields([
      result.check,
      result.provider,
      result.providerVersion,
      result.subject.file,
      result.subject.sourceHash ?? 'absent',
      result.subject.targetHash ?? 'absent',
      result.subject.model ?? '',
      result.result,
      result.detail ?? '',
      hashFields(result.scope),
      hashFields(result.limitations),
    ]),
  );
  return hashFields([
    candidateId,
    snapshotId,
    policyId,
    limitationsHash,
    ...resultIds,
  ]);
}

export function approve({
  candidate,
  evidence,
  approvedBy,
  now = () => new Date().toISOString(),
}: {
  +candidate: CandidatePatch,
  +evidence: EvidenceBundle,
  +approvedBy: string,
  +now?: () => string,
}): Approval {
  return Object.freeze({
    candidateId: candidate.id,
    evidenceBundleId: evidence.id,
    policyId: evidence.policyId,
    limitationsHash: evidence.limitationsHash,
    approvedBy,
    approvedAt: now(),
    limitations: evidence.limitations,
  });
}

export function bundleEvidence(
  candidate: CandidatePatch,
  snapshot: WorkspaceSnapshot,
  results: $ReadOnlyArray<EvidenceResult>,
): EvidenceBundle {
  const snapshotId = snapshotHash(snapshot);
  const limitations = Object.freeze(uniqueLimitations(results));
  const limitationsHash = hashFields(limitations);
  const fields = {
    candidateId: candidate.id,
    snapshotId,
    policyId: MECHANICAL_POLICY_ID,
    results,
    limitationsHash,
  };
  return Object.freeze({
    id: evidenceBundleId(fields),
    candidateId: candidate.id,
    snapshotId,
    policyId: MECHANICAL_POLICY_ID,
    results: Object.freeze([...results]),
    limitations,
    limitationsHash,
  });
}

function validateEvidenceBundle(
  candidate: CandidatePatch,
  snapshot: WorkspaceSnapshot,
  evidence: EvidenceBundle,
): string | null {
  if (evidence.candidateId !== candidate.id) {
    return `evidence belongs to candidate ${evidence.candidateId}, not ${candidate.id}`;
  }
  const expectedSnapshotId = snapshotHash(snapshot);
  if (evidence.snapshotId !== expectedSnapshotId) {
    return `evidence for candidate ${candidate.id} belongs to a different snapshot`;
  }
  if (
    evidence.policyId !== MECHANICAL_POLICY_ID &&
    evidence.policyId !== PSEUDO_ELEMENT_MECHANICAL_POLICY_ID &&
    evidence.policyId !== CONDITIONAL_MECHANICAL_POLICY_ID &&
    evidence.policyId !== LEGACY_MECHANICAL_POLICY_ID
  ) {
    return `candidate ${candidate.id} uses unsupported evidence policy ${evidence.policyId}`;
  }
  if (evidence.results.length === 0) {
    return `candidate ${candidate.id} has no evidence`;
  }

  const limitations = uniqueLimitations(evidence.results);
  const limitationsHash = hashFields(limitations);
  if (
    evidence.limitationsHash !== limitationsHash ||
    evidence.limitations.length !== limitations.length ||
    evidence.limitations.some((item, index) => item !== limitations[index])
  ) {
    return `candidate ${candidate.id} has an invalid evidence limitation set`;
  }
  const expectedBundleId = evidenceBundleId({
    candidateId: evidence.candidateId,
    snapshotId: evidence.snapshotId,
    policyId: evidence.policyId,
    results: evidence.results,
    limitationsHash: evidence.limitationsHash,
  });
  if (evidence.id !== expectedBundleId) {
    return `candidate ${candidate.id} has a tampered evidence bundle`;
  }

  const changes = new Map(
    candidate.changes.map((change) => [change.path, change]),
  );
  for (const result of evidence.results) {
    const change = changes.get(result.subject.file);
    if (change == null) {
      return `evidence check ${result.check} names ${result.subject.file}, which candidate ${candidate.id} does not change`;
    }
    const sourceHash = snapshot.fileHashes[result.subject.file] ?? null;
    if (result.subject.sourceHash !== sourceHash) {
      return `evidence check ${result.check} has the wrong source hash for ${result.subject.file}`;
    }
    if (result.subject.targetHash !== change.contentHash) {
      return `evidence check ${result.check} has the wrong target hash for ${result.subject.file}`;
    }
    if (result.providerVersion === '' || result.providerVersion === 'unknown') {
      return `evidence check ${result.check} has no reproducible provider version`;
    }
    if (result.result !== 'pass') {
      return `candidate ${candidate.id} has evidence that did not pass: ${result.check}=${result.result}`;
    }
    if (
      result.check === 'static-css-comparison' &&
      !policyAcceptsComparisonModel(evidence.policyId, result.subject.model)
    ) {
      return (
        `static CSS evidence for ${result.subject.file} must use one of ` +
        MECHANICAL_COMPARISON_MODELS.join(', ')
      );
    }
  }

  for (const change of candidate.changes) {
    if (change.status === 'deleted') {
      return `mechanical policy does not permit deleting ${change.path}`;
    }
    const checksForFile = new Set(
      evidence.results
        .filter((result) => result.subject.file === change.path)
        .map((result) => `${result.check}\0${result.provider}`),
    );
    for (const required of REQUIRED_MECHANICAL_CHECKS) {
      if (!checksForFile.has(`${required.check}\0${required.provider}`)) {
        return `candidate ${candidate.id} is missing required check ${required.check} from ${required.provider} for ${change.path}`;
      }
    }
  }
  return null;
}

function checkEntry(entry: ApplyPlanEntry): string | null {
  const { candidate, snapshot, evidence, approval } = entry;

  const candidateProblem = validateCandidatePatch(candidate, snapshot);
  if (candidateProblem != null) {
    return `candidate ${candidate.id} is invalid: ${candidateProblem}`;
  }

  const evidenceProblem = validateEvidenceBundle(candidate, snapshot, evidence);
  if (evidenceProblem != null) {
    return evidenceProblem;
  }
  if (candidate.proposer.kind !== 'deterministic' && approval == null) {
    return `candidate ${candidate.id} was proposed by ${candidate.proposer.kind} and requires approval`;
  }
  if (approval != null) {
    if (approval.candidateId !== candidate.id) {
      return `approval names candidate ${approval.candidateId}, not ${candidate.id}`;
    }
    if (
      approval.evidenceBundleId !== evidence.id ||
      approval.policyId !== evidence.policyId ||
      approval.limitationsHash !== evidence.limitationsHash
    ) {
      return `approval for candidate ${candidate.id} does not cover its evidence, policy, and limitations`;
    }
  }
  if (candidate.repositoryRoot !== snapshot.repositoryRoot) {
    return `candidate ${candidate.id} does not belong to ${snapshot.repositoryRoot}`;
  }

  return null;
}

function conflictingPaths(plan: ApplyPlan): string | null {
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
export function applyPlan(
  plan: ApplyPlan,
  options?: { +recoveryRoot?: string },
): ApplyPlanResult {
  if (plan.entries.length === 0) {
    return {
      status: 'rejected',
      reason: 'the apply plan is empty',
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

  return { status: 'applied', writes };
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { hashString, shortHash } from '../kernel/hash';
import { canonicalJson } from '../state/json';
import { readRecord, writeRecord } from '../state/project';
import {
  isMechanicalComparisonModel,
  MECHANICAL_COMPARISON_MODELS,
} from '../kernel/applyPlan';
import { validateCandidatePatch } from '../candidate/patch';
import { validateRepositoryEvidenceBundle } from './bundle';
import {
  createApplyPlanEvidenceSubject,
  createCandidateEvidenceSubject,
} from './subject';
import type { Claim } from '../kernel/evidence';
import type { Classification } from '../inventory/model';
import type { VerificationCandidate } from './candidates';
import type { RepositoryEvidenceBundle } from './bundle';
import type { JsonValue } from '../state/json';
import type { ProjectState } from '../state/project';

export type VerdictOutcome =
  | 'rejected'
  | 'blocked'
  | 'eligible-for-review'
  | 'auto-eligible';

export type ClaimRecord = {
  +claim: Claim,
  +scope: $ReadOnlyArray<string>,
  +detail: string,
};

export type RepositoryEvidenceVerdict = {
  +id: string,
  +subjectId: string,
  +candidateIds: $ReadOnlyArray<string>,
  +decisionArtifactHashes?: $ReadOnlyArray<string>,
  +evidenceBundleId: string,
  +policyId: string,
  +classification: Classification,
  +outcome: VerdictOutcome,
  +claims: $ReadOnlyArray<ClaimRecord>,
  +limitations: $ReadOnlyArray<string>,
  +missingRequirements: $ReadOnlyArray<string>,
  +createdAt: string,
};

const REQUIRED_STATIC_CHECKS: $ReadOnlyArray<{
  +check: string,
  +provider: string,
}> = [
  { check: 'stylex-plugin-transform', provider: '@stylexjs/babel-plugin' },
  { check: 'stylex-lint', provider: '@stylexjs/eslint-plugin' },
  { check: 'binding-integrity', provider: 'stylex-migrate' },
  { check: 'static-css-comparison', provider: 'stylex-migrate' },
];
const CLASSIFICATION_RANK: { +[Classification]: number } = {
  mechanical: 0,
  'repeatable-contextual': 1,
  'bespoke-contextual': 2,
  'owner-decision': 3,
};

function isMissing(error: mixed): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function object(value: mixed): boolean {
  return value != null && !Array.isArray(value) && typeof value === 'object';
}

function strongest(
  candidates: $ReadOnlyArray<VerificationCandidate>,
): Classification {
  let result: Classification = 'mechanical';
  for (const candidate of candidates) {
    if (
      CLASSIFICATION_RANK[candidate.classification] >
      CLASSIFICATION_RANK[result]
    ) {
      result = candidate.classification;
    }
  }
  return result;
}

function staticRequirements(
  candidates: $ReadOnlyArray<VerificationCandidate>,
): { +failed: $ReadOnlyArray<string>, +missing: $ReadOnlyArray<string> } {
  const failed = new Set<string>();
  const missing = new Set<string>();
  for (const record of candidates) {
    const { candidate, snapshot, staticEvidence } = record;
    const changes = new Map(
      candidate.changes.map((change) => [change.path, change]),
    );
    for (const result of staticEvidence) {
      const change = changes.get(result.subject.file);
      if (change == null) {
        failed.add(
          `static evidence ${result.check} names unmodified path ${result.subject.file}`,
        );
        continue;
      }
      if (
        result.subject.sourceHash !==
          (snapshot.fileHashes[result.subject.file] ?? null) ||
        result.subject.targetHash !== change.contentHash
      ) {
        failed.add(
          `static evidence ${result.check} has stale hashes for ${result.subject.file}`,
        );
      }
      if (
        result.providerVersion === '' ||
        result.providerVersion === 'unknown'
      ) {
        failed.add(
          `static evidence ${result.check} has no provider version for ${result.subject.file}`,
        );
      }
      if (result.result === 'fail') {
        failed.add(
          `static evidence failed: ${result.check} for ${result.subject.file}`,
        );
      }
    }
    for (const change of candidate.changes) {
      if (change.status === 'deleted') {
        failed.add(`mechanical policy does not permit deleting ${change.path}`);
        continue;
      }
      const passing = new Set(
        staticEvidence
          .filter(
            (result) =>
              result.subject.file === change.path && result.result === 'pass',
          )
          .map((result) => `${result.check}\0${result.provider}`),
      );
      for (const required of REQUIRED_STATIC_CHECKS) {
        if (!passing.has(`${required.check}\0${required.provider}`)) {
          missing.add(
            `${change.path} requires ${required.check} from ${required.provider}`,
          );
        }
      }
      const comparisons = staticEvidence.filter(
        (result) =>
          result.subject.file === change.path &&
          result.check === 'static-css-comparison' &&
          result.provider === 'stylex-migrate' &&
          result.result === 'pass',
      );
      for (const comparison of comparisons) {
        if (!isMechanicalComparisonModel(comparison.subject.model)) {
          failed.add(
            `${change.path} static comparison used ${comparison.subject.model ?? 'no model'}`,
          );
        }
        if (
          comparison.subject.model === 'render-local-css-v1' &&
          !passing.has('render-local-call-integrity\0stylex-migrate')
        ) {
          missing.add(
            `${change.path} requires render-local-call-integrity from stylex-migrate`,
          );
        }
      }
    }
  }
  return Object.freeze({
    failed: Object.freeze([...failed].sort()),
    missing: Object.freeze([...missing].sort()),
  });
}

function verdictIdentity(verdict: {
  +subjectId: string,
  +candidateIds: $ReadOnlyArray<string>,
  +decisionArtifactHashes?: $ReadOnlyArray<string>,
  +evidenceBundleId: string,
  +policyId: string,
  +classification: Classification,
  +outcome: VerdictOutcome,
  +claims: $ReadOnlyArray<ClaimRecord>,
  +limitations: $ReadOnlyArray<string>,
  +missingRequirements: $ReadOnlyArray<string>,
}): string {
  return shortHash(hashString(canonicalJson(verdict as $FlowFixMe)));
}

export function evaluateRepositoryEvidence({
  bundle,
  candidates,
  now = () => new Date().toISOString(),
}: {
  +bundle: RepositoryEvidenceBundle,
  +candidates: $ReadOnlyArray<VerificationCandidate>,
  +now?: () => string,
}): RepositoryEvidenceVerdict {
  validateRepositoryEvidenceBundle(bundle);
  if (candidates.length === 0) {
    throw new Error('A repository evidence verdict requires candidates');
  }
  for (const record of candidates) {
    const invalid = validateCandidatePatch(record.candidate, record.snapshot);
    if (invalid != null) {
      throw new Error(`Invalid candidate ${record.candidate.id}: ${invalid}`);
    }
  }
  const candidateIds = candidates.map((record) => record.candidate.id).sort();
  if (
    candidateIds.length !== bundle.candidateIds.length ||
    candidateIds.some((id, index) => id !== bundle.candidateIds[index])
  ) {
    throw new Error('Verdict candidates do not match the evidence bundle');
  }
  const subjectInputs = candidates.map((record) => ({
    candidate: record.candidate,
    snapshot: record.snapshot,
    siteIdsByFile: record.siteIdsByFile,
  }));
  const expectedSubject =
    subjectInputs.length === 1
      ? createCandidateEvidenceSubject(subjectInputs[0])
      : createApplyPlanEvidenceSubject(subjectInputs);
  const expectedStatic = candidates
    .map((record) => ({
      candidateId: record.candidate.id,
      results: record.staticEvidence,
    }))
    .sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  if (
    canonicalJson(expectedSubject as $FlowFixMe) !==
      canonicalJson(bundle.subject as $FlowFixMe) ||
    canonicalJson(expectedStatic as $FlowFixMe) !==
      canonicalJson(bundle.staticEntries as $FlowFixMe)
  ) {
    throw new Error('Verdict candidates do not match the evidence bundle');
  }
  const classification = strongest(candidates);
  const policyId =
    classification === 'mechanical'
      ? 'mechanical-repository-v10'
      : 'contextual-repository-v2';
  const failures = new Set<string>();
  const missing = new Set<string>();
  const limitations = new Set<string>(bundle.limitations);
  const claims: Array<ClaimRecord> = [];
  const repositoryResults = bundle.repositoryEntries.map(
    (entry) => entry.evidence,
  );
  const providerKinds = new Map(
    bundle.providerConfig.providers.map((provider) => [
      provider.id,
      provider.kind,
    ]),
  );
  const commandResults = repositoryResults.filter(
    (result) => providerKinds.get(result.provider) === 'command',
  );
  for (const result of repositoryResults) {
    if (result.result === 'fail') {
      failures.add(`${result.provider} failed ${result.check}`);
    } else if (
      result.result === 'unavailable' &&
      providerKinds.get(result.provider) === 'command'
    ) {
      missing.add(`${result.provider} was unavailable for ${result.check}`);
    } else if (
      result.result !== 'pass' &&
      providerKinds.get(result.provider) === 'command'
    ) {
      missing.add(`${result.provider} did not run ${result.check}`);
    }
  }
  if (bundle.coverage.status !== 'covered') {
    missing.add('repository check coverage is incomplete');
  }
  if (commandResults.length === 0) {
    missing.add('no repository checks were configured for this subject');
  }
  if (
    commandResults.length > 0 &&
    commandResults.every((result) => result.result === 'pass') &&
    bundle.coverage.status === 'covered'
  ) {
    claims.push(
      Object.freeze({
        claim: 'checks-passed',
        scope: Object.freeze(
          bundle.subject.changes.map((change) => change.path),
        ),
        detail:
          'all configured repository checks applicable to these paths passed',
      }),
    );
  }

  if (bundle.runtimeCoverage.status === 'matched') {
    const caseDescriptions = bundle.runtimeCoverage.entries.map(
      (entry) =>
        `${entry.providerId}/${entry.caseId} ` +
        `theme=${entry.theme} interaction=${entry.interaction} ` +
        `viewport=${entry.viewport.width}x${entry.viewport.height}@${entry.viewport.deviceScaleFactor}`,
    );
    const environments = bundle.runtimeCoverage.environments.map(
      ({ providerId, environment }) =>
        `${providerId}=${environment.renderer}@${environment.rendererVersion} ` +
        `${environment.browser}@${environment.browserVersion} ${environment.platform}`,
    );
    claims.push(
      Object.freeze({
        claim: 'runtime-matched',
        scope: bundle.runtimeCoverage.coveredPaths,
        detail:
          `recorded runtime cases matched: ${caseDescriptions.join('; ')}; ` +
          `environments: ${environments.join('; ')}`,
      }),
    );
    if (
      bundle.runtimeCoverage.uncoveredPaths.length > 0 ||
      bundle.runtimeCoverage.uncoveredSiteIds.length > 0
    ) {
      limitations.add(
        'Runtime evidence did not cover every changed path/site: ' +
          [
            ...bundle.runtimeCoverage.uncoveredPaths,
            ...bundle.runtimeCoverage.uncoveredSiteIds,
          ].join(', '),
      );
    }
  } else {
    limitations.add(
      'WARNING: Runtime behavior was not matched. Repository checks do not establish rendered styles, prop forwarding, refs, interactions, or theme-state behavior.',
    );
  }

  if (classification === 'mechanical') {
    const requirements = staticRequirements(candidates);
    requirements.failed.forEach((item) => failures.add(item));
    requirements.missing.forEach((item) => missing.add(item));
    if (requirements.failed.length === 0 && requirements.missing.length === 0) {
      claims.push(
        Object.freeze({
          claim: 'static-css-matched',
          scope: Object.freeze(
            bundle.subject.changes.map((change) => change.path),
          ),
          detail:
            'all changed files passed an approved mechanical comparison ' +
            `model (${MECHANICAL_COMPARISON_MODELS.join(', ')}) and the mechanical check set`,
        }),
      );
    }
  }

  if (
    classification === 'owner-decision' &&
    candidates.some(
      (record) => record.candidate.decisionArtifactHashes.length === 0,
    )
  ) {
    missing.add('owner-decision work requires an approved decision artifact');
  }

  let outcome: VerdictOutcome;
  if (failures.size > 0) {
    outcome = 'rejected';
  } else if (missing.size > 0) {
    outcome = 'blocked';
  } else if (
    classification === 'mechanical' &&
    candidates.every(
      (record) => record.candidate.proposer.kind === 'deterministic',
    )
  ) {
    outcome = 'auto-eligible';
  } else {
    outcome = 'eligible-for-review';
  }
  if (failures.size > 0) {
    failures.forEach((item) => missing.add(item));
  }
  const stable = {
    subjectId: bundle.subject.id,
    candidateIds: bundle.candidateIds,
    ...(bundle.subject.decisionArtifactHashes == null
      ? {}
      : {
          decisionArtifactHashes: bundle.subject.decisionArtifactHashes,
        }),
    evidenceBundleId: bundle.id,
    policyId,
    classification,
    outcome,
    claims: Object.freeze(claims),
    limitations: Object.freeze([...limitations].sort()),
    missingRequirements: Object.freeze([...missing].sort()),
  };
  return Object.freeze({
    id: verdictIdentity(stable),
    ...stable,
    createdAt: now(),
  });
}

function parseVerdict(
  value: mixed,
  expectedId: string,
): RepositoryEvidenceVerdict {
  const verdict: $FlowFixMe = value;
  if (
    !object(verdict) ||
    verdict.kind !== 'repository-evidence-verdict' ||
    typeof verdict.id !== 'string' ||
    typeof verdict.subjectId !== 'string' ||
    !Array.isArray(verdict.candidateIds) ||
    !(
      verdict.decisionArtifactHashes == null ||
      (Array.isArray(verdict.decisionArtifactHashes) &&
        verdict.decisionArtifactHashes.every(
          (value) => typeof value === 'string',
        ))
    ) ||
    typeof verdict.evidenceBundleId !== 'string' ||
    typeof verdict.policyId !== 'string' ||
    typeof verdict.classification !== 'string' ||
    typeof verdict.outcome !== 'string' ||
    !Array.isArray(verdict.claims) ||
    !Array.isArray(verdict.limitations) ||
    !Array.isArray(verdict.missingRequirements) ||
    typeof verdict.createdAt !== 'string'
  ) {
    throw new Error(`Invalid repository evidence verdict ${expectedId}`);
  }
  const parsed: RepositoryEvidenceVerdict = Object.freeze({
    id: verdict.id,
    subjectId: verdict.subjectId,
    candidateIds: Object.freeze([...verdict.candidateIds]),
    ...(verdict.decisionArtifactHashes == null
      ? {}
      : {
          decisionArtifactHashes: Object.freeze([
            ...verdict.decisionArtifactHashes,
          ]),
        }),
    evidenceBundleId: verdict.evidenceBundleId,
    policyId: verdict.policyId,
    classification: verdict.classification,
    outcome: verdict.outcome,
    claims: Object.freeze([...verdict.claims]),
    limitations: Object.freeze([...verdict.limitations]),
    missingRequirements: Object.freeze([...verdict.missingRequirements]),
    createdAt: verdict.createdAt,
  });
  const id = verdictIdentity({
    subjectId: parsed.subjectId,
    candidateIds: parsed.candidateIds,
    ...(parsed.decisionArtifactHashes == null
      ? {}
      : { decisionArtifactHashes: parsed.decisionArtifactHashes }),
    evidenceBundleId: parsed.evidenceBundleId,
    policyId: parsed.policyId,
    classification: parsed.classification,
    outcome: parsed.outcome,
    claims: parsed.claims,
    limitations: parsed.limitations,
    missingRequirements: parsed.missingRequirements,
  });
  if (parsed.id !== expectedId || id !== expectedId) {
    throw new Error(`Integrity check failed for verdict ${expectedId}`);
  }
  return parsed;
}

export function saveRepositoryEvidenceVerdict(
  project: ProjectState,
  verdict: RepositoryEvidenceVerdict,
  options?: { +now?: () => string },
): void {
  const existing = loadRepositoryEvidenceVerdict(project, verdict.id);
  if (existing == null) {
    writeRecord(
      project,
      'verdicts',
      verdict.id,
      { kind: 'repository-evidence-verdict', ...verdict } as $FlowFixMe,
      { now: options?.now },
    );
  } else {
    const { createdAt: _existingTime, ...existingStable } = existing;
    const { createdAt: _newTime, ...newStable } = verdict;
    if (
      canonicalJson(existingStable as $FlowFixMe) !==
      canonicalJson(newStable as $FlowFixMe)
    ) {
      throw new Error(`Verdict identity collision for ${verdict.id}`);
    }
  }
  writeRecord(
    project,
    'verdicts',
    `latest-${verdict.subjectId}`,
    {
      kind: 'repository-evidence-verdict-pointer',
      subjectId: verdict.subjectId,
      verdictId: verdict.id,
    },
    { now: options?.now },
  );
}

export function loadRepositoryEvidenceVerdict(
  project: ProjectState,
  id: string,
): RepositoryEvidenceVerdict | null {
  let payload: JsonValue;
  try {
    payload = readRecord(project, 'verdicts', id).payload;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  return parseVerdict(payload, id);
}

export function loadLatestRepositoryEvidenceVerdict(
  project: ProjectState,
  subjectId: string,
): RepositoryEvidenceVerdict | null {
  let payload: JsonValue;
  try {
    payload = readRecord(project, 'verdicts', `latest-${subjectId}`).payload;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  const pointer: $FlowFixMe = payload;
  if (
    !object(pointer) ||
    pointer.kind !== 'repository-evidence-verdict-pointer' ||
    pointer.subjectId !== subjectId ||
    typeof pointer.verdictId !== 'string'
  ) {
    throw new Error(`Invalid verdict pointer for ${subjectId}`);
  }
  return loadRepositoryEvidenceVerdict(project, pointer.verdictId);
}

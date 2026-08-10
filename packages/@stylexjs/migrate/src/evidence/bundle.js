/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { hashFields, hashString, shortHash } from '../kernel/hash';
import { canonicalJson } from '../state/json';
import { readArtifact, readRecord, writeRecord } from '../state/project';
import type { EvidenceResult } from '../kernel/evidence';
import type { CoverageSummary } from './coverage';
import type { RepositoryEvidenceResult } from './command';
import type { RepositoryEvidenceSubject } from './subject';
import type { EvidenceScheduleResult } from './scheduler';
import type { VerificationCandidate } from './candidates';
import type { ArtifactReference, ProjectState } from '../state/project';
import type { JsonValue } from '../state/json';

export type BundleRepositoryEntry = {
  +providerId: string,
  +evidence: RepositoryEvidenceResult,
  +outputArtifact: ArtifactReference,
};

export type BundleStaticEntry = {
  +candidateId: string,
  +results: $ReadOnlyArray<EvidenceResult>,
};

export type RepositoryEvidenceBundle = {
  +id: string,
  +subject: RepositoryEvidenceSubject,
  +candidateIds: $ReadOnlyArray<string>,
  +scheduleId: string,
  +providerConfigHash: string,
  +repositoryEntries: $ReadOnlyArray<BundleRepositoryEntry>,
  +staticEntries: $ReadOnlyArray<BundleStaticEntry>,
  +coverage: CoverageSummary,
  +skippedProviderIds: $ReadOnlyArray<string>,
  +limitations: $ReadOnlyArray<string>,
  +createdAt: string,
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

function bundleIdentity(bundle: {
  +subject: RepositoryEvidenceSubject,
  +candidateIds: $ReadOnlyArray<string>,
  +scheduleId: string,
  +providerConfigHash: string,
  +repositoryEntries: $ReadOnlyArray<BundleRepositoryEntry>,
  +staticEntries: $ReadOnlyArray<BundleStaticEntry>,
  +coverage: CoverageSummary,
  +skippedProviderIds: $ReadOnlyArray<string>,
  +limitations: $ReadOnlyArray<string>,
}): string {
  return shortHash(hashString(canonicalJson(bundle as $FlowFixMe)));
}

function limitationsFor(
  candidates: $ReadOnlyArray<VerificationCandidate>,
  schedule: EvidenceScheduleResult,
  coverage: CoverageSummary,
): $ReadOnlyArray<string> {
  const limitations = new Set<string>();
  for (const record of candidates) {
    for (const result of record.staticEvidence) {
      for (const limitation of result.limitations) {
        limitations.add(limitation);
      }
    }
  }
  for (const entry of schedule.entries) {
    for (const limitation of entry.evidence.limitations) {
      limitations.add(limitation);
    }
  }
  for (const entry of coverage.entries) {
    if (entry.status !== 'covered') {
      limitations.add(`${entry.changePath}: ${entry.detail}`);
    }
  }
  if (schedule.skippedProviderIds.length > 0) {
    limitations.add(
      `checks skipped after an earlier failure: ${schedule.skippedProviderIds.join(', ')}`,
    );
  }
  return Object.freeze([...limitations].sort());
}

export function createRepositoryEvidenceBundle({
  subject,
  candidates,
  schedule,
  coverage,
  now = () => new Date().toISOString(),
}: {
  +subject: RepositoryEvidenceSubject,
  +candidates: $ReadOnlyArray<VerificationCandidate>,
  +schedule: EvidenceScheduleResult,
  +coverage: CoverageSummary,
  +now?: () => string,
}): RepositoryEvidenceBundle {
  const candidateIds = candidates.map((record) => record.candidate.id).sort();
  if (
    schedule.schedule.subjectId !== subject.id ||
    candidateIds.length !== subject.candidateIds.length ||
    candidateIds.some((id, index) => id !== subject.candidateIds[index])
  ) {
    throw new Error(
      'Evidence bundle inputs do not name the same candidate set',
    );
  }
  const repositoryEntries = Object.freeze(
    schedule.entries.map((entry) =>
      Object.freeze({
        providerId: entry.providerId,
        evidence: entry.evidence,
        outputArtifact: entry.outputArtifact,
      }),
    ),
  );
  const staticEntries = Object.freeze(
    candidates
      .map((record) =>
        Object.freeze({
          candidateId: record.candidate.id,
          results: record.staticEvidence,
        }),
      )
      .sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
  );
  const limitations = limitationsFor(candidates, schedule, coverage);
  const stable = {
    subject,
    candidateIds: Object.freeze(candidateIds),
    scheduleId: schedule.schedule.id,
    providerConfigHash: schedule.schedule.configHash,
    repositoryEntries,
    staticEntries,
    coverage,
    skippedProviderIds: schedule.skippedProviderIds,
    limitations,
  };
  return Object.freeze({
    id: bundleIdentity(stable),
    ...stable,
    createdAt: now(),
  });
}

function parseBundle(
  value: mixed,
  expectedId: string,
): RepositoryEvidenceBundle {
  const bundle: $FlowFixMe = value;
  if (
    !object(bundle) ||
    bundle.kind !== 'repository-evidence-bundle' ||
    typeof bundle.id !== 'string' ||
    !object(bundle.subject) ||
    !Array.isArray(bundle.candidateIds) ||
    typeof bundle.scheduleId !== 'string' ||
    typeof bundle.providerConfigHash !== 'string' ||
    !Array.isArray(bundle.repositoryEntries) ||
    !Array.isArray(bundle.staticEntries) ||
    !object(bundle.coverage) ||
    !Array.isArray(bundle.skippedProviderIds) ||
    !Array.isArray(bundle.limitations) ||
    typeof bundle.createdAt !== 'string'
  ) {
    throw new Error(`Invalid repository evidence bundle ${expectedId}`);
  }
  const parsed: RepositoryEvidenceBundle = Object.freeze({
    id: bundle.id,
    subject: bundle.subject,
    candidateIds: Object.freeze([...bundle.candidateIds]),
    scheduleId: bundle.scheduleId,
    providerConfigHash: bundle.providerConfigHash,
    repositoryEntries: Object.freeze([...bundle.repositoryEntries]),
    staticEntries: Object.freeze([...bundle.staticEntries]),
    coverage: bundle.coverage,
    skippedProviderIds: Object.freeze([...bundle.skippedProviderIds]),
    limitations: Object.freeze([...bundle.limitations]),
    createdAt: bundle.createdAt,
  });
  const id = bundleIdentity({
    subject: parsed.subject,
    candidateIds: parsed.candidateIds,
    scheduleId: parsed.scheduleId,
    providerConfigHash: parsed.providerConfigHash,
    repositoryEntries: parsed.repositoryEntries,
    staticEntries: parsed.staticEntries,
    coverage: parsed.coverage,
    skippedProviderIds: parsed.skippedProviderIds,
    limitations: parsed.limitations,
  });
  if (parsed.id !== expectedId || id !== expectedId) {
    throw new Error(`Integrity check failed for evidence bundle ${expectedId}`);
  }
  return parsed;
}

export function saveRepositoryEvidenceBundle(
  project: ProjectState,
  bundle: RepositoryEvidenceBundle,
  options?: { +now?: () => string },
): void {
  for (const entry of bundle.repositoryEntries) {
    if (
      entry.evidence.subject.id !== bundle.subject.id ||
      entry.evidence.outputHash !== entry.outputArtifact.hash ||
      entry.evidence.outputSize !== entry.outputArtifact.size
    ) {
      throw new Error(
        `Evidence bundle has an invalid ${entry.providerId} artifact`,
      );
    }
    readArtifact(project, entry.outputArtifact.hash);
  }
  const existing = loadRepositoryEvidenceBundle(project, bundle.id);
  if (existing == null) {
    writeRecord(
      project,
      'evidence',
      `bundle-${bundle.id}`,
      { kind: 'repository-evidence-bundle', ...bundle } as $FlowFixMe,
      { now: options?.now },
    );
  } else {
    const { createdAt: _existingTime, ...existingStable } = existing;
    const { createdAt: _newTime, ...newStable } = bundle;
    if (
      canonicalJson(existingStable as $FlowFixMe) !==
      canonicalJson(newStable as $FlowFixMe)
    ) {
      throw new Error(`Evidence bundle identity collision for ${bundle.id}`);
    }
  }
  writeRecord(
    project,
    'evidence',
    `latest-${bundle.subject.id}`,
    {
      kind: 'repository-evidence-pointer',
      subjectId: bundle.subject.id,
      bundleId: bundle.id,
    },
    { now: options?.now },
  );
}

export function loadRepositoryEvidenceBundle(
  project: ProjectState,
  id: string,
): RepositoryEvidenceBundle | null {
  let payload: JsonValue;
  try {
    payload = readRecord(project, 'evidence', `bundle-${id}`).payload;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  return parseBundle(payload, id);
}

export function loadLatestRepositoryEvidenceBundle(
  project: ProjectState,
  subjectId: string,
): RepositoryEvidenceBundle | null {
  let payload: JsonValue;
  try {
    payload = readRecord(project, 'evidence', `latest-${subjectId}`).payload;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  const pointer: $FlowFixMe = payload;
  if (
    !object(pointer) ||
    pointer.kind !== 'repository-evidence-pointer' ||
    pointer.subjectId !== subjectId ||
    typeof pointer.bundleId !== 'string'
  ) {
    throw new Error(`Invalid evidence pointer for ${subjectId}`);
  }
  return loadRepositoryEvidenceBundle(project, pointer.bundleId);
}

export function evidenceBundleLimitationsHash(
  bundle: RepositoryEvidenceBundle,
): string {
  return hashFields(bundle.limitations);
}

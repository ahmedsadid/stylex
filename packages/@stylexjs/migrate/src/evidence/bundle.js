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
import { validateCandidatePatch } from '../candidate/patch';
import { repositoryEvidenceIdentity } from './command';
import { normalizeEvidenceConfig } from './config';
import { aggregateRepositoryCoverage } from './coverage';
import { aggregateRuntimeCoverage } from '../runtime/coverage';
import { evidenceScheduleIdentity } from './scheduler';
import {
  createApplyPlanEvidenceSubject,
  createCandidateEvidenceSubject,
  repositoryEvidenceSubjectIdentity,
} from './subject';
import type { EvidenceResult } from '../kernel/evidence';
import type { EvidenceConfig } from './config';
import type { CoverageSummary } from './coverage';
import type { RuntimeCoverageSummary } from '../runtime/coverage';
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
  +providerConfig: EvidenceConfig,
  +providerConfigHash: string,
  +repositoryEntries: $ReadOnlyArray<BundleRepositoryEntry>,
  +staticEntries: $ReadOnlyArray<BundleStaticEntry>,
  +coverage: CoverageSummary,
  +runtimeCoverage: RuntimeCoverageSummary,
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
  +providerConfig: EvidenceConfig,
  +providerConfigHash: string,
  +repositoryEntries: $ReadOnlyArray<BundleRepositoryEntry>,
  +staticEntries: $ReadOnlyArray<BundleStaticEntry>,
  +coverage: CoverageSummary,
  +runtimeCoverage: RuntimeCoverageSummary,
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

function assertRepositoryEntries(
  subject: RepositoryEvidenceSubject,
  config: EvidenceConfig,
  entries: $ReadOnlyArray<BundleRepositoryEntry>,
): void {
  const providers = new Map(
    config.providers.map((provider) => [provider.id, provider]),
  );
  const entryIds = new Set<string>();
  for (const entry of entries) {
    const provider = providers.get(entry.providerId);
    if (
      provider == null ||
      provider.subject !== subject.kind ||
      entryIds.has(entry.providerId) ||
      entry.evidence.provider !== provider.id ||
      entry.evidence.check !== provider.check ||
      entry.evidence.checkVersion !== provider.checkVersion ||
      entry.evidence.subject.id !== subject.id ||
      repositoryEvidenceSubjectIdentity(entry.evidence.subject) !==
        subject.id ||
      repositoryEvidenceIdentity(entry.evidence) !== entry.evidence.id
    ) {
      throw new Error(
        `Evidence bundle has invalid repository evidence for ${entry.providerId}`,
      );
    }
    entryIds.add(entry.providerId);
  }
}

export function validateRepositoryEvidenceBundle(
  bundle: RepositoryEvidenceBundle,
): void {
  const normalizedConfig = normalizeEvidenceConfig(bundle.providerConfig);
  const candidateIds = [...bundle.candidateIds].sort();
  const staticIds = bundle.staticEntries
    .map((entry) => entry.candidateId)
    .sort();
  const coverage = aggregateRepositoryCoverage({
    subject: bundle.subject,
    providers: bundle.providerConfig.providers,
    entries: bundle.repositoryEntries,
  });
  const runtimeCoverage = aggregateRuntimeCoverage({
    subject: bundle.subject,
    providers: bundle.providerConfig.providers,
    entries: bundle.repositoryEntries,
  });
  const stable = {
    subject: bundle.subject,
    candidateIds: bundle.candidateIds,
    scheduleId: bundle.scheduleId,
    providerConfig: bundle.providerConfig,
    providerConfigHash: bundle.providerConfigHash,
    repositoryEntries: bundle.repositoryEntries,
    staticEntries: bundle.staticEntries,
    coverage: bundle.coverage,
    runtimeCoverage: bundle.runtimeCoverage,
    skippedProviderIds: bundle.skippedProviderIds,
    limitations: bundle.limitations,
  };
  if (
    repositoryEvidenceSubjectIdentity(bundle.subject) !== bundle.subject.id ||
    canonicalJson(normalizedConfig as $FlowFixMe) !==
      canonicalJson(bundle.providerConfig as $FlowFixMe) ||
    bundle.providerConfigHash !==
      hashString(canonicalJson(bundle.providerConfig as $FlowFixMe)) ||
    candidateIds.length !== bundle.subject.candidateIds.length ||
    candidateIds.some(
      (id, index) => id !== bundle.subject.candidateIds[index],
    ) ||
    staticIds.length !== candidateIds.length ||
    staticIds.some((id, index) => id !== candidateIds[index]) ||
    canonicalJson(coverage as $FlowFixMe) !==
      canonicalJson(bundle.coverage as $FlowFixMe) ||
    canonicalJson(runtimeCoverage as $FlowFixMe) !==
      canonicalJson(bundle.runtimeCoverage as $FlowFixMe) ||
    bundleIdentity(stable) !== bundle.id
  ) {
    throw new Error(`Integrity check failed for evidence bundle ${bundle.id}`);
  }
  assertRepositoryEntries(
    bundle.subject,
    bundle.providerConfig,
    bundle.repositoryEntries,
  );
}

function assertScheduleMatchesConfig(
  subject: RepositoryEvidenceSubject,
  config: EvidenceConfig,
  schedule: EvidenceScheduleResult,
): void {
  const selected = config.providers.filter(
    (provider) => provider.subject === subject.kind,
  );
  const ignored = config.providers
    .filter((provider) => provider.subject !== subject.kind)
    .map((provider) => provider.id)
    .sort();
  const items = new Map(
    schedule.schedule.items.map((item) => [item.providerId, item]),
  );
  const entryIds = schedule.entries.map((entry) => entry.providerId);
  const skippedIds = schedule.skippedProviderIds;
  if (
    schedule.schedule.concurrency !== config.concurrency ||
    items.size !== schedule.schedule.items.length ||
    items.size !== selected.length ||
    selected.some(
      (provider) => items.get(provider.id)?.cost !== provider.cost,
    ) ||
    canonicalJson(ignored as $FlowFixMe) !==
      canonicalJson(schedule.schedule.ignoredProviderIds as $FlowFixMe) ||
    new Set(entryIds).size !== entryIds.length ||
    new Set(skippedIds).size !== skippedIds.length ||
    entryIds.some((id) => !items.has(id) || skippedIds.includes(id)) ||
    skippedIds.some((id) => !items.has(id)) ||
    [...items.keys()].some(
      (id) => !entryIds.includes(id) && !skippedIds.includes(id),
    )
  ) {
    throw new Error(
      'Evidence bundle schedule does not match its configuration',
    );
  }
}

export function createRepositoryEvidenceBundle({
  subject,
  candidates,
  schedule,
  config,
  now = () => new Date().toISOString(),
}: {
  +subject: RepositoryEvidenceSubject,
  +candidates: $ReadOnlyArray<VerificationCandidate>,
  +schedule: EvidenceScheduleResult,
  +config: EvidenceConfig,
  +now?: () => string,
}): RepositoryEvidenceBundle {
  if (candidates.length === 0) {
    throw new Error('An evidence bundle requires at least one candidate');
  }
  for (const record of candidates) {
    const invalid = validateCandidatePatch(record.candidate, record.snapshot);
    if (invalid != null) {
      throw new Error(`Invalid candidate ${record.candidate.id}: ${invalid}`);
    }
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
  if (
    repositoryEvidenceSubjectIdentity(subject) !== subject.id ||
    canonicalJson(expectedSubject as $FlowFixMe) !==
      canonicalJson(subject as $FlowFixMe)
  ) {
    throw new Error('Evidence bundle subject does not match its candidates');
  }
  const providerConfig = normalizeEvidenceConfig(config);
  const providerConfigHash = hashString(
    canonicalJson(providerConfig as $FlowFixMe),
  );
  if (
    schedule.schedule.configHash !== providerConfigHash ||
    evidenceScheduleIdentity(schedule.schedule) !== schedule.schedule.id
  ) {
    throw new Error('Evidence bundle schedule failed its integrity check');
  }
  assertScheduleMatchesConfig(subject, providerConfig, schedule);
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
  const providers = new Map(
    providerConfig.providers.map((provider) => [provider.id, provider]),
  );
  const entryIds = new Set<string>();
  for (const entry of schedule.entries) {
    const provider = providers.get(entry.providerId);
    if (
      provider == null ||
      provider.subject !== subject.kind ||
      entryIds.has(entry.providerId) ||
      entry.evidence.provider !== provider.id ||
      entry.evidence.check !== provider.check ||
      entry.evidence.checkVersion !== provider.checkVersion ||
      entry.evidence.subject.id !== subject.id ||
      repositoryEvidenceSubjectIdentity(entry.evidence.subject) !==
        subject.id ||
      repositoryEvidenceIdentity(entry.evidence) !== entry.evidence.id
    ) {
      throw new Error(
        `Evidence bundle has invalid repository evidence for ${entry.providerId}`,
      );
    }
    entryIds.add(entry.providerId);
  }
  const coverage = aggregateRepositoryCoverage({
    subject,
    providers: providerConfig.providers,
    entries: schedule.entries,
  });
  const repositoryEntries = Object.freeze(
    schedule.entries.map((entry) =>
      Object.freeze({
        providerId: entry.providerId,
        evidence: entry.evidence,
        outputArtifact: entry.outputArtifact,
      }),
    ),
  );
  const runtimeCoverage = aggregateRuntimeCoverage({
    subject,
    providers: providerConfig.providers,
    entries: repositoryEntries,
  });
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
    providerConfig,
    providerConfigHash,
    repositoryEntries,
    staticEntries,
    coverage,
    runtimeCoverage,
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
    !object(bundle.providerConfig) ||
    typeof bundle.providerConfigHash !== 'string' ||
    !Array.isArray(bundle.repositoryEntries) ||
    !Array.isArray(bundle.staticEntries) ||
    !object(bundle.coverage) ||
    !object(bundle.runtimeCoverage) ||
    !Array.isArray(bundle.skippedProviderIds) ||
    !Array.isArray(bundle.limitations) ||
    typeof bundle.createdAt !== 'string'
  ) {
    throw new Error(`Invalid repository evidence bundle ${expectedId}`);
  }
  const providerConfig = normalizeEvidenceConfig(bundle.providerConfig);
  const parsed: RepositoryEvidenceBundle = Object.freeze({
    id: bundle.id,
    subject: bundle.subject,
    candidateIds: Object.freeze([...bundle.candidateIds]),
    scheduleId: bundle.scheduleId,
    providerConfig,
    providerConfigHash: bundle.providerConfigHash,
    repositoryEntries: Object.freeze([...bundle.repositoryEntries]),
    staticEntries: Object.freeze([...bundle.staticEntries]),
    coverage: bundle.coverage,
    runtimeCoverage: bundle.runtimeCoverage,
    skippedProviderIds: Object.freeze([...bundle.skippedProviderIds]),
    limitations: Object.freeze([...bundle.limitations]),
    createdAt: bundle.createdAt,
  });
  const id = bundleIdentity({
    subject: parsed.subject,
    candidateIds: parsed.candidateIds,
    scheduleId: parsed.scheduleId,
    providerConfig: parsed.providerConfig,
    providerConfigHash: parsed.providerConfigHash,
    repositoryEntries: parsed.repositoryEntries,
    staticEntries: parsed.staticEntries,
    coverage: parsed.coverage,
    runtimeCoverage: parsed.runtimeCoverage,
    skippedProviderIds: parsed.skippedProviderIds,
    limitations: parsed.limitations,
  });
  if (parsed.id !== expectedId || id !== expectedId) {
    throw new Error(`Integrity check failed for evidence bundle ${expectedId}`);
  }
  validateRepositoryEvidenceBundle(parsed);
  return parsed;
}

export function saveRepositoryEvidenceBundle(
  project: ProjectState,
  bundle: RepositoryEvidenceBundle,
  options?: { +now?: () => string },
): void {
  validateRepositoryEvidenceBundle(bundle);
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

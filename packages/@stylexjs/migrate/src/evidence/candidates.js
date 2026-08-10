/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { validateCandidatePatch } from '../candidate/patch';
import { canonicalJson } from '../state/json';
import { readRecord, writeRecord } from '../state/project';
import type { CandidatePatch } from '../candidate/patch';
import type { EvidenceResult } from '../kernel/evidence';
import type { WorkspaceSnapshot } from '../kernel/snapshot';
import type { Classification } from '../inventory/model';
import type { JsonValue } from '../state/json';
import type { ProjectState } from '../state/project';

export type VerificationCandidate = {
  +candidate: CandidatePatch,
  +snapshot: WorkspaceSnapshot,
  +classification: Classification,
  +siteIdsByFile: { +[path: string]: $ReadOnlyArray<string> },
  +staticEvidence: $ReadOnlyArray<EvidenceResult>,
};

const CLASSIFICATIONS = new Set([
  'mechanical',
  'repeatable-contextual',
  'bespoke-contextual',
  'owner-decision',
]);

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

function strings(value: mixed): boolean {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function parseCandidate(
  value: mixed,
  project: ProjectState,
  expectedId: string,
): VerificationCandidate {
  const record: $FlowFixMe = value;
  if (
    !object(record) ||
    record.kind !== 'verification-candidate' ||
    !object(record.candidate) ||
    !object(record.snapshot) ||
    !Array.isArray(record.candidate.changes) ||
    !strings(record.candidate.touchedFiles) ||
    !strings(record.candidate.clusterIds) ||
    !strings(record.candidate.decisionArtifactHashes) ||
    !object(record.candidate.proposer) ||
    !object(record.snapshot.fileHashes) ||
    !object(record.snapshot.fileModes) ||
    !CLASSIFICATIONS.has(record.classification) ||
    !object(record.siteIdsByFile) ||
    Object.keys(record.siteIdsByFile).some(
      (file) => !strings(record.siteIdsByFile[file]),
    ) ||
    !Array.isArray(record.staticEvidence)
  ) {
    throw new Error(`Invalid verification candidate record ${expectedId}`);
  }
  const parsed: VerificationCandidate = Object.freeze({
    candidate: record.candidate,
    snapshot: record.snapshot,
    classification: record.classification,
    siteIdsByFile: Object.freeze(
      Object.fromEntries(
        Object.keys(record.siteIdsByFile)
          .sort()
          .map((file) => [
            file,
            Object.freeze([...record.siteIdsByFile[file]]),
          ]),
      ),
    ),
    staticEvidence: Object.freeze([...record.staticEvidence]),
  });
  if (
    parsed.candidate.id !== expectedId ||
    parsed.candidate.repositoryRoot !== project.repositoryRoot ||
    parsed.snapshot.repositoryRoot !== project.repositoryRoot
  ) {
    throw new Error(`Verification candidate ${expectedId} belongs elsewhere`);
  }
  const problem = validateCandidatePatch(parsed.candidate, parsed.snapshot);
  if (problem != null) {
    throw new Error(`Invalid verification candidate ${expectedId}: ${problem}`);
  }
  return parsed;
}

export function saveVerificationCandidate(
  project: ProjectState,
  input: VerificationCandidate,
  options?: { +now?: () => string },
): VerificationCandidate {
  if (
    input.candidate.repositoryRoot !== project.repositoryRoot ||
    input.snapshot.repositoryRoot !== project.repositoryRoot
  ) {
    throw new Error('Cannot persist a candidate from another repository');
  }
  const problem = validateCandidatePatch(input.candidate, input.snapshot);
  if (problem != null) {
    throw new Error(`Cannot persist an invalid candidate: ${problem}`);
  }
  const stable: VerificationCandidate = Object.freeze({
    candidate: input.candidate,
    snapshot: input.snapshot,
    classification: input.classification,
    siteIdsByFile: Object.freeze(
      Object.fromEntries(
        Object.keys(input.siteIdsByFile)
          .sort()
          .map((file) => {
            if (!input.candidate.touchedFiles.includes(file)) {
              throw new Error(`Site coverage names unchanged path ${file}`);
            }
            return [
              file,
              Object.freeze([...new Set(input.siteIdsByFile[file])].sort()),
            ];
          }),
      ),
    ),
    staticEvidence: Object.freeze([...input.staticEvidence]),
  });
  const payload = {
    kind: 'verification-candidate',
    ...stable,
  } as $FlowFixMe;
  try {
    const existing = readRecord(
      project,
      'candidates',
      input.candidate.id,
    ).payload;
    if (canonicalJson(existing) !== canonicalJson(payload)) {
      throw new Error(`Candidate identity collision for ${input.candidate.id}`);
    }
    return parseCandidate(existing, project, input.candidate.id);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  writeRecord(project, 'candidates', input.candidate.id, payload, {
    now: options?.now,
  });
  return stable;
}

export function loadVerificationCandidate(
  project: ProjectState,
  id: string,
): VerificationCandidate | null {
  let payload: JsonValue;
  try {
    payload = readRecord(project, 'candidates', id).payload;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  return parseCandidate(payload, project, id);
}

export function loadVerificationCandidates(
  project: ProjectState,
  ids: $ReadOnlyArray<string>,
): $ReadOnlyArray<VerificationCandidate> {
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error('Verification requires distinct candidate ids');
  }
  return Object.freeze(
    ids.map((id) => {
      const candidate = loadVerificationCandidate(project, id);
      if (candidate == null) {
        throw new Error(`No persisted candidate found for ${id}`);
      }
      return candidate;
    }),
  );
}

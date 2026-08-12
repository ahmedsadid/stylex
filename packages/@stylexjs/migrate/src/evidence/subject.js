/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { hashString, shortHash } from '../kernel/hash';
import { snapshotHash } from '../kernel/snapshot';
import { canonicalJson } from '../state/json';
import type { CandidatePatch } from '../candidate/patch';
import type { WorkspaceSnapshot } from '../kernel/snapshot';

export type EvidenceChange = {
  +path: string,
  +sourceHash: string | null,
  +targetHash: string | null,
  +siteIds: $ReadOnlyArray<string>,
};

export type CandidateEvidenceSubject = {
  +kind: 'candidate',
  +id: string,
  +candidateId: string,
  +candidateIds: $ReadOnlyArray<string>,
  +changes: $ReadOnlyArray<EvidenceChange>,
  +decisionArtifactHashes?: $ReadOnlyArray<string>,
  +assumptionArtifactHashes?: $ReadOnlyArray<string>,
};

export type ApplyPlanEvidenceSubject = {
  +kind: 'apply-plan',
  +id: string,
  +candidateIds: $ReadOnlyArray<string>,
  +changes: $ReadOnlyArray<EvidenceChange>,
  +decisionArtifactHashes?: $ReadOnlyArray<string>,
  +assumptionArtifactHashes?: $ReadOnlyArray<string>,
};

export type RepositoryEvidenceSubject =
  | CandidateEvidenceSubject
  | ApplyPlanEvidenceSubject;

export type CandidateSubjectInput = {
  +candidate: CandidatePatch,
  +snapshot: WorkspaceSnapshot,
  +siteIdsByFile?: { +[path: string]: $ReadOnlyArray<string> },
};

function subjectIdentity(value: mixed): string {
  return shortHash(hashString(canonicalJson(value as $FlowFixMe)));
}

export function repositoryEvidenceSubjectIdentity(
  subject: RepositoryEvidenceSubject,
): string {
  const { id: _id, ...stable } = subject;
  return subjectIdentity(stable);
}

function changesFor({
  candidate,
  snapshot,
  siteIdsByFile = {},
}: CandidateSubjectInput): $ReadOnlyArray<EvidenceChange> {
  if (candidate.baseSnapshotHash !== snapshotHash(snapshot)) {
    throw new Error(
      `candidate ${candidate.id} does not belong to the supplied snapshot`,
    );
  }
  if (
    candidate.repositoryRoot !== snapshot.repositoryRoot ||
    candidate.baseCommit !== snapshot.gitCommit
  ) {
    throw new Error(
      `candidate ${candidate.id} and its snapshot describe different repositories`,
    );
  }
  return Object.freeze(
    candidate.changes.map((change) =>
      Object.freeze({
        path: change.path,
        sourceHash: snapshot.fileHashes[change.path] ?? null,
        targetHash: change.contentHash,
        siteIds: Object.freeze(
          [...new Set(siteIdsByFile[change.path] ?? [])].sort(),
        ),
      }),
    ),
  );
}

export function createCandidateEvidenceSubject(
  input: CandidateSubjectInput,
): CandidateEvidenceSubject {
  const changes = changesFor(input);
  const decisionArtifactHashes = input.candidate.decisionArtifactHashes;
  const assumptionArtifactHashes = input.candidate.assumptionArtifactHashes;
  const stable: $ReadOnly<{
    kind: 'candidate',
    candidateId: string,
    candidateIds: $ReadOnlyArray<string>,
    changes: $ReadOnlyArray<EvidenceChange>,
    decisionArtifactHashes?: $ReadOnlyArray<string>,
    assumptionArtifactHashes?: $ReadOnlyArray<string>,
  }> = {
    kind: 'candidate',
    candidateId: input.candidate.id,
    candidateIds: Object.freeze([input.candidate.id]),
    changes,
    decisionArtifactHashes,
    assumptionArtifactHashes,
  };
  return Object.freeze({
    ...stable,
    id: repositoryEvidenceSubjectIdentity({ id: '', ...stable }),
  });
}

export function createApplyPlanEvidenceSubject(
  inputs: $ReadOnlyArray<CandidateSubjectInput>,
): ApplyPlanEvidenceSubject {
  if (inputs.length === 0) {
    throw new Error('an apply-plan evidence subject requires candidates');
  }
  const candidateIds = inputs.map((input) => input.candidate.id).sort();
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new Error(
      'an apply-plan evidence subject contains a candidate twice',
    );
  }
  const repository = inputs[0].candidate.repositoryRoot;
  const commit = inputs[0].candidate.baseCommit;
  const changes = [];
  const owners = new Map<string, string>();
  const decisionArtifactHashes = new Set<string>();
  const assumptionArtifactHashes = new Set<string>();
  for (const input of inputs) {
    if (
      input.candidate.repositoryRoot !== repository ||
      input.candidate.baseCommit !== commit
    ) {
      throw new Error(
        'apply-plan evidence candidates must share a repository and base commit',
      );
    }
    input.candidate.decisionArtifactHashes.forEach((hash) =>
      decisionArtifactHashes.add(hash),
    );
    input.candidate.assumptionArtifactHashes.forEach((hash) =>
      assumptionArtifactHashes.add(hash),
    );
    for (const change of changesFor(input)) {
      const existing = owners.get(change.path);
      if (existing != null) {
        throw new Error(
          `apply-plan candidates ${existing} and ${input.candidate.id} both change ${change.path}`,
        );
      }
      owners.set(change.path, input.candidate.id);
      changes.push(change);
    }
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  const stable: $ReadOnly<{
    kind: 'apply-plan',
    candidateIds: $ReadOnlyArray<string>,
    changes: $ReadOnlyArray<EvidenceChange>,
    decisionArtifactHashes?: $ReadOnlyArray<string>,
    assumptionArtifactHashes?: $ReadOnlyArray<string>,
  }> = {
    kind: 'apply-plan',
    candidateIds: Object.freeze(candidateIds),
    changes: Object.freeze(changes),
    decisionArtifactHashes: Object.freeze([...decisionArtifactHashes].sort()),
    assumptionArtifactHashes: Object.freeze(
      [...assumptionArtifactHashes].sort(),
    ),
  };
  return Object.freeze({
    ...stable,
    id: repositoryEvidenceSubjectIdentity({ id: '', ...stable }),
  });
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { hashString, shortHash } from '../kernel/hash';
import { canonicalJson, immutableJson } from '../state/json';
import type { Cluster, Fact } from '../inventory/model';

export const CONTEXT_PROTOCOL_VERSION: string = 'stylex-migrate-context-v1';
export const CONTEXT_MAX_ATTEMPTS: number = 2;

export type ContextDeclaredInput = {
  +path: string,
  +contentHash: string | null,
  +mode: string | null,
};

export type ContextScope = {
  +allowedPaths: $ReadOnlyArray<string>,
  +protectedPaths: $ReadOnlyArray<string>,
  +allowedDeletions: $ReadOnlyArray<string>,
  +ownerDecisionPaths: $ReadOnlyArray<string>,
};

export type ContextRequiredCheck = {
  +id: string,
  +check: string,
  +checkVersion: string,
  +subject: 'candidate' | 'apply-plan',
  +limitations: $ReadOnlyArray<string>,
};

export type ContextTaskCapsule = {
  +protocolVersion: string,
  +id: string,
  +definitionHash: string,
  +goal: string,
  +inventoryId: string,
  +planId: string,
  +cluster: Cluster,
  +base: {
    +repositoryRoot: string,
    +commit: string,
    +snapshotHash: string,
    +configHash: string,
  },
  +declaredInputs: $ReadOnlyArray<ContextDeclaredInput>,
  +facts: $ReadOnlyArray<Fact>,
  +scope: ContextScope,
  +decisionArtifactHashes: $ReadOnlyArray<string>,
  +requiredChecks: $ReadOnlyArray<ContextRequiredCheck>,
  +limitations: $ReadOnlyArray<string>,
  +stopConditions: $ReadOnlyArray<string>,
  +maxAttempts: number,
  +createdAt: string,
};

type ContextTaskDefinition = {
  +protocolVersion: string,
  +goal: string,
  +inventoryId: string,
  +planId: string,
  +cluster: Cluster,
  +base: ContextTaskCapsule['base'],
  +declaredInputs: $ReadOnlyArray<ContextDeclaredInput>,
  +facts: $ReadOnlyArray<Fact>,
  +scope: ContextScope,
  +decisionArtifactHashes: $ReadOnlyArray<string>,
  +requiredChecks: $ReadOnlyArray<ContextRequiredCheck>,
  +limitations: $ReadOnlyArray<string>,
  +stopConditions: $ReadOnlyArray<string>,
  +maxAttempts: number,
};

export type ContextFailure = {
  +attemptId: string,
  +outcome: 'rejected' | 'blocked',
  +reasons: $ReadOnlyArray<string>,
  +candidateId: string | null,
  +verdictId: string | null,
};

export type ContextAttemptCapsule = {
  +protocolVersion: string,
  +id: string,
  +capsuleHash: string,
  +taskId: string,
  +taskDefinitionHash: string,
  +attemptNumber: number,
  +workspace: {
    +path: string,
    +baseCommit: string,
    +allowedPaths: $ReadOnlyArray<string>,
  },
  +priorFailures: $ReadOnlyArray<ContextFailure>,
  +previousCandidateId: string | null,
  +openedAt: string,
};

type ContextAttemptDefinition = {
  +protocolVersion: string,
  +id: string,
  +taskId: string,
  +taskDefinitionHash: string,
  +attemptNumber: number,
  +workspace: ContextAttemptCapsule['workspace'],
  +priorFailures: $ReadOnlyArray<ContextFailure>,
  +previousCandidateId: string | null,
  +openedAt: string,
};

function sortedStrings(values: $ReadOnlyArray<string>): $ReadOnlyArray<string> {
  return Object.freeze([...new Set(values)].sort());
}

function taskDefinition(task: ContextTaskDefinition): ContextTaskDefinition {
  return task;
}

export function createContextTaskCapsule({
  goal,
  inventoryId,
  planId,
  cluster,
  repositoryRoot,
  commit,
  snapshotHash,
  configHash,
  declaredInputs,
  facts,
  scope,
  decisionArtifactHashes = [],
  requiredChecks,
  limitations,
  stopConditions,
  now = () => new Date().toISOString(),
}: {
  +goal: string,
  +inventoryId: string,
  +planId: string,
  +cluster: Cluster,
  +repositoryRoot: string,
  +commit: string,
  +snapshotHash: string,
  +configHash: string,
  +declaredInputs: $ReadOnlyArray<ContextDeclaredInput>,
  +facts: $ReadOnlyArray<Fact>,
  +scope: ContextScope,
  +decisionArtifactHashes?: $ReadOnlyArray<string>,
  +requiredChecks: $ReadOnlyArray<ContextRequiredCheck>,
  +limitations: $ReadOnlyArray<string>,
  +stopConditions: $ReadOnlyArray<string>,
  +now?: () => string,
}): ContextTaskCapsule {
  if (goal.trim() === '') {
    throw new Error('A contextual task requires a non-empty goal');
  }
  const stableInputs = [...declaredInputs]
    .map((input) => Object.freeze({ ...input }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const stableFacts = [...facts].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const stableChecks = [...requiredChecks]
    .map((check) =>
      Object.freeze({
        ...check,
        limitations: sortedStrings(check.limitations),
      }),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const definition = taskDefinition({
    protocolVersion: CONTEXT_PROTOCOL_VERSION,
    goal: goal.trim(),
    inventoryId,
    planId,
    cluster,
    base: Object.freeze({ repositoryRoot, commit, snapshotHash, configHash }),
    declaredInputs: Object.freeze(stableInputs),
    facts: Object.freeze(stableFacts),
    scope: Object.freeze({
      allowedPaths: sortedStrings(scope.allowedPaths),
      protectedPaths: sortedStrings(scope.protectedPaths),
      allowedDeletions: sortedStrings(scope.allowedDeletions),
      ownerDecisionPaths: sortedStrings(scope.ownerDecisionPaths),
    }),
    decisionArtifactHashes: sortedStrings(decisionArtifactHashes),
    requiredChecks: Object.freeze(stableChecks),
    limitations: sortedStrings(limitations),
    stopConditions: sortedStrings(stopConditions),
    maxAttempts: CONTEXT_MAX_ATTEMPTS,
  });
  const definitionHash = hashString(canonicalJson(definition));
  return immutableJson({
    ...definition,
    id: `task-${shortHash(definitionHash)}`,
    definitionHash,
    createdAt: now(),
  }) as $FlowFixMe;
}

export function validateContextTaskCapsule(value: mixed): ContextTaskCapsule {
  if (value == null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('Invalid contextual task capsule');
  }
  const task: ContextTaskCapsule = value as any;
  if (
    task.protocolVersion !== CONTEXT_PROTOCOL_VERSION ||
    typeof task.id !== 'string' ||
    typeof task.definitionHash !== 'string' ||
    typeof task.createdAt !== 'string' ||
    task.maxAttempts !== CONTEXT_MAX_ATTEMPTS
  ) {
    throw new Error('Invalid contextual task capsule');
  }
  const { id, definitionHash, createdAt, ...definition } = task;
  const expectedHash = hashString(canonicalJson(definition));
  if (
    definitionHash !== expectedHash ||
    id !== `task-${shortHash(expectedHash)}`
  ) {
    throw new Error('Contextual task capsule integrity check failed');
  }
  return immutableJson({
    ...definition,
    id,
    definitionHash,
    createdAt,
  }) as $FlowFixMe;
}

function attemptDefinition(
  attempt: ContextAttemptDefinition,
): ContextAttemptDefinition {
  return attempt;
}

export function createContextAttemptCapsule({
  task,
  attemptNumber,
  workspacePath,
  priorFailures = [],
  previousCandidateId = null,
  now = () => new Date().toISOString(),
}: {
  +task: ContextTaskCapsule,
  +attemptNumber: number,
  +workspacePath: string,
  +priorFailures?: $ReadOnlyArray<ContextFailure>,
  +previousCandidateId?: string | null,
  +now?: () => string,
}): ContextAttemptCapsule {
  validateContextTaskCapsule(task);
  if (
    !Number.isInteger(attemptNumber) ||
    attemptNumber < 1 ||
    attemptNumber > CONTEXT_MAX_ATTEMPTS ||
    priorFailures.length !== attemptNumber - 1
  ) {
    throw new Error('Invalid contextual attempt number or failure history');
  }
  const id = `${task.id}-attempt-${attemptNumber}`;
  const definition = attemptDefinition({
    protocolVersion: CONTEXT_PROTOCOL_VERSION,
    id,
    taskId: task.id,
    taskDefinitionHash: task.definitionHash,
    attemptNumber,
    workspace: Object.freeze({
      path: workspacePath,
      baseCommit: task.base.commit,
      allowedPaths: task.scope.allowedPaths,
    }),
    priorFailures: Object.freeze(
      priorFailures.map((failure) =>
        Object.freeze({
          ...failure,
          reasons: sortedStrings(failure.reasons),
        }),
      ),
    ),
    previousCandidateId,
    openedAt: now(),
  });
  return immutableJson({
    ...definition,
    capsuleHash: hashString(canonicalJson(definition)),
  }) as $FlowFixMe;
}

export function validateContextAttemptCapsule(
  value: mixed,
): ContextAttemptCapsule {
  if (value == null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('Invalid contextual attempt capsule');
  }
  const attempt: ContextAttemptCapsule = value as any;
  if (
    attempt.protocolVersion !== CONTEXT_PROTOCOL_VERSION ||
    typeof attempt.id !== 'string' ||
    typeof attempt.capsuleHash !== 'string' ||
    typeof attempt.taskId !== 'string' ||
    typeof attempt.attemptNumber !== 'number' ||
    attempt.attemptNumber < 1 ||
    attempt.attemptNumber > CONTEXT_MAX_ATTEMPTS ||
    !Array.isArray(attempt.priorFailures) ||
    attempt.priorFailures.length !== attempt.attemptNumber - 1
  ) {
    throw new Error('Invalid contextual attempt capsule');
  }
  const { capsuleHash, ...definition } = attempt;
  if (capsuleHash !== hashString(canonicalJson(definition))) {
    throw new Error('Contextual attempt capsule integrity check failed');
  }
  return immutableJson({ ...definition, capsuleHash }) as $FlowFixMe;
}

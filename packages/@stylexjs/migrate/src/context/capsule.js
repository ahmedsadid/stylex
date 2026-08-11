/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { hashString, shortHash } from '../kernel/hash';
import { matchesGlob } from '../candidate/scope';
import { canonicalJson, immutableJson } from '../state/json';
import type { Cluster, Fact } from '../inventory/model';

export const CONTEXT_PROTOCOL_VERSION: string = 'stylex-migrate-context-v3';
export const CONTEXT_MAX_ATTEMPTS: number = 2;

export type ContextTaskOrigin =
  | {
      +kind: 'plan-cluster',
      +clusterId: string,
    }
  | {
      +kind: 'theme-bridge',
      +draftId: string,
      +definitionHash: string,
      +targetModule: string,
    }
  | {
      +kind: 'dynamic-strategy',
      +strategyId: string,
      +definitionHash: string,
      +clusterId: string,
    }
  | {
      +kind: 'bootstrap',
      +inspectionId: string,
      +packageRoot: string,
      +packageManager: 'pnpm' | 'yarn' | 'npm',
      +integration: 'rspack' | 'webpack' | 'vite' | 'babel' | 'next-swc',
    };

export type ContextRequiredOutput = {
  +path: string,
  +targetHash: string,
  +role: 'generated-theme-module',
  +mutable: false,
};

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
  +bootstrapPaths?: $ReadOnlyArray<string>,
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
  +origin: ContextTaskOrigin,
  +inventoryId: string,
  +planId: string | null,
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
  +requiredOutputs: $ReadOnlyArray<ContextRequiredOutput>,
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
  +origin: ContextTaskOrigin,
  +inventoryId: string,
  +planId: string | null,
  +cluster: Cluster,
  +base: ContextTaskCapsule['base'],
  +declaredInputs: $ReadOnlyArray<ContextDeclaredInput>,
  +facts: $ReadOnlyArray<Fact>,
  +scope: ContextScope,
  +requiredOutputs: $ReadOnlyArray<ContextRequiredOutput>,
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
  +requiredOutputs: $ReadOnlyArray<ContextRequiredOutput>,
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
  +requiredOutputs: $ReadOnlyArray<ContextRequiredOutput>,
  +priorFailures: $ReadOnlyArray<ContextFailure>,
  +previousCandidateId: string | null,
  +openedAt: string,
};

function sortedStrings(values: $ReadOnlyArray<string>): $ReadOnlyArray<string> {
  return Object.freeze([...new Set(values)].sort());
}

function safeRelativePath(value: string): boolean {
  return (
    value !== '' &&
    !value.includes('\0') &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !value.split('/').some((segment) => segment === '' || segment === '..')
  );
}

function normalizeOrigin(
  origin: ContextTaskOrigin | void,
  cluster: Cluster,
): ContextTaskOrigin {
  if (origin == null) {
    return Object.freeze({ kind: 'plan-cluster', clusterId: cluster.id });
  }
  if (origin.kind === 'plan-cluster') {
    if (origin.clusterId === '' || origin.clusterId !== cluster.id) {
      throw new Error('Context plan-cluster origin must name its work cluster');
    }
    return Object.freeze({ kind: origin.kind, clusterId: origin.clusterId });
  }
  if (origin.kind === 'dynamic-strategy') {
    if (
      origin.strategyId === '' ||
      origin.definitionHash === '' ||
      origin.clusterId !== cluster.id
    ) {
      throw new Error('Invalid dynamic-strategy task origin');
    }
    return Object.freeze({ ...origin });
  }
  if (origin.kind === 'bootstrap') {
    if (
      origin.inspectionId === '' ||
      origin.packageRoot.includes('\0') ||
      origin.packageRoot.startsWith('/') ||
      origin.packageRoot.split('/').includes('..') ||
      !['pnpm', 'yarn', 'npm'].includes(origin.packageManager) ||
      !['rspack', 'webpack', 'vite', 'babel', 'next-swc'].includes(
        origin.integration,
      )
    ) {
      throw new Error('Invalid bootstrap task origin');
    }
    return Object.freeze({ ...origin });
  }
  if (
    origin.kind !== 'theme-bridge' ||
    origin.draftId === '' ||
    origin.definitionHash === '' ||
    origin.targetModule === ''
  ) {
    throw new Error('Invalid contextual task origin');
  }
  return Object.freeze({ ...origin });
}

function normalizeRequiredOutputs(
  outputs: $ReadOnlyArray<ContextRequiredOutput>,
  scope: ContextScope,
): $ReadOnlyArray<ContextRequiredOutput> {
  const seen = new Set<string>();
  const normalized = outputs.map((output) => {
    if (
      output.path === '' ||
      !safeRelativePath(output.path) ||
      output.targetHash === '' ||
      output.role !== 'generated-theme-module' ||
      output.mutable !== false ||
      !scope.allowedPaths.includes(output.path) ||
      scope.protectedPaths.some((pattern) =>
        matchesGlob(output.path, pattern),
      ) ||
      seen.has(output.path)
    ) {
      throw new Error('Invalid contextual required output');
    }
    seen.add(output.path);
    return Object.freeze({ ...output });
  });
  return Object.freeze(normalized.sort((a, b) => a.path.localeCompare(b.path)));
}

function taskDefinition(task: ContextTaskDefinition): ContextTaskDefinition {
  return task;
}

export function createContextTaskCapsule({
  goal,
  origin,
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
  requiredOutputs = [],
  decisionArtifactHashes = [],
  requiredChecks,
  limitations,
  stopConditions,
  now = () => new Date().toISOString(),
}: {
  +goal: string,
  +origin?: ContextTaskOrigin,
  +inventoryId: string,
  +planId: string | null,
  +cluster: Cluster,
  +repositoryRoot: string,
  +commit: string,
  +snapshotHash: string,
  +configHash: string,
  +declaredInputs: $ReadOnlyArray<ContextDeclaredInput>,
  +facts: $ReadOnlyArray<Fact>,
  +scope: ContextScope,
  +requiredOutputs?: $ReadOnlyArray<ContextRequiredOutput>,
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
  const stableScope = Object.freeze({
    allowedPaths: sortedStrings(scope.allowedPaths),
    protectedPaths: sortedStrings(scope.protectedPaths),
    allowedDeletions: sortedStrings(scope.allowedDeletions),
    ownerDecisionPaths: sortedStrings(scope.ownerDecisionPaths),
    bootstrapPaths: sortedStrings(scope.bootstrapPaths ?? []),
  });
  const stableOrigin = normalizeOrigin(origin, cluster);
  if (stableOrigin.kind === 'bootstrap') {
    if (
      stableScope.bootstrapPaths.length === 0 ||
      stableScope.bootstrapPaths.some(
        (file) =>
          !safeRelativePath(file) ||
          file.includes('*') ||
          file.includes('?') ||
          !stableScope.allowedPaths.includes(file) ||
          stableScope.protectedPaths.some((pattern) =>
            matchesGlob(pattern, file),
          ),
      )
    ) {
      throw new Error('Bootstrap tasks require exact allowed bootstrap paths');
    }
  } else if (stableScope.bootstrapPaths.length > 0) {
    throw new Error('Only bootstrap tasks may authorize bootstrap paths');
  }
  const definition = taskDefinition({
    protocolVersion: CONTEXT_PROTOCOL_VERSION,
    goal: goal.trim(),
    origin: stableOrigin,
    inventoryId,
    planId,
    cluster,
    base: Object.freeze({ repositoryRoot, commit, snapshotHash, configHash }),
    declaredInputs: Object.freeze(stableInputs),
    facts: Object.freeze(stableFacts),
    scope: stableScope,
    requiredOutputs: normalizeRequiredOutputs(requiredOutputs, stableScope),
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
    task.origin == null ||
    typeof task.origin !== 'object' ||
    !Array.isArray(task.requiredOutputs) ||
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
    requiredOutputs: task.requiredOutputs,
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
    !Array.isArray(attempt.requiredOutputs) ||
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

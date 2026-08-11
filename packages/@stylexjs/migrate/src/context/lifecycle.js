/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { changedPaths, createCandidatePatch } from '../candidate/patch';
import { validateScope } from '../candidate/scope';
import {
  createCandidateWorkspace,
  removeCandidateWorkspace,
} from '../candidate/workspace';
import {
  createSnapshot,
  detectStaleFiles,
  snapshotHash,
} from '../kernel/snapshot';
import { hashString } from '../kernel/hash';
import {
  loadVerificationCandidate,
  saveVerificationCandidate,
} from '../evidence/candidates';
import { createVerificationWorkspace } from '../evidence/workspace';
import { loadCurrentInventory, loadCurrentPlan } from '../planning/reports';
import { appendStateEvent, replayEvents } from '../state/events';
import { canonicalJson } from '../state/json';
import { readConfig, readRecord, writeRecord } from '../state/project';
import {
  CONTEXT_MAX_ATTEMPTS,
  CONTEXT_PROTOCOL_VERSION,
  createContextAttemptCapsule,
  createContextTaskCapsule,
  validateContextAttemptCapsule,
  validateContextTaskCapsule,
} from './capsule';
import type { Proposer, ProposerKind } from '../candidate/patch';
import type { CandidatePatch } from '../candidate/patch';
import type { CandidateWorkspace } from '../candidate/workspace';
import type { WorkspaceSnapshot } from '../kernel/snapshot';
import type { Cluster, Inventory } from '../inventory/model';
import type { IndexEntry } from '../state/events';
import type { JsonValue } from '../state/json';
import type { ProjectState } from '../state/project';
import type { RepositoryEvidenceVerdict } from '../evidence/verdict';
import type {
  ContextAttemptCapsule,
  ContextFailure,
  ContextTaskCapsule,
} from './capsule';

export type ContextTaskState =
  | 'open'
  | 'awaiting-verification'
  | 'eligible-for-review'
  | 'needs-replan'
  | 'needs-owner-decision'
  | 'blocked'
  | 'abandoned';

export type ContextOpenResult =
  | {
      +ok: true,
      +state: 'open',
      +task: ContextTaskCapsule,
      +attempt: ContextAttemptCapsule,
    }
  | {
      +ok: false,
      +state: 'blocked' | 'needs-owner-decision',
      +reasons: $ReadOnlyArray<string>,
    };

type ContextFailureResult = {
  +ok: false,
  +state: 'needs-replan' | 'needs-owner-decision' | 'blocked',
  +reasons: $ReadOnlyArray<string>,
  +taskId: string,
  +attemptId: string,
};

export type ContextSubmitResult =
  | {
      +ok: true,
      +state: 'awaiting-verification',
      +candidateId: string,
      +taskId: string,
      +attemptId: string,
    }
  | ContextFailureResult;

export type ContextInspection = {
  +task: ContextTaskCapsule,
  +attempt: ContextAttemptCapsule | null,
  +state: ContextTaskState,
  +stateData: JsonValue,
};

export type ContextVerificationUpdate = {
  +taskId: string,
  +attemptId: string,
  +candidateId: string,
  +verdictId: string,
  +state:
    | 'eligible-for-review'
    | 'needs-replan'
    | 'needs-owner-decision'
    | 'blocked',
};

type TaskRecord = {
  +task: ContextTaskCapsule,
  +snapshot: WorkspaceSnapshot,
};

function isMissing(error: mixed): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function writeImmutable(
  project: ProjectState,
  collection: 'tasks' | 'attempts',
  id: string,
  payload: JsonValue,
  now?: () => string,
): void {
  try {
    const existing = readRecord(project, collection, id).payload;
    if (canonicalJson(existing) !== canonicalJson(payload)) {
      throw new Error(`Content identity collision for contextual ${id}`);
    }
    return;
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  writeRecord(project, collection, id, payload, { now });
}

function saveTaskRecord(
  project: ProjectState,
  task: ContextTaskCapsule,
  snapshot: WorkspaceSnapshot,
  now?: () => string,
): void {
  writeImmutable(
    project,
    'tasks',
    task.id,
    { kind: 'context-task', task, snapshot } as $FlowFixMe,
    now,
  );
}

function loadTaskRecord(project: ProjectState, taskId: string): TaskRecord {
  const value = readRecord(project, 'tasks', taskId).payload;
  if (value == null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`Invalid contextual task record ${taskId}`);
  }
  const payload: {
    +kind: string,
    +task: mixed,
    +snapshot: mixed,
  } = value as any;
  if (
    payload.kind !== 'context-task' ||
    payload.snapshot == null ||
    typeof payload.snapshot !== 'object'
  ) {
    throw new Error(`Invalid contextual task record ${taskId}`);
  }
  const task = validateContextTaskCapsule(payload.task);
  const snapshot: WorkspaceSnapshot = payload.snapshot as any;
  if (
    task.id !== taskId ||
    snapshot.repositoryRoot !== project.repositoryRoot ||
    task.base.repositoryRoot !== project.repositoryRoot ||
    task.base.snapshotHash !== snapshotHash(snapshot) ||
    task.base.commit !== snapshot.gitCommit ||
    task.base.configHash !== snapshot.configHash
  ) {
    throw new Error(`Contextual task ${taskId} does not match its snapshot`);
  }
  return Object.freeze({ task, snapshot });
}

function saveAttempt(
  project: ProjectState,
  attempt: ContextAttemptCapsule,
  now?: () => string,
): void {
  writeImmutable(
    project,
    'attempts',
    attempt.id,
    { kind: 'context-attempt', attempt } as $FlowFixMe,
    now,
  );
}

function loadAttempt(
  project: ProjectState,
  attemptId: string,
): ContextAttemptCapsule {
  const value = readRecord(project, 'attempts', attemptId).payload;
  if (value == null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`Invalid contextual attempt record ${attemptId}`);
  }
  const payload: { +kind: string, +attempt: mixed } = value as any;
  if (payload.kind !== 'context-attempt') {
    throw new Error(`Invalid contextual attempt record ${attemptId}`);
  }
  const attempt = validateContextAttemptCapsule(payload.attempt);
  if (attempt.id !== attemptId) {
    throw new Error(`Contextual attempt record ${attemptId} has another id`);
  }
  return attempt;
}

function taskIndex(project: ProjectState, taskId: string): IndexEntry | null {
  return replayEvents(project).indexes.tasks[taskId] ?? null;
}

function currentAttemptId(entry: IndexEntry): string {
  const data: $FlowFixMe = entry.data;
  if (typeof data.attemptId !== 'string') {
    throw new Error(`Contextual task ${entry.id} has no current attempt`);
  }
  return data.attemptId;
}

function contextualCluster(
  inventory: Inventory,
  cluster: Cluster,
): ContextOpenResult | null {
  if (
    cluster.state === 'blocked' ||
    cluster.classification === 'owner-decision'
  ) {
    return {
      ok: false,
      state: 'needs-owner-decision',
      reasons: Object.freeze(
        cluster.blockedReasons.length > 0
          ? [...cluster.blockedReasons]
          : ['The plan routes this cluster to an owner decision.'],
      ),
    };
  }
  if (cluster.classification === 'mechanical') {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([
        'This cluster is mechanical; use the deterministic proposal lane.',
      ]),
    };
  }
  const knownSites = new Set(inventory.sites.map((site) => site.id));
  if (cluster.siteIds.some((id) => !knownSites.has(id))) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([
        'The plan refers to sites missing from inventory.',
      ]),
    };
  }
  return null;
}

function workspaceForAttempt(
  task: ContextTaskCapsule,
  workspacePath: string,
): CandidateWorkspace {
  return Object.freeze({
    path: workspacePath,
    repositoryRoot: task.base.repositoryRoot,
    baseCommit: task.base.commit,
    allowedPaths: task.scope.allowedPaths,
  });
}

function persistOpenAttempt({
  project,
  task,
  attempt,
  now,
}: {
  +project: ProjectState,
  +task: ContextTaskCapsule,
  +attempt: ContextAttemptCapsule,
  +now?: () => string,
}): ContextOpenResult {
  saveAttempt(project, attempt, now);
  appendStateEvent({
    project,
    entityKind: 'task',
    entityId: task.id,
    state: 'open',
    data: { attemptId: attempt.id, attemptNumber: attempt.attemptNumber },
    now,
  });
  appendStateEvent({
    project,
    entityKind: 'attempt',
    entityId: attempt.id,
    state: 'open',
    data: { taskId: task.id, attemptNumber: attempt.attemptNumber },
    now,
  });
  return Object.freeze({ ok: true, state: 'open', task, attempt });
}

export function openContextTask({
  project,
  clusterId,
  goal,
  workspaceRoot,
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +clusterId: string,
  +goal: string,
  +workspaceRoot?: string,
  +now?: () => string,
}): ContextOpenResult {
  const inventory = loadCurrentInventory(project);
  const plan = loadCurrentPlan(project);
  if (inventory == null || plan == null || plan.inventoryId !== inventory.id) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze(['Run scan and plan before opening a task.']),
    };
  }
  const cluster = plan.clusters.find((item) => item.id === clusterId);
  if (cluster == null) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([
        `No current cluster exists with id ${clusterId}.`,
      ]),
    };
  }
  const routed = contextualCluster(inventory, cluster);
  if (routed != null) {
    return routed;
  }

  const config = readConfig(project);
  const configHash = hashString(canonicalJson(config as $FlowFixMe));
  const taskInputFiles = [
    ...new Set([...cluster.declaredInputs, ...inventory.configInputs]),
  ].sort();
  const snapshot = createSnapshot({
    repositoryRoot: project.repositoryRoot,
    files: taskInputFiles,
    configHash,
  });
  const stale = detectStaleFiles(snapshot);
  if (stale.length > 0) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze(
        stale.map(
          (file) =>
            `${file} differs from HEAD and is a declared task input; commit or stash it first.`,
        ),
      ),
    };
  }
  const factsById = new Map(inventory.facts.map((fact) => [fact.id, fact]));
  const taskFactIds = new Set(cluster.factIds);
  for (const fact of inventory.facts) {
    if (fact.inputFiles.some((file) => inventory.configInputs.includes(file))) {
      taskFactIds.add(fact.id);
    }
  }
  const facts = [...taskFactIds].map((id) => {
    const fact = factsById.get(id);
    if (fact == null) {
      throw new Error(`Cluster ${cluster.id} refers to missing fact ${id}`);
    }
    return fact;
  });
  const allowed = [...cluster.changeFiles].sort();
  const protectedPaths = [
    '.stylex-migrate/**',
    ...taskInputFiles.filter((file) => !allowed.includes(file)),
  ];
  const task = createContextTaskCapsule({
    goal,
    inventoryId: inventory.id,
    planId: plan.id,
    cluster,
    repositoryRoot: project.repositoryRoot,
    commit: snapshot.gitCommit,
    snapshotHash: snapshotHash(snapshot),
    configHash,
    declaredInputs: Object.keys(snapshot.fileHashes).map((file) => ({
      path: file,
      contentHash: snapshot.fileHashes[file],
      mode: snapshot.fileModes[file],
    })),
    facts,
    scope: {
      allowedPaths: allowed,
      protectedPaths,
      allowedDeletions: [],
      ownerDecisionPaths: [],
    },
    requiredChecks: config.evidence.providers.map((provider) => ({
      id: provider.id,
      check: provider.check,
      checkVersion: provider.checkVersion,
      subject: provider.subject,
      limitations: provider.limitations,
    })),
    limitations: [
      'M7 does not compare runtime rendering or interaction behavior.',
      ...(config.evidence.providers.length === 0
        ? [
            'No repository evidence providers are configured; verification will block.',
          ]
        : []),
    ],
    stopConditions: [
      'Do not treat an unknown or resolution-failed fact as false.',
      'Stop when the migration requires a change outside allowedPaths.',
      'Stop when public behavior or ownership intent cannot be determined.',
      'Do not edit project configuration, lockfiles, or the migration ledger.',
    ],
    now,
  });
  if (taskIndex(project, task.id) != null) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([
        `Contextual task ${task.id} already exists; inspect its current state.`,
      ]),
    };
  }
  const workspace = createCandidateWorkspace({
    repositoryRoot: project.repositoryRoot,
    allowedPaths: task.scope.allowedPaths,
    baseCommit: snapshot.gitCommit,
    requireClean: false,
    rootDir: workspaceRoot,
  });
  try {
    saveTaskRecord(project, task, snapshot, now);
    const attempt = createContextAttemptCapsule({
      task,
      attemptNumber: 1,
      workspacePath: workspace.path,
      now,
    });
    return persistOpenAttempt({ project, task, attempt, now });
  } catch (error) {
    removeCandidateWorkspace(workspace);
    throw error;
  }
}

function failureFrom(value: mixed): ContextFailure {
  if (value == null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('Invalid contextual failure history');
  }
  const failure: {
    +attemptId: mixed,
    +outcome: mixed,
    +reasons: mixed,
    +candidateId: mixed,
    +verdictId: mixed,
  } = value as any;
  if (
    typeof failure.attemptId !== 'string' ||
    (failure.outcome !== 'rejected' && failure.outcome !== 'blocked') ||
    !Array.isArray(failure.reasons) ||
    (failure.candidateId !== null && typeof failure.candidateId !== 'string') ||
    (failure.verdictId !== null && typeof failure.verdictId !== 'string')
  ) {
    throw new Error('Invalid contextual failure history');
  }
  const reasons: Array<string> = [];
  for (const reason of failure.reasons) {
    if (typeof reason !== 'string') {
      throw new Error('Invalid contextual failure history');
    }
    reasons.push(reason);
  }
  return Object.freeze({
    attemptId: failure.attemptId,
    outcome: failure.outcome,
    reasons: Object.freeze(reasons),
    candidateId: failure.candidateId,
    verdictId: failure.verdictId,
  }) as any;
}

export function openContextRetry({
  project,
  taskId,
  workspaceRoot,
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +taskId: string,
  +workspaceRoot?: string,
  +now?: () => string,
}): ContextOpenResult {
  const record = loadTaskRecord(project, taskId);
  const entry = taskIndex(project, taskId);
  if (entry == null || entry.state !== 'needs-replan') {
    return {
      ok: false,
      state:
        entry?.state === 'needs-owner-decision'
          ? 'needs-owner-decision'
          : 'blocked',
      reasons: Object.freeze([
        `Task ${taskId} is ${entry?.state ?? 'missing'} and cannot open a retry.`,
      ]),
    };
  }
  const data: $FlowFixMe = entry.data;
  const failure = failureFrom(data.failure);
  const firstAttempt = loadAttempt(project, failure.attemptId);
  if (firstAttempt.attemptNumber >= CONTEXT_MAX_ATTEMPTS) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([
        'The contextual task exhausted its attempt budget.',
      ]),
    };
  }
  let workspace;
  if (failure.candidateId != null) {
    const candidateId = failure.candidateId;
    const candidate = loadVerificationCandidate(project, candidateId);
    if (candidate == null) {
      throw new Error(`Missing prior candidate ${candidateId}`);
    }
    workspace = createVerificationWorkspace({
      records: [candidate],
      rootDir: workspaceRoot,
    });
  } else {
    workspace = createCandidateWorkspace({
      repositoryRoot: project.repositoryRoot,
      allowedPaths: record.task.scope.allowedPaths,
      baseCommit: record.snapshot.gitCommit,
      requireClean: false,
      rootDir: workspaceRoot,
    });
  }
  try {
    const attempt = createContextAttemptCapsule({
      task: record.task,
      attemptNumber: firstAttempt.attemptNumber + 1,
      workspacePath: workspace.path,
      priorFailures: [failure],
      previousCandidateId: failure.candidateId,
      now,
    });
    return persistOpenAttempt({
      project,
      task: record.task,
      attempt,
      now,
    });
  } catch (error) {
    removeCandidateWorkspace(workspace);
    throw error;
  }
}

function failAttempt({
  project,
  task,
  attempt,
  outcome,
  reasons,
  candidateId = null,
  verdictId = null,
  firstFailureState = 'needs-replan',
  now,
}: {
  +project: ProjectState,
  +task: ContextTaskCapsule,
  +attempt: ContextAttemptCapsule,
  +outcome: 'rejected' | 'blocked',
  +reasons: $ReadOnlyArray<string>,
  +candidateId?: string | null,
  +verdictId?: string | null,
  +firstFailureState?: 'needs-replan' | 'needs-owner-decision',
  +now?: () => string,
}): ContextFailureResult {
  const failure: ContextFailure = Object.freeze({
    attemptId: attempt.id,
    outcome,
    reasons: Object.freeze([...reasons]),
    candidateId,
    verdictId,
  });
  const state =
    attempt.attemptNumber >= CONTEXT_MAX_ATTEMPTS
      ? 'blocked'
      : firstFailureState;
  appendStateEvent({
    project,
    entityKind: 'attempt',
    entityId: attempt.id,
    state: 'failed',
    data: { taskId: task.id, failure },
    now,
  });
  appendStateEvent({
    project,
    entityKind: 'task',
    entityId: task.id,
    state,
    data: { attemptId: attempt.id, failure },
    now,
  });
  return Object.freeze({
    ok: false,
    state,
    reasons: Object.freeze([...reasons]),
    taskId: task.id,
    attemptId: attempt.id,
  });
}

export function recordContextVerificationOutcome({
  project,
  candidate,
  verdict,
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +candidate: CandidatePatch,
  +verdict: RepositoryEvidenceVerdict,
  +now?: () => string,
}): ContextVerificationUpdate | null {
  const { proposer } = candidate;
  if (
    proposer.protocolVersion !== CONTEXT_PROTOCOL_VERSION ||
    proposer.taskId == null ||
    proposer.attemptId == null
  ) {
    return null;
  }
  const taskId = proposer.taskId;
  const attemptId = proposer.attemptId;
  const record = loadTaskRecord(project, taskId);
  const attempt = loadAttempt(project, attemptId);
  const entry = taskIndex(project, taskId);
  const data: $FlowFixMe = entry?.data;
  if (entry != null && entry.state !== 'awaiting-verification') {
    if (
      entry.state === 'eligible-for-review' &&
      data.candidateId === candidate.id &&
      data.verdictId === verdict.id
    ) {
      return Object.freeze({
        taskId,
        attemptId,
        candidateId: candidate.id,
        verdictId: verdict.id,
        state: 'eligible-for-review',
      });
    }
    const failure: $FlowFixMe = data.failure;
    if (
      (entry.state === 'needs-replan' ||
        entry.state === 'needs-owner-decision' ||
        entry.state === 'blocked') &&
      failure?.candidateId === candidate.id &&
      failure?.verdictId === verdict.id
    ) {
      return Object.freeze({
        taskId,
        attemptId,
        candidateId: candidate.id,
        verdictId: verdict.id,
        state: entry.state as any,
      });
    }
    // A retry or later owner action superseded this candidate. Re-verifying
    // its bytes remains useful evidence, but must not move the active task.
    return null;
  }
  if (
    entry == null ||
    data.candidateId !== candidate.id ||
    data.attemptId !== attemptId ||
    attempt.taskId !== taskId ||
    !verdict.candidateIds.includes(candidate.id)
  ) {
    throw new Error(
      `Verdict ${verdict.id} does not match the active contextual attempt`,
    );
  }
  if (
    verdict.outcome === 'eligible-for-review' ||
    verdict.outcome === 'auto-eligible'
  ) {
    appendStateEvent({
      project,
      entityKind: 'attempt',
      entityId: attemptId,
      state: 'verified',
      data: { taskId, candidateId: candidate.id, verdictId: verdict.id },
      now,
    });
    appendStateEvent({
      project,
      entityKind: 'task',
      entityId: taskId,
      state: 'eligible-for-review',
      data: { attemptId, candidateId: candidate.id, verdictId: verdict.id },
      now,
    });
    return Object.freeze({
      taskId,
      attemptId,
      candidateId: candidate.id,
      verdictId: verdict.id,
      state: 'eligible-for-review',
    });
  }
  const reasons =
    verdict.missingRequirements.length > 0
      ? verdict.missingRequirements
      : [`Repository evidence verdict was ${verdict.outcome}.`];
  const failed = failAttempt({
    project,
    task: record.task,
    attempt,
    outcome: verdict.outcome,
    reasons,
    candidateId: candidate.id,
    verdictId: verdict.id,
    firstFailureState:
      verdict.outcome === 'blocked' ? 'needs-owner-decision' : 'needs-replan',
    now,
  });
  return Object.freeze({
    taskId,
    attemptId,
    candidateId: candidate.id,
    verdictId: verdict.id,
    state: failed.state,
  });
}

export function submitContextAttempt({
  project,
  taskId,
  proposerKind,
  proposerVersion,
  proposerName,
  skillVersion,
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +taskId: string,
  +proposerKind: ProposerKind,
  +proposerVersion: string,
  +proposerName?: string,
  +skillVersion?: string,
  +now?: () => string,
}): ContextSubmitResult {
  if (proposerKind !== 'agent' && proposerKind !== 'human') {
    throw new Error('Contextual attempts require an agent or human proposer');
  }
  const record = loadTaskRecord(project, taskId);
  const entry = taskIndex(project, taskId);
  if (entry == null || entry.state !== 'open') {
    throw new Error(`Contextual task ${taskId} is not open`);
  }
  const attempt = loadAttempt(project, currentAttemptId(entry));
  const workspace = workspaceForAttempt(record.task, attempt.workspace.path);
  const proposer: Proposer = {
    kind: proposerKind,
    version: proposerVersion,
    name: proposerName ?? proposerKind,
    ...(skillVersion == null ? {} : { skillVersion }),
    protocolVersion: CONTEXT_PROTOCOL_VERSION,
    taskId: record.task.id,
    attemptId: attempt.id,
  };
  const result = createCandidatePatch({
    workspace,
    snapshot: record.snapshot,
    clusterIds: [record.task.cluster.id],
    proposer,
    decisionArtifactHashes: record.task.decisionArtifactHashes,
  });
  if (!result.ok || result.candidate.changes.length === 0) {
    const reasons = result.ok
      ? ['The contextual attempt produced no changes.']
      : [result.reason, ...result.paths];
    removeCandidateWorkspace(workspace);
    return failAttempt({
      project,
      task: record.task,
      attempt,
      outcome: 'rejected',
      reasons,
      now,
    });
  }
  const scope = validateScope(changedPaths(result.candidate), {
    allowedPaths: record.task.scope.allowedPaths,
    declaredDeletions: record.task.scope.allowedDeletions,
    forbiddenPaths: record.task.scope.protectedPaths,
    ownerDecisionPaths: record.task.scope.ownerDecisionPaths,
  });
  if (!scope.ok) {
    const reasons = scope.violations.map(
      (violation) => `${violation.path}: ${violation.reason}`,
    );
    removeCandidateWorkspace(workspace);
    return failAttempt({
      project,
      task: record.task,
      attempt,
      outcome: 'rejected',
      reasons,
      now,
    });
  }
  const inventory = loadCurrentInventory(project);
  if (inventory == null || inventory.id !== record.task.inventoryId) {
    throw new Error('The task inventory is no longer current');
  }
  const clusterSites = new Set(record.task.cluster.siteIds);
  const siteIdsByFile = Object.fromEntries(
    result.candidate.touchedFiles.map((file) => [
      file,
      inventory.sites
        .filter((site) => site.file === file && clusterSites.has(site.id))
        .map((site) => site.id),
    ]),
  );
  saveVerificationCandidate(
    project,
    {
      candidate: result.candidate,
      snapshot: result.snapshot,
      classification: record.task.cluster.classification,
      siteIdsByFile,
      staticEvidence: [],
    },
    { now },
  );
  appendStateEvent({
    project,
    entityKind: 'candidate',
    entityId: result.candidate.id,
    state: 'frozen',
    data: { taskId, attemptId: attempt.id },
    now,
  });
  appendStateEvent({
    project,
    entityKind: 'attempt',
    entityId: attempt.id,
    state: 'submitted',
    data: { taskId, candidateId: result.candidate.id },
    now,
  });
  appendStateEvent({
    project,
    entityKind: 'task',
    entityId: taskId,
    state: 'awaiting-verification',
    data: { attemptId: attempt.id, candidateId: result.candidate.id },
    now,
  });
  removeCandidateWorkspace(workspace);
  return Object.freeze({
    ok: true,
    state: 'awaiting-verification',
    candidateId: result.candidate.id,
    taskId,
    attemptId: attempt.id,
  });
}

export function abandonContextTask({
  project,
  taskId,
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +taskId: string,
  +now?: () => string,
}): ContextInspection {
  const record = loadTaskRecord(project, taskId);
  const entry = taskIndex(project, taskId);
  if (entry == null || entry.state !== 'open') {
    throw new Error(`Contextual task ${taskId} is not open`);
  }
  const attempt = loadAttempt(project, currentAttemptId(entry));
  removeCandidateWorkspace(
    workspaceForAttempt(record.task, attempt.workspace.path),
  );
  appendStateEvent({
    project,
    entityKind: 'attempt',
    entityId: attempt.id,
    state: 'abandoned',
    data: { taskId },
    now,
  });
  appendStateEvent({
    project,
    entityKind: 'task',
    entityId: taskId,
    state: 'abandoned',
    data: { attemptId: attempt.id },
    now,
  });
  return inspectContextTask(project, taskId);
}

export function inspectContextTask(
  project: ProjectState,
  taskId: string,
): ContextInspection {
  const record = loadTaskRecord(project, taskId);
  const entry = taskIndex(project, taskId);
  if (entry == null) {
    throw new Error(`No state exists for contextual task ${taskId}`);
  }
  const data: $FlowFixMe = entry.data;
  const attempt =
    typeof data.attemptId === 'string'
      ? loadAttempt(project, data.attemptId)
      : null;
  return Object.freeze({
    task: record.task,
    attempt,
    state: entry.state as any,
    stateData: entry.data,
  });
}

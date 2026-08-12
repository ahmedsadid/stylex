/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { createContextTaskCapsule } from '../context/capsule';
import { openContextTaskFromSpec } from '../context/lifecycle';
import { hashBytes, hashString, shortHash } from '../kernel/hash';
import {
  createSnapshot,
  detectStaleFiles,
  snapshotHash,
} from '../kernel/snapshot';
import { loadCurrentInventory, loadCurrentPlan } from '../planning/reports';
import { canonicalJson } from '../state/json';
import { readConfig } from '../state/project';
import {
  assertCurrentTestAssumption,
  loadTestAssumption,
} from '../assumption/records';
import { inspectRuntimeSurfaces } from './discover';
import { emitGeneratedRuntimeCollector } from './collector';
import {
  EVIDENCE_SURFACE_PROTOCOL_VERSION,
  normalizeEvidenceSurfaceDefinition,
} from './evidenceSurfaceModel';
import type { ContextOpenResult } from '../context/lifecycle';
import type { Cluster } from '../inventory/model';
import type { ProjectState } from '../state/project';

export const EVIDENCE_SURFACE_TASK_VERSION: string =
  'stylex-migrate-evidence-surface-task-v1';
const COLLECTOR_PATH = '.stylex-migrate-probes/runtime-collector.cjs';
const CONFIG_PATH = '.stylex-migrate-probes/runtime-probe.json';

export function openEvidenceSurfaceTask({
  project,
  assumptionId,
  input,
  goal,
  workspaceRoot,
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +assumptionId: string,
  +input: mixed,
  +goal: string,
  +workspaceRoot?: string,
  +now?: () => string,
}): ContextOpenResult {
  const inventory = loadCurrentInventory(project);
  if (inventory == null) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([
        'Run stylex-migrate scan before opening an evidence-surface task.',
      ]),
    };
  }
  const assumption = loadTestAssumption(project, assumptionId);
  if (assumption == null) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([`No test assumption found for ${assumptionId}.`]),
    };
  }
  assertCurrentTestAssumption(project, assumption);
  const definition = normalizeEvidenceSurfaceDefinition(input);
  const definitionCaseIds = definition.cases.map((item) => item.id);
  if (
    definitionCaseIds.some((caseId) => !assumption.scope.cases.includes(caseId))
  ) {
    throw new Error('Evidence-surface cases exceed the bound test assumption');
  }
  const casePaths = [
    ...new Set(definition.cases.flatMap((item) => item.changePaths)),
  ].sort();
  if (casePaths.some((file) => !assumption.scope.files.includes(file))) {
    throw new Error(
      'Evidence-surface changed paths exceed the bound test assumption',
    );
  }
  const discovered = inspectRuntimeSurfaces({
    repositoryRoot: project.repositoryRoot,
  });
  const knownSurfaces = discovered.surfaces
    .filter((surface) => surface.status === 'known')
    .map((surface) => surface.kind);
  if (
    knownSurfaces.length > 0 &&
    definition.nativeSurfaceDisposition !== 'known-insufficient'
  ) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([
        `Known repository-native runtime surfaces exist (${knownSurfaces.join(', ')}); explicitly classify them as known-insufficient with rationale before generating a fallback.`,
      ]),
    };
  }
  const config = readConfig(project);
  const configHash = hashString(canonicalJson(config as $FlowFixMe));
  const declaredInputs = [
    ...new Set([
      ...assumption.declaredInputs.map((item) => item.path),
      ...discovered.inputFiles,
    ]),
  ].sort();
  const snapshot = createSnapshot({
    repositoryRoot: project.repositoryRoot,
    files: declaredInputs,
    configHash,
    assumptionArtifactHashes: [assumption.artifactHash],
  });
  const stale = detectStaleFiles(snapshot);
  if (stale.length > 0) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze(
        stale.map(
          (file) =>
            `${file} differs from HEAD and is a declared evidence-surface input; commit or stash it first.`,
        ),
      ),
    };
  }
  const collectorBytes = Buffer.from(emitGeneratedRuntimeCollector(), 'utf8');
  const configBytes = Buffer.from(
    `${canonicalJson({
      protocolVersion: EVIDENCE_SURFACE_PROTOCOL_VERSION,
      packageRoot: definition.packageRoot,
      playwrightPackage: definition.playwrightPackage,
      nativeSurfaceDisposition: definition.nativeSurfaceDisposition,
      server: definition.server,
      cases: definition.cases,
    } as $FlowFixMe)}\n`,
    'utf8',
  );
  const workId = shortHash(
    hashString(
      canonicalJson({
        definition,
        assumptionArtifactHash: assumption.artifactHash,
      } as $FlowFixMe),
    ),
  );
  const cluster: Cluster = Object.freeze({
    id: `evidence-surface-${workId}`,
    siteIds: Object.freeze([]),
    changeFiles: Object.freeze([COLLECTOR_PATH, CONFIG_PATH]),
    couplingFiles: Object.freeze(declaredInputs),
    declaredInputs: Object.freeze(declaredInputs),
    factIds: Object.freeze([]),
    classification: 'repeatable-contextual',
    routingReasons: Object.freeze([
      'no known repository-native runtime surface was discovered',
    ]),
    state: 'planned',
    blockedReasons: Object.freeze([]),
  });
  const task = createContextTaskCapsule({
    goal,
    origin: {
      kind: 'evidence-surface',
      protocolVersion: EVIDENCE_SURFACE_TASK_VERSION,
      assumptionArtifactHash: assumption.artifactHash,
      runtimeInterface: 'playwright',
      packageRoot: definition.packageRoot,
      collectorPath: COLLECTOR_PATH,
      configPath: CONFIG_PATH,
      expectedObservations: definition.expectedObservations,
      cases: definition.cases.map(
        ({
          path: _path,
          actions: _actions,
          targets: _targets,
          ...runtimeCase
        }) => runtimeCase,
      ),
      limitations: definition.limitations,
    },
    inventoryId: inventory.id,
    planId: loadCurrentPlan(project)?.id ?? null,
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
    facts: [],
    scope: {
      allowedPaths: [COLLECTOR_PATH, CONFIG_PATH],
      protectedPaths: ['.stylex-migrate/**', ...declaredInputs],
      allowedDeletions: [],
      ownerDecisionPaths: [],
      bootstrapPaths: [],
    },
    requiredOutputs: [
      {
        path: COLLECTOR_PATH,
        targetHash: hashBytes(collectorBytes),
        role: 'runtime-probe-collector',
        mutable: false,
      },
      {
        path: CONFIG_PATH,
        targetHash: hashBytes(configBytes),
        role: 'runtime-probe-config',
        mutable: false,
      },
    ],
    assumptionArtifactHashes: [assumption.artifactHash],
    requiredChecks: [],
    limitations: [
      `WARNING: Test assumption ${assumption.id} is not repository intent or human approval.`,
      'The generated probe covers only its exact named cases, selectors, properties, attributes, interactions, and viewport.',
      ...(knownSurfaces.length > 0
        ? [
            `WARNING: Generated fallback was selected despite known repository-native surfaces: ${knownSurfaces.join(', ')}.`,
          ]
        : []),
      ...assumption.limitations,
      ...definition.limitations,
    ],
    stopConditions: [
      'Do not modify either generated probe file.',
      'Do not edit application, configuration, manifest, lockfile, or migration-state files.',
      'Do not describe generated expectations as retained repository behavior or owner approval.',
    ],
    now,
  });
  return openContextTaskFromSpec({
    project,
    task,
    snapshot,
    requiredOutputContents: [
      { path: COLLECTOR_PATH, contents: collectorBytes },
      { path: CONFIG_PATH, contents: configBytes },
    ],
    workspaceRoot,
    now,
  });
}

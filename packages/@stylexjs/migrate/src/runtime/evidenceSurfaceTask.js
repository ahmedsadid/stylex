/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import fs from 'fs';
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
import { loadThemeDecisionDraft } from '../theme/decisions';
import { emitGeneratedRuntimeCollector } from './collector';
import {
  EVIDENCE_SURFACE_PROTOCOL_VERSION,
  normalizeEvidenceSurfaceDefinition,
} from './evidenceSurfaceModel';
import type { ContextOpenResult } from '../context/lifecycle';
import type { Cluster } from '../inventory/model';
import type { ProjectState } from '../state/project';

export const EVIDENCE_SURFACE_TASK_VERSION: string =
  'stylex-migrate-evidence-surface-task-v2';
const COLLECTOR_PATH = '.stylex-migrate-probes/runtime-collector.cjs';
const CONFIG_PATH = '.stylex-migrate-probes/runtime-probe.json';

export type EvidenceSurfaceSupportOutput = {
  +path: string,
  +contents: Buffer,
};

function repositoryServerCommandProblem(
  root: string,
  definition: $FlowFixMe,
  generatedPaths: $ReadOnlySet<string>,
): string | null {
  const command = definition.server.argv;
  const serverRoot = [definition.packageRoot, definition.server.cwd]
    .filter((segment) => segment !== '.')
    .join('/');
  const repositoryPath = (file: string): string =>
    serverRoot === '' ? file : `${serverRoot}/${file}`;
  const manifestPath = repositoryPath('package.json');
  const executable = command[0];
  if (executable === 'node' || executable === process.execPath) {
    if (
      command.length < 2 ||
      command[1].startsWith('-') ||
      (!definition.server.inputFiles.includes(repositoryPath(command[1])) &&
        !generatedPaths.has(repositoryPath(command[1])))
    ) {
      return 'A direct Node evidence server must execute a declared tracked input file; inline evaluation and undeclared scripts are forbidden.';
    }
    return null;
  }
  let scriptName = null;
  if (executable === 'npm' && command[1] === 'run' && command.length === 3) {
    scriptName = command[2];
  } else if (
    (executable === 'yarn' || executable === 'pnpm') &&
    command.length === 3 &&
    command[1] === 'run'
  ) {
    scriptName = command[2];
  } else if (
    executable === 'corepack' &&
    (command[1] === 'yarn' || command[1] === 'pnpm') &&
    command[2] === 'run' &&
    command.length === 4
  ) {
    scriptName = command[3];
  }
  if (scriptName == null) {
    return 'Evidence servers must use an exact npm/yarn/pnpm package script or a declared tracked Node script; arbitrary executables are forbidden.';
  }
  if (!definition.server.inputFiles.includes(manifestPath)) {
    return `Evidence server package script requires declared input ${manifestPath}.`;
  }
  try {
    const manifest = JSON.parse(
      fs.readFileSync(`${root}/${manifestPath}`, 'utf8'),
    );
    if (
      manifest == null ||
      Array.isArray(manifest) ||
      typeof manifest !== 'object' ||
      manifest.scripts == null ||
      Array.isArray(manifest.scripts) ||
      typeof manifest.scripts !== 'object' ||
      typeof manifest.scripts[scriptName] !== 'string' ||
      !/\S/.test(manifest.scripts[scriptName])
    ) {
      return `Evidence server package script ${scriptName} is not present in ${manifestPath}.`;
    }
  } catch (error) {
    return `Evidence server manifest ${manifestPath} could not be read: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  return null;
}

export function openEvidenceSurfaceTask({
  project,
  assumptionId,
  input,
  goal,
  workspaceRoot,
  supportOutputs = [],
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +assumptionId: string,
  +input: mixed,
  +goal: string,
  +workspaceRoot?: string,
  +supportOutputs?: $ReadOnlyArray<EvidenceSurfaceSupportOutput>,
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
  const syntheticSource = definition.syntheticCssExpectations?.source;
  if (syntheticSource != null) {
    const draft = loadThemeDecisionDraft(project, syntheticSource.id);
    if (
      draft == null ||
      draft.definitionHash !== syntheticSource.definitionHash
    ) {
      throw new Error(
        `Synthetic CSS expectation source ${syntheticSource.id} is unavailable or does not match`,
      );
    }
    if (draft.inventoryId !== inventory.id) {
      throw new Error(
        `Synthetic CSS expectation source ${syntheticSource.id} belongs to a stale inventory`,
      );
    }
  }
  const supportPaths = supportOutputs.map((output) => output.path).sort();
  if (
    new Set(supportPaths).size !== supportPaths.length ||
    supportPaths.some(
      (file) =>
        file === COLLECTOR_PATH ||
        file === CONFIG_PATH ||
        file === '' ||
        file.startsWith('/') ||
        file.includes('\\') ||
        file.split('/').some((segment) => segment === '' || segment === '..'),
    )
  ) {
    throw new Error('Invalid generated evidence-surface support output');
  }
  const serverProblem = repositoryServerCommandProblem(
    project.repositoryRoot,
    definition,
    new Set(supportPaths),
  );
  if (serverProblem != null) throw new Error(serverProblem);
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
    packageRoot: definition.packageRoot,
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
  const decisionArtifactHashes =
    syntheticSource == null ? [] : [syntheticSource.definitionHash];
  const declaredInputs = [
    ...new Set([
      ...assumption.declaredInputs.map((item) => item.path),
      ...definition.server.inputFiles,
      ...discovered.inputFiles,
    ]),
  ].sort();
  const snapshot = createSnapshot({
    repositoryRoot: project.repositoryRoot,
    files: declaredInputs,
    configHash,
    decisionArtifactHashes,
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
      syntheticCssExpectations: definition.syntheticCssExpectations,
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
    changeFiles: Object.freeze([COLLECTOR_PATH, CONFIG_PATH, ...supportPaths]),
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
      supportPaths,
      baselineKind:
        definition.expectedObservations == null &&
        definition.syntheticCssExpectations == null
          ? 'retained-repository'
          : 'generated-probe',
      expectedObservations: definition.expectedObservations,
      syntheticCssExpectations: definition.syntheticCssExpectations,
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
      allowedPaths: [COLLECTOR_PATH, CONFIG_PATH, ...supportPaths],
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
      ...supportOutputs.map((output) => ({
        path: output.path,
        targetHash: hashBytes(output.contents),
        role: 'runtime-probe-support' as 'runtime-probe-support',
        mutable: false as false,
      })),
    ],
    decisionArtifactHashes,
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
      ...supportOutputs,
    ],
    workspaceRoot,
    now,
  });
}

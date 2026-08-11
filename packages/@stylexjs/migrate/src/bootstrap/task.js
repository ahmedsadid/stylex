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
import { hashString, shortHash } from '../kernel/hash';
import {
  createSnapshot,
  detectStaleFiles,
  snapshotHash,
} from '../kernel/snapshot';
import { loadCurrentInventory } from '../planning/reports';
import { canonicalJson } from '../state/json';
import { readConfig } from '../state/project';
import { inspectBootstrap } from './discover';
import type { ContextOpenResult } from '../context/lifecycle';
import type { Cluster } from '../inventory/model';
import type { ProjectState } from '../state/project';
import type {
  BootstrapInspection,
  BootstrapPackageInspection,
  BuildIntegrationInspection,
  BuildIntegrationKind,
} from './discover';

export const BOOTSTRAP_TASK_PROTOCOL_VERSION: string =
  'stylex-migrate-bootstrap-task-v1';

function expectedLockfile(manager: 'pnpm' | 'yarn' | 'npm'): string {
  if (manager === 'pnpm') return 'pnpm-lock.yaml';
  if (manager === 'yarn') return 'yarn.lock';
  return 'package-lock.json';
}

function choosePackage(
  inspection: BootstrapInspection,
  requestedRoot: string | null,
): BootstrapPackageInspection | string {
  if (requestedRoot != null) {
    return (
      inspection.packages.find((target) => target.root === requestedRoot) ??
      `No inspected package exists at ${requestedRoot || '<repository-root>'}.`
    );
  }
  if (inspection.packages.length === 1) return inspection.packages[0];
  const nested = inspection.packages.filter((target) => target.root !== '');
  if (nested.length === 1) return nested[0];
  return 'Bootstrap package ownership is ambiguous; select an exact package root.';
}

function chooseIntegration(
  inspection: BootstrapInspection,
  requested: BuildIntegrationKind | null,
): BuildIntegrationInspection | string {
  if (requested != null) {
    return (
      inspection.integrations.find((item) => item.kind === requested) ??
      `No inspected ${requested} integration exists.`
    );
  }
  if (inspection.integrations.length === 1) return inspection.integrations[0];
  return 'Build integration is ambiguous; select an exact integration.';
}

function workUnit({
  inspection,
  changeFiles,
}: {
  +inspection: BootstrapInspection,
  +changeFiles: $ReadOnlyArray<string>,
}): Cluster {
  const id = `bootstrap-work-${shortHash(
    hashString(
      canonicalJson({
        protocolVersion: BOOTSTRAP_TASK_PROTOCOL_VERSION,
        inspectionId: inspection.id,
        changeFiles,
      }),
    ),
  )}`;
  return Object.freeze({
    id,
    siteIds: Object.freeze([]),
    changeFiles: Object.freeze([...changeFiles]),
    couplingFiles: Object.freeze([]),
    declaredInputs: Object.freeze([...inspection.inputFiles]),
    factIds: Object.freeze(inspection.facts.map((fact) => fact.id).sort()),
    classification: 'repeatable-contextual',
    routingReasons: Object.freeze([
      'repository StyleX installation and build integration require a bounded bootstrap candidate',
    ]),
    state: 'planned',
    blockedReasons: Object.freeze([]),
  });
}

export function openBootstrapTask({
  project,
  goal,
  packageRoot = null,
  integration = null,
  workspaceRoot,
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +goal: string,
  +packageRoot?: string | null,
  +integration?: BuildIntegrationKind | null,
  +workspaceRoot?: string,
  +now?: () => string,
}): ContextOpenResult {
  const inventory = loadCurrentInventory(project);
  if (inventory == null) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([
        'Run stylex-migrate scan before opening a bootstrap task.',
      ]),
    };
  }
  const inspection = inspectBootstrap({
    repositoryRoot: project.repositoryRoot,
    sourceFiles: inventory.files.map((file) => file.path),
    now,
  });
  const manager = inspection.packageManager;
  if (
    (manager.status !== 'known' && manager.status !== 'inferred') ||
    manager.name == null
  ) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([
        `Package manager discovery is ${manager.status}; resolve it before bootstrapping StyleX.`,
      ]),
    };
  }
  const packageManager = manager.name;
  const selectedPackage = choosePackage(inspection, packageRoot);
  if (typeof selectedPackage === 'string') {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([selectedPackage]),
    };
  }
  if (selectedPackage.status !== 'known') {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([
        `${selectedPackage.manifestPath} could not be inspected completely.`,
      ]),
    };
  }
  const selectedIntegration = chooseIntegration(inspection, integration);
  if (typeof selectedIntegration === 'string') {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([selectedIntegration]),
    };
  }
  if (selectedIntegration.status === 'resolution-failed') {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([
        `${selectedIntegration.kind} configuration could not be inspected completely.`,
      ]),
    };
  }
  if (selectedIntegration.configFiles.length === 0) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([
        `${selectedIntegration.kind} was observed only in package scripts; no exact configuration file can be authorized.`,
      ]),
    };
  }
  if (
    selectedIntegration.kind !== 'rspack' ||
    selectedIntegration.stylexConfigured
  ) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([
        selectedIntegration.stylexConfigured
          ? `${selectedIntegration.kind} already has observed StyleX wiring.`
          : `${selectedIntegration.kind} bootstrap is not implemented yet.`,
      ]),
    };
  }

  const lockfile = manager.lockfile ?? expectedLockfile(packageManager);
  const changeFiles = [
    ...new Set([
      selectedPackage.manifestPath,
      lockfile,
      ...selectedIntegration.configFiles,
    ]),
  ].sort();
  const declaredInputs = [
    ...new Set([...inspection.inputFiles, ...changeFiles]),
  ].sort();
  const config = readConfig(project);
  const configHash = hashString(canonicalJson(config as $FlowFixMe));
  const snapshot = createSnapshot({
    repositoryRoot: project.repositoryRoot,
    files: declaredInputs,
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
            `${file} differs from HEAD and is a declared bootstrap input; commit or stash it first.`,
        ),
      ),
    };
  }
  const cluster = workUnit({ inspection, changeFiles });
  const task = createContextTaskCapsule({
    goal,
    origin: {
      kind: 'bootstrap',
      inspectionId: inspection.id,
      packageRoot: selectedPackage.root,
      packageManager,
      integration: selectedIntegration.kind,
    },
    inventoryId: inventory.id,
    planId: null,
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
    facts: inspection.facts,
    scope: {
      allowedPaths: changeFiles,
      protectedPaths: ['.stylex-migrate/**'],
      allowedDeletions: [],
      ownerDecisionPaths: [],
      bootstrapPaths: changeFiles,
    },
    requiredChecks: config.evidence.providers.map((provider) => ({
      id: provider.id,
      check: provider.check,
      checkVersion: provider.checkVersion,
      subject: provider.subject,
      limitations: provider.limitations,
    })),
    limitations: [
      'Bootstrap wiring inspection is syntactic; repository compilation and emitted-CSS evidence remain required.',
      ...(manager.status === 'inferred'
        ? ['The package manager was inferred from its lockfile.']
        : []),
      ...(config.evidence.providers.length === 0
        ? [
            'No repository evidence providers are configured; submission can freeze but verification will block.',
          ]
        : []),
    ],
    stopConditions: [
      'Use only the discovered package manager and exact authorized package, lockfile, and build-config paths.',
      'Add only StyleX runtime and build-integration dependencies required by this task.',
      'Do not modify application source, tests, scripts unrelated to StyleX integration, or migration state.',
      'Do not claim success from a build exit code without confirming emitted StyleX CSS.',
    ],
    now,
  });
  return openContextTaskFromSpec({
    project,
    task,
    snapshot,
    workspaceRoot,
    now,
  });
}

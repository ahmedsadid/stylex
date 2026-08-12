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
import { VERSION } from '../version';
import fs from 'fs';
import path from 'path';
import {
  bootstrapRspackProviderId,
  RSPACK_SENTINEL_CHECK_VERSION,
  RSPACK_SENTINEL_LIMITATION,
} from './provider';
import {
  BABEL_SENTINEL_CHECK_VERSION,
  BABEL_SENTINEL_LIMITATION,
  bootstrapBabelProviderId,
} from './babelProvider';
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
  'stylex-migrate-bootstrap-task-v2';

type DependencyIntent = {
  +name: string,
  +spec: string,
  +section: 'dependencies' | 'devDependencies',
};

function dependencyIntents(
  integration: BuildIntegrationKind,
  stylexSpec: string,
  integrationSpec: string,
  unpluginSpec: string,
  integrationSection: 'dependencies' | 'devDependencies' = 'devDependencies',
): $ReadOnlyArray<DependencyIntent> {
  const runtime = Object.freeze({
    name: '@stylexjs/stylex',
    spec: stylexSpec,
    section: 'dependencies',
  });
  if (integration === 'babel') {
    return Object.freeze([
      runtime,
      Object.freeze({
        name: '@stylexjs/babel-plugin',
        spec: integrationSpec,
        section: integrationSection,
      }),
    ]);
  }
  return Object.freeze([
    runtime,
    Object.freeze({
      name: '@stylexjs/unplugin',
      spec: integrationSpec,
      section: 'devDependencies',
    }),
    Object.freeze({
      name: 'unplugin',
      spec: unpluginSpec,
      section: 'devDependencies',
    }),
  ]);
}

function integrationDependencySection(
  repositoryRoot: string,
  manifestPath: string,
): 'dependencies' | 'devDependencies' {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, manifestPath), 'utf8'),
    );
    if (
      manifest?.private === true &&
      manifest.devDependencies == null &&
      manifest.dependencies != null
    ) {
      return 'dependencies';
    }
  } catch (_error) {}
  return 'devDependencies';
}

function installCommands({
  manager,
  packageName,
  packageRoot,
  dependencies,
}: {
  +manager: 'pnpm' | 'yarn' | 'npm',
  +packageName: string | null,
  +packageRoot: string,
  +dependencies: $ReadOnlyArray<DependencyIntent>,
}): $ReadOnlyArray<$ReadOnlyArray<string>> {
  if (packageRoot !== '' && packageName == null) {
    throw new Error('A nested bootstrap package requires a package name');
  }
  const runtime = dependencies.filter(
    (dependency) => dependency.section === 'dependencies',
  );
  const development = dependencies.filter(
    (dependency) => dependency.section === 'devDependencies',
  );
  if (runtime.length === 0) {
    throw new Error('Bootstrap dependency intent is incomplete');
  }
  const runtimeSpecs = runtime.map(
    (dependency) => `${dependency.name}@${dependency.spec}`,
  );
  const developmentSpecs = development.map(
    (dependency) => `${dependency.name}@${dependency.spec}`,
  );
  if (manager === 'pnpm') {
    const target =
      packageRoot === '' ? ['-w'] : ['--filter', String(packageName)];
    return Object.freeze([
      Object.freeze([
        'corepack',
        'pnpm',
        ...target,
        'add',
        '--save-exact',
        ...runtimeSpecs,
      ]),
      ...(developmentSpecs.length === 0
        ? []
        : [
            Object.freeze([
              'corepack',
              'pnpm',
              ...target,
              'add',
              '--save-exact',
              '--save-dev',
              ...developmentSpecs,
            ]),
          ]),
    ]);
  }
  if (manager === 'yarn') {
    const prefix =
      packageRoot === ''
        ? ['corepack', 'yarn', 'add', '--ignore-workspace-root-check']
        : ['corepack', 'yarn', 'workspace', String(packageName)];
    if (packageRoot === '') {
      return Object.freeze([
        Object.freeze([...prefix, '--exact', ...runtimeSpecs]),
        ...(developmentSpecs.length === 0
          ? []
          : [
              Object.freeze([
                ...prefix,
                '--exact',
                '--dev',
                ...developmentSpecs,
              ]),
            ]),
      ]);
    }
    return Object.freeze([
      Object.freeze([...prefix, 'add', '--exact', ...runtimeSpecs]),
      ...(developmentSpecs.length === 0
        ? []
        : [
            Object.freeze([
              ...prefix,
              'add',
              '--exact',
              '--dev',
              ...developmentSpecs,
            ]),
          ]),
    ]);
  }
  const target = packageRoot === '' ? [] : ['--workspace', String(packageName)];
  return Object.freeze([
    Object.freeze([
      'npm',
      'install',
      ...target,
      '--save-exact',
      ...runtimeSpecs,
    ]),
    ...(developmentSpecs.length === 0
      ? []
      : [
          Object.freeze([
            'npm',
            'install',
            ...target,
            '--save-exact',
            '--save-dev',
            ...developmentSpecs,
          ]),
        ]),
  ]);
}

function preferredBuildScript(
  integration: BuildIntegrationInspection,
  manifestPath: string,
): { +manifestPath: string, +name: string } | null {
  const scripts = integration.packageScripts.map((entry) => {
    const marker = '#scripts.';
    const index = entry.indexOf(marker);
    return index < 0
      ? null
      : {
          manifestPath: entry.slice(0, index),
          name: entry.slice(index + marker.length),
        };
  });
  const available = (scripts.filter(Boolean) as $FlowFixMe).filter(
    (script) => script.manifestPath === manifestPath,
  );
  const candidates =
    available.length > 0
      ? available
      : integration.kind === 'babel'
        ? (scripts.filter(Boolean) as $FlowFixMe)
        : available;
  for (const preferred of ['build-production', 'build']) {
    const match = candidates.find((script) => script.name === preferred);
    if (match != null) return match;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function buildCommand({
  manager,
  packageName,
  packageRoot,
  script,
}: {
  +manager: 'pnpm' | 'yarn' | 'npm',
  +packageName: string | null,
  +packageRoot: string,
  +script: string,
}): $ReadOnlyArray<string> {
  if (manager === 'pnpm') {
    return Object.freeze(
      packageRoot === ''
        ? ['corepack', 'pnpm', 'run', script]
        : ['corepack', 'pnpm', '--filter', String(packageName), 'run', script],
    );
  }
  if (manager === 'yarn') {
    return Object.freeze(
      packageRoot === ''
        ? ['corepack', 'yarn', 'run', script]
        : ['corepack', 'yarn', 'workspace', String(packageName), 'run', script],
    );
  }
  return Object.freeze(
    packageRoot === ''
      ? ['npm', 'run', script]
      : ['npm', 'run', '--workspace', String(packageName), script],
  );
}

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
  const root = inspection.packages.find((target) => target.root === '');
  if (root != null) return root;
  const nested = inspection.packages.filter((target) => target.root !== '');
  if (nested.length === 1) return nested[0];
  return 'Bootstrap package ownership is ambiguous; select an exact package root.';
}

function packageForSourceFiles(
  inspection: BootstrapInspection,
  files: $ReadOnlyArray<string>,
): BootstrapPackageInspection | null {
  const matches = inspection.packages.filter((candidate) =>
    files.some(
      (file) => candidate.root !== '' && file.startsWith(`${candidate.root}/`),
    ),
  );
  matches.sort((a, b) => b.root.length - a.root.length);
  return matches[0] ?? null;
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
  stylexSpec = VERSION,
  integrationSpec = VERSION,
  unpluginSpec = '^2.3.11',
  workspaceRoot,
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +goal: string,
  +packageRoot?: string | null,
  +integration?: BuildIntegrationKind | null,
  +stylexSpec?: string,
  +integrationSpec?: string,
  +unpluginSpec?: string,
  +workspaceRoot?: string,
  +now?: () => string,
}): ContextOpenResult {
  if (
    stylexSpec === '' ||
    stylexSpec.includes('\0') ||
    integrationSpec === '' ||
    integrationSpec.includes('\0') ||
    unpluginSpec === '' ||
    unpluginSpec.includes('\0')
  ) {
    throw new Error('Bootstrap package specs must be non-empty literals');
  }
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
  const selectedPackage =
    packageRoot == null
      ? (packageForSourceFiles(
          inspection,
          inventory.files
            .filter((file) => file.siteIds.length > 0)
            .map((file) => file.path),
        ) ?? choosePackage(inspection, null))
      : choosePackage(inspection, packageRoot);
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
    (selectedIntegration.kind !== 'rspack' &&
      selectedIntegration.kind !== 'babel') ||
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
  const selectedBuildScript = preferredBuildScript(
    selectedIntegration,
    selectedPackage.manifestPath,
  );
  if (
    selectedBuildScript == null ||
    !inspection.packages.some(
      (candidate) =>
        candidate.manifestPath === selectedBuildScript.manifestPath,
    )
  ) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([
        `No unambiguous ${selectedIntegration.kind} application build script belongs to ${selectedPackage.manifestPath}.`,
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
  const dependencies = dependencyIntents(
    selectedIntegration.kind,
    stylexSpec,
    integrationSpec,
    unpluginSpec,
    integrationDependencySection(
      project.repositoryRoot,
      selectedPackage.manifestPath,
    ),
  );
  const commands = installCommands({
    manager: packageManager,
    packageName: selectedPackage.name,
    packageRoot: selectedPackage.root,
    dependencies,
  });
  const repositoryBuildCommand = buildCommand({
    manager: packageManager,
    packageName:
      inspection.packages.find(
        (candidate) =>
          candidate.manifestPath === selectedBuildScript.manifestPath,
      )?.name ?? null,
    packageRoot:
      inspection.packages.find(
        (candidate) =>
          candidate.manifestPath === selectedBuildScript.manifestPath,
      )?.root ?? '',
    script: selectedBuildScript.name,
  });
  const task = createContextTaskCapsule({
    goal,
    origin: {
      kind: 'bootstrap',
      inspectionId: inspection.id,
      packageRoot: selectedPackage.root,
      packageManager,
      integration: selectedIntegration.kind,
      dependencies,
      installCommands: commands,
      buildCommand: repositoryBuildCommand,
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
    requiredChecks: [
      ...config.evidence.providers.map((provider) => ({
        id: provider.id,
        check: provider.check,
        checkVersion: provider.checkVersion,
        subject: provider.subject,
        limitations: provider.limitations,
      })),
      {
        id:
          selectedIntegration.kind === 'babel'
            ? bootstrapBabelProviderId(inspection.id)
            : bootstrapRspackProviderId(inspection.id),
        check: 'build',
        checkVersion:
          selectedIntegration.kind === 'babel'
            ? BABEL_SENTINEL_CHECK_VERSION
            : RSPACK_SENTINEL_CHECK_VERSION,
        subject: 'candidate',
        limitations: [
          selectedIntegration.kind === 'babel'
            ? BABEL_SENTINEL_LIMITATION
            : RSPACK_SENTINEL_LIMITATION,
        ],
      },
    ],
    limitations: [
      'Bootstrap wiring inspection is syntactic; repository compilation and emitted-CSS evidence remain required.',
      ...(manager.status === 'inferred'
        ? ['The package manager was inferred from its lockfile.']
        : []),
      ...(config.evidence.providers.length === 0
        ? [
            `Only the built-in isolated ${selectedIntegration.kind} sentinel is configured; the repository application build is not covered.`,
          ]
        : []),
    ],
    stopConditions: [
      'Use only the discovered package manager and exact authorized package, lockfile, and build-config paths.',
      'Run only the exact dependency install argv recorded in the bootstrap origin.',
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

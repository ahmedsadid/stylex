/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { openContextTaskFromSpec } from '../context/lifecycle';
import { createContextTaskCapsule } from '../context/capsule';
import { hashString, shortHash } from '../kernel/hash';
import {
  createSnapshot,
  detectStaleFiles,
  snapshotHash,
} from '../kernel/snapshot';
import { loadCurrentInventory, loadCurrentPlan } from '../planning/reports';
import { canonicalJson } from '../state/json';
import { readConfig } from '../state/project';
import {
  THEME_BRIDGE_LIMITATION,
  THEME_NO_RUNTIME_LIMITATION,
  inspectThemeDecision,
  loadThemeDecisionDraft,
  validateThemeDecisionAgainstInventory,
} from './decisions';
import { emitThemeModule } from './emit';
import type { ContextOpenResult } from '../context/lifecycle';
import type { Cluster, Fact, Inventory } from '../inventory/model';
import type { ProjectState } from '../state/project';
import type { ThemeDecisionDraft } from './model';

export const THEME_BRIDGE_TASK_PROTOCOL_VERSION: string =
  'stylex-migrate-theme-bridge-task-v1';

function factTouchesFiles(fact: Fact, files: $ReadOnlySet<string>): boolean {
  return (
    fact.inputFiles.some((file) => files.has(file)) ||
    fact.provenance.some((item) => item.file != null && files.has(item.file))
  );
}

function bridgeWorkUnit({
  draft,
  inventory,
  declaredInputs,
  facts,
}: {
  +draft: ThemeDecisionDraft,
  +inventory: Inventory,
  +declaredInputs: $ReadOnlyArray<string>,
  +facts: $ReadOnlyArray<Fact>,
}): Cluster {
  if (draft.bridge == null) {
    throw new Error('Theme bridge work requires declared bridge coverage');
  }
  const changeFiles = [
    ...draft.bridge.boundaryFiles,
    draft.targetModule,
  ].sort();
  const id = `theme-bridge-${shortHash(
    hashString(
      canonicalJson({
        protocolVersion: THEME_BRIDGE_TASK_PROTOCOL_VERSION,
        inventoryId: inventory.id,
        definitionHash: draft.definitionHash,
        changeFiles,
        declaredInputs,
      }),
    ),
  )}`;
  return Object.freeze({
    id,
    siteIds: Object.freeze([]),
    changeFiles: Object.freeze(changeFiles),
    couplingFiles: Object.freeze(
      declaredInputs.filter((file) => !changeFiles.includes(file)),
    ),
    declaredInputs: Object.freeze([...declaredInputs]),
    factIds: Object.freeze(facts.map((fact) => fact.id).sort()),
    classification: 'repeatable-contextual',
    routingReasons: Object.freeze([
      'repository-specific theme provider integration requires contextual work',
    ]),
    state: 'planned',
    blockedReasons: Object.freeze([]),
  });
}

export function openThemeBridgeTask({
  project,
  draftId,
  goal,
  workspaceRoot,
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +draftId: string,
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
        'Run stylex-migrate scan before opening a theme bridge task.',
      ]),
    };
  }
  if (loadThemeDecisionDraft(project, draftId) == null) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([`No theme decision found for ${draftId}.`]),
    };
  }
  const inspection = inspectThemeDecision(project, draftId);
  if (inspection.state === 'superseded') {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([
        `Theme decision ${draftId} is superseded; draft against the current inventory and active target.`,
      ]),
    };
  }
  const draft = inspection.draft;
  const bridge = draft.bridge;
  if (bridge == null) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([
        `Theme decision ${draftId} declares no bridge boundary files or coverage.`,
      ]),
    };
  }
  try {
    validateThemeDecisionAgainstInventory(draft, inventory);
  } catch (error) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([
        error instanceof Error ? error.message : String(error),
      ]),
    };
  }
  if (inspection.bridgeEvidence?.complete === true) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([
        'Every declared variant is already observed in the bridge boundaries; rescan and continue with human review instead of opening another bridge task.',
      ]),
    };
  }

  const config = readConfig(project);
  const configHash = hashString(canonicalJson(config as $FlowFixMe));
  const declaredInputs = [
    ...new Set([
      ...draft.sourceFiles,
      ...draft.consumerFiles,
      ...bridge.boundaryFiles,
      ...inventory.configInputs,
      draft.targetModule,
    ]),
  ].sort();
  const snapshot = createSnapshot({
    repositoryRoot: project.repositoryRoot,
    files: declaredInputs,
    configHash,
    decisionArtifactHashes: [draft.definitionHash],
  });
  const stale = detectStaleFiles(snapshot);
  if (stale.length > 0) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze(
        stale.map(
          (file) =>
            `${file} differs from HEAD and is a declared bridge input; commit or stash it first.`,
        ),
      ),
    };
  }

  const factFiles = new Set(declaredInputs);
  const facts = inventory.facts.filter((fact) =>
    factTouchesFiles(fact, factFiles),
  );
  const workUnit = bridgeWorkUnit({
    draft,
    inventory,
    declaredInputs,
    facts,
  });
  const allowedPaths = [...bridge.boundaryFiles, draft.targetModule].sort();
  const protectedPaths = [
    '.stylex-migrate/**',
    ...declaredInputs.filter((file) => !allowedPaths.includes(file)),
  ];
  const generated = emitThemeModule(draft);
  const generatedBytes = Buffer.from(generated, 'utf8');
  const currentPlan = loadCurrentPlan(project);
  const task = createContextTaskCapsule({
    goal,
    origin: {
      kind: 'theme-bridge',
      draftId: draft.id,
      definitionHash: draft.definitionHash,
      targetModule: draft.targetModule,
    },
    inventoryId: inventory.id,
    planId:
      currentPlan != null && currentPlan.inventoryId === inventory.id
        ? currentPlan.id
        : null,
    cluster: workUnit,
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
      allowedPaths,
      protectedPaths,
      allowedDeletions: [],
      ownerDecisionPaths: [],
    },
    requiredOutputs: [
      {
        path: draft.targetModule,
        targetHash: hashString(generated),
        role: 'generated-theme-module',
        mutable: false,
      },
    ],
    decisionArtifactHashes: [draft.definitionHash],
    requiredChecks: config.evidence.providers.map((provider) => ({
      id: provider.id,
      check: provider.check,
      checkVersion: provider.checkVersion,
      subject: provider.subject,
      limitations: provider.limitations,
    })),
    limitations: [
      THEME_NO_RUNTIME_LIMITATION,
      THEME_BRIDGE_LIMITATION,
      'Static bridge wiring does not establish correct variant selection, provider topology, portals, inverted themes, SSR, or hydration.',
      ...(config.evidence.providers.length === 0
        ? [
            'No repository evidence providers are configured; verification will block.',
          ]
        : []),
    ],
    stopConditions: [
      'Do not modify the generated theme module.',
      'Do not remove or change the existing Emotion provider behavior.',
      'Do not add a semantic DOM wrapper solely to carry StyleX props without explicit human review.',
      'Do not mutate documentElement or global DOM state without an explicit repository decision.',
      'Stop if variant selection cannot use the same source as the existing Emotion theme.',
      'Stop if a portal, alternate document, inverted theme, SSR path, or hydration path requires an undeclared boundary.',
      'Do not edit project configuration, lockfiles, consumer files, source theme modules, or migration state.',
    ],
    now,
  });
  return openContextTaskFromSpec({
    project,
    task,
    snapshot,
    requiredOutputContents: [
      { path: draft.targetModule, contents: generatedBytes },
    ],
    workspaceRoot,
    now,
  });
}

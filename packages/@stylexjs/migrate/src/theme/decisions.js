/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { hashString, shortHash } from '../kernel/hash';
import { createSnapshot } from '../kernel/snapshot';
import { loadCurrentInventory } from '../planning/reports';
import { appendStateEvent, replayEvents } from '../state/events';
import { canonicalJson } from '../state/json';
import { readRecord, writeRecord } from '../state/project';
import {
  THEME_DECISION_PROTOCOL_VERSION,
  approveThemeDecision,
  createThemeDecisionDraft,
  validateThemeDecisionApproval,
  validateThemeDecisionDraft,
} from './model';
import { resolveThemeDecisionDefinition } from './resolve';
import type { CandidatePatch } from '../candidate/patch';
import type { Inventory } from '../inventory/model';
import type { ProjectState } from '../state/project';
import type { ThemeDecisionApproval, ThemeDecisionDraft } from './model';

export const THEME_NO_RUNTIME_LIMITATION: string =
  'WARNING: approving this token map does not establish runtime equivalence; configure runtime evidence before claiming runtime-matched.';
export const THEME_BRIDGE_LIMITATION: string =
  'WARNING: repository-managed theme bridge coverage is a human-approved scope assertion, not a static provider-graph proof; require runtime evidence for covered consumers.';

export type ThemeDecisionInspection = {
  +draft: ThemeDecisionDraft,
  +approval: ThemeDecisionApproval | null,
  +state: 'drafted' | 'active' | 'superseded',
  +activeArtifactHash: string | null,
};

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

function targetEntityId(targetModule: string): string {
  return `theme-target-${shortHash(hashString(targetModule))}`;
}

function factFile(fact: $FlowFixMe, files: $ReadOnlySet<string>): boolean {
  return fact.provenance.some(
    (item) => typeof item.file === 'string' && files.has(item.file),
  );
}

function assertInventoryFiles(
  inventory: Inventory,
  draft: ThemeDecisionDraft,
): void {
  const byPath = new Map(inventory.files.map((file) => [file.path, file]));
  const decisionFiles = [
    ...draft.sourceFiles,
    ...draft.consumerFiles,
    ...(draft.bridge?.boundaryFiles ?? []),
  ];
  for (const file of decisionFiles) {
    const found = byPath.get(file);
    if (
      found == null ||
      found.status !== 'scanned' ||
      found.sourceHash == null
    ) {
      throw new Error(
        `Theme decision input ${file} is not a scanned source file`,
      );
    }
    if (
      found.dependencies.some(
        (dependency) => dependency.status === 'resolution-failed',
      )
    ) {
      throw new Error(
        `Theme decision input ${file} has an unresolved local dependency`,
      );
    }
  }
  const snapshot = createSnapshot({
    repositoryRoot: inventory.repositoryRoot,
    files: [...new Set(decisionFiles)],
  });
  for (const file of decisionFiles) {
    if (snapshot.fileHashes[file] !== byPath.get(file)?.sourceHash) {
      throw new Error(
        `Theme decision input ${file} no longer matches inventory ${inventory.id}; scan again after committing or stashing changes`,
      );
    }
  }
}

export function validateThemeDecisionAgainstInventory(
  inputDraft: ThemeDecisionDraft,
  inventory: Inventory,
): ThemeDecisionDraft {
  const draft = validateThemeDecisionDraft(inputDraft);
  if (draft.inventoryId !== inventory.id) {
    throw new Error(
      `Theme decision names inventory ${draft.inventoryId}, but the current inventory is ${inventory.id}`,
    );
  }
  const resolved: $FlowFixMe = resolveThemeDecisionDefinition({
    repositoryRoot: inventory.repositoryRoot,
    definition: draft,
  });
  if (
    canonicalJson(resolved.tokens) !== canonicalJson(draft.tokens) ||
    canonicalJson(resolved.sourceFiles) !== canonicalJson(draft.sourceFiles)
  ) {
    throw new Error(
      'Theme decision values or transitive source files do not match the current repository',
    );
  }
  assertInventoryFiles(inventory, draft);
  for (const token of draft.tokens) {
    const existingCssVariable = token.existingCssVariable;
    for (const variant of draft.variants) {
      const decided = token.values[variant.name];
      if (
        existingCssVariable != null &&
        (typeof decided !== 'string' ||
          !decided.includes(`var(${existingCssVariable}`))
      ) {
        throw new Error(
          `Theme token ${token.sourcePath} does not use declared CSS variable ${existingCssVariable} in every variant`,
        );
      }
    }
  }
  const consumerFiles = new Set(draft.consumerFiles);
  const consumerFacts = inventory.facts.filter(
    (fact) =>
      (fact.kind === 'theme-read' || fact.kind === 'theme-provider') &&
      factFile(fact, consumerFiles),
  );
  for (const file of draft.consumerFiles) {
    if (!consumerFacts.some((fact) => factFile(fact, new Set([file])))) {
      throw new Error(`Theme consumer ${file} has no discovered theme use`);
    }
  }
  const mappedPaths = new Set(draft.tokens.map((token) => token.sourcePath));
  for (const fact of consumerFacts) {
    const value: $FlowFixMe = fact.value;
    if (
      fact.kind === 'theme-read' &&
      typeof value.sourcePath === 'string' &&
      !mappedPaths.has(value.sourcePath)
    ) {
      throw new Error(
        `Theme consumer read ${value.sourcePath} has no token-map entry`,
      );
    }
  }
  return draft;
}

function readDraftPayload(value: mixed, id: string): ThemeDecisionDraft {
  const payload: $FlowFixMe = value;
  if (!object(payload) || payload.kind !== 'theme-decision-draft') {
    throw new Error(`Invalid persisted theme decision ${id}`);
  }
  const draft = validateThemeDecisionDraft(payload.draft);
  if (draft.id !== id) {
    throw new Error(`Theme decision record ${id} contains another draft`);
  }
  return draft;
}

export function loadThemeDecisionDraft(
  project: ProjectState,
  id: string,
): ThemeDecisionDraft | null {
  try {
    return readDraftPayload(readRecord(project, 'decisions', id).payload, id);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function writeDraft(
  project: ProjectState,
  draft: ThemeDecisionDraft,
  now?: () => string,
): ThemeDecisionDraft {
  const existing = loadThemeDecisionDraft(project, draft.id);
  if (existing != null) {
    if (existing.definitionHash !== draft.definitionHash) {
      throw new Error(`Theme decision identity collision for ${draft.id}`);
    }
    return existing;
  }
  writeRecord(
    project,
    'decisions',
    draft.id,
    { kind: 'theme-decision-draft', draft } as $FlowFixMe,
    { now },
  );
  appendStateEvent({
    project,
    entityKind: 'decision',
    entityId: draft.id,
    state: 'drafted',
    data: {
      targetModule: draft.targetModule,
      definitionHash: draft.definitionHash,
    },
    now,
  });
  return draft;
}

export function persistThemeDecisionDraft({
  project,
  definition,
  draftedBy,
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +definition: mixed,
  +draftedBy: string,
  +now?: () => string,
}): ThemeDecisionDraft {
  const inventory = loadCurrentInventory(project);
  if (inventory == null) {
    throw new Error('Run stylex-migrate scan before drafting a theme decision');
  }
  const draft = createThemeDecisionDraft({ definition, draftedBy, now });
  validateThemeDecisionAgainstInventory(draft, inventory);
  return writeDraft(project, draft, now);
}

function readApprovalPayload(
  value: mixed,
  artifactHash: string,
  draft: ThemeDecisionDraft,
): ThemeDecisionApproval {
  const payload: $FlowFixMe = value;
  if (
    !object(payload) ||
    payload.kind !== 'theme-decision-approval' ||
    payload.targetModule !== draft.targetModule
  ) {
    throw new Error(`Invalid persisted theme approval ${artifactHash}`);
  }
  const approval = validateThemeDecisionApproval({
    draft,
    approval: payload.approval,
  });
  if (approval.artifactHash !== artifactHash) {
    throw new Error(
      `Theme approval record ${artifactHash} contains another approval`,
    );
  }
  return approval;
}

export function loadThemeDecisionApproval(
  project: ProjectState,
  artifactHash: string,
): ThemeDecisionApproval | null {
  try {
    const payload: $FlowFixMe = readRecord(
      project,
      'approvals',
      artifactHash,
    ).payload;
    if (!object(payload) || typeof payload.draftId !== 'string') {
      throw new Error(`Invalid persisted theme approval ${artifactHash}`);
    }
    const draft = loadThemeDecisionDraft(project, payload.draftId);
    if (draft == null) {
      throw new Error(
        `Theme approval ${artifactHash} refers to a missing draft`,
      );
    }
    return readApprovalPayload(payload, artifactHash, draft);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function activeArtifactHash(
  project: ProjectState,
  targetModule: string,
): string | null {
  const entry =
    replayEvents(project).indexes.decisions[targetEntityId(targetModule)];
  const data: $FlowFixMe = entry?.data;
  return entry?.state === 'approved' && typeof data?.artifactHash === 'string'
    ? data.artifactHash
    : null;
}

export function inspectThemeDecision(
  project: ProjectState,
  draftId: string,
): ThemeDecisionInspection {
  const draft = loadThemeDecisionDraft(project, draftId);
  if (draft == null) throw new Error(`No theme decision found for ${draftId}`);
  const entry = replayEvents(project).indexes.decisions[draft.id];
  const data: $FlowFixMe = entry?.data;
  const approval =
    typeof data?.artifactHash === 'string'
      ? loadThemeDecisionApproval(project, data.artifactHash)
      : null;
  const active = activeArtifactHash(project, draft.targetModule);
  return Object.freeze({
    draft,
    approval,
    state:
      approval == null
        ? 'drafted'
        : approval.artifactHash === active
          ? 'active'
          : 'superseded',
    activeArtifactHash: active,
  });
}

export function approvePersistedThemeDecision({
  project,
  draftId,
  actor,
  approvedBy,
  limitations = [],
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +draftId: string,
  +actor: 'human',
  +approvedBy: string,
  +limitations?: $ReadOnlyArray<string>,
  +now?: () => string,
}): ThemeDecisionApproval {
  const draft = loadThemeDecisionDraft(project, draftId);
  if (draft == null) throw new Error(`No theme decision found for ${draftId}`);
  const inventory = loadCurrentInventory(project);
  if (inventory == null) {
    throw new Error(
      'Run stylex-migrate scan before approving a theme decision',
    );
  }
  validateThemeDecisionAgainstInventory(draft, inventory);
  const proposed = approveThemeDecision({
    draft,
    actor,
    approvedBy,
    limitations: [
      ...limitations,
      THEME_NO_RUNTIME_LIMITATION,
      ...(draft.bridge == null ? [] : [THEME_BRIDGE_LIMITATION]),
    ],
    now,
  });
  const existing = loadThemeDecisionApproval(project, proposed.artifactHash);
  const approval = existing ?? proposed;
  if (existing == null) {
    writeRecord(
      project,
      'approvals',
      approval.artifactHash,
      {
        kind: 'theme-decision-approval',
        draftId: draft.id,
        targetModule: draft.targetModule,
        approval,
      } as $FlowFixMe,
      { now },
    );
  }
  const inspection = inspectThemeDecision(project, draft.id);
  if (
    inspection.state === 'active' &&
    inspection.approval?.artifactHash === approval.artifactHash
  ) {
    return approval;
  }
  appendStateEvent({
    project,
    entityKind: 'decision',
    entityId: draft.id,
    state: 'approved',
    data: {
      artifactHash: approval.artifactHash,
      approvalId: approval.id,
      targetModule: draft.targetModule,
    },
    now,
  });
  appendStateEvent({
    project,
    entityKind: 'decision',
    entityId: targetEntityId(draft.targetModule),
    state: 'approved',
    data: {
      artifactHash: approval.artifactHash,
      draftId: draft.id,
      targetModule: draft.targetModule,
    },
    now,
  });
  return approval;
}

export function assertActiveThemeCandidateDecisions(
  project: ProjectState,
  candidate: CandidatePatch,
): void {
  if (
    candidate.proposer.protocolVersion !== THEME_DECISION_PROTOCOL_VERSION &&
    candidate.proposer.version !== 'theme-decision-v1'
  ) {
    return;
  }
  if (candidate.decisionArtifactHashes.length !== 1) {
    throw new Error(
      `Theme candidate ${candidate.id} must name exactly one approved decision`,
    );
  }
  const artifactHash = candidate.decisionArtifactHashes[0];
  const approval = loadThemeDecisionApproval(project, artifactHash);
  if (approval == null) {
    throw new Error(
      `Theme candidate ${candidate.id} refers to missing approval ${artifactHash}`,
    );
  }
  const draft = loadThemeDecisionDraft(project, approval.draftId);
  if (draft == null) {
    throw new Error(
      `Theme candidate ${candidate.id} refers to missing decision ${approval.draftId}`,
    );
  }
  if (activeArtifactHash(project, draft.targetModule) !== artifactHash) {
    throw new Error(
      `Theme candidate ${candidate.id} is stale because another decision is active for ${draft.targetModule}`,
    );
  }
}

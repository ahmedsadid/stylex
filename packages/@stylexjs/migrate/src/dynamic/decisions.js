/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { appendStateEvent, replayEvents } from '../state/events';
import { loadCurrentInventory, loadCurrentPlan } from '../planning/reports';
import { readRecord, writeRecord } from '../state/project';
import {
  createDynamicStrategyDraft,
  validateDynamicStrategyDraft,
} from './model';
import type { Fact, Inventory, Plan } from '../inventory/model';
import type { ProjectState } from '../state/project';
import type { DynamicStrategyDraft } from './model';

export type DynamicStrategyInspection = {
  +draft: DynamicStrategyDraft,
  +state: 'active' | 'superseded',
  +activeDefinitionHash: string | null,
};

function isMissing(error: mixed): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function clusterEntityId(clusterId: string): string {
  return `dynamic-cluster-${clusterId}`;
}

function expectedEntries(
  inventory: Inventory,
  plan: Plan,
  clusterId: string,
): Map<string, Fact> {
  const cluster = plan.clusters.find((item) => item.id === clusterId);
  if (cluster == null) {
    throw new Error(`No current cluster exists with id ${clusterId}`);
  }
  if (cluster.state !== 'planned') {
    throw new Error(`Dynamic strategy cluster ${clusterId} is blocked`);
  }
  const sitesById = new Map(inventory.sites.map((site) => [site.id, site]));
  const dynamicSites = cluster.siteIds
    .map((id) => sitesById.get(id))
    .filter((site) => site?.kind === 'styled-dynamic-intrinsic');
  if (dynamicSites.length === 0) {
    throw new Error(`Cluster ${clusterId} has no dynamic styled site`);
  }
  const factsById = new Map(inventory.facts.map((fact) => [fact.id, fact]));
  const expected: Map<string, Fact> = new Map();
  for (const site of dynamicSites) {
    if (site == null) continue;
    const dynamicFact = site.factIds
      .map((id) => factsById.get(id))
      .find((fact) => fact?.kind === 'emotion-styled-dynamic-value');
    if (dynamicFact == null) {
      throw new Error(`Dynamic site ${site.id} has no strategy input fact`);
    }
    const dynamic: $FlowFixMe = dynamicFact.value;
    for (const callback of dynamic.callbacks ?? []) {
      for (const propPath of callback.propPaths ?? []) {
        expected.set(
          `${String(dynamic.definitionFactId)}:${String(propPath)}`,
          dynamicFact,
        );
      }
    }
  }
  if (expected.size === 0) {
    throw new Error(
      `Dynamic strategy cluster ${clusterId} has no statically addressable prop path`,
    );
  }
  return expected;
}

export function validateDynamicStrategyAgainstCurrentProject(
  project: ProjectState,
  inputDraft: DynamicStrategyDraft,
): DynamicStrategyDraft {
  const draft = validateDynamicStrategyDraft(inputDraft);
  const inventory = loadCurrentInventory(project);
  const plan = loadCurrentPlan(project);
  if (inventory == null || plan == null || plan.inventoryId !== inventory.id) {
    throw new Error(
      'Run stylex-migrate scan and plan before drafting a dynamic strategy',
    );
  }
  if (draft.inventoryId !== inventory.id) {
    throw new Error(
      `Dynamic strategy names inventory ${draft.inventoryId}, but current inventory is ${inventory.id}`,
    );
  }
  const expected = expectedEntries(inventory, plan, draft.clusterId);
  const actual = new Set(
    draft.entries.map((entry) => `${entry.definitionFactId}:${entry.propPath}`),
  );
  const missing = [...expected.keys()].filter((key) => !actual.has(key));
  const extra = [...actual].filter((key) => !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Dynamic strategy must cover exactly the cluster prop paths; missing [${missing.join(', ')}], extra [${extra.join(', ')}]`,
    );
  }
  const strategiesByDefinition = new Map<string, Set<string>>();
  for (const entry of draft.entries) {
    const strategies =
      strategiesByDefinition.get(entry.definitionFactId) ?? new Set();
    strategies.add(entry.strategy);
    strategiesByDefinition.set(entry.definitionFactId, strategies);
  }
  for (const [definitionFactId, strategies] of strategiesByDefinition) {
    if (strategies.has('retain-emotion') && strategies.size > 1) {
      throw new Error(
        `Definition ${definitionFactId} must retain Emotion for every prop path or none`,
      );
    }
  }
  return draft;
}

export function loadDynamicStrategyDraft(
  project: ProjectState,
  id: string,
): DynamicStrategyDraft | null {
  try {
    const payload: $FlowFixMe = readRecord(project, 'decisions', id).payload;
    if (payload?.kind !== 'dynamic-strategy-draft') {
      throw new Error(`Invalid persisted dynamic strategy ${id}`);
    }
    const draft = validateDynamicStrategyDraft(payload.draft);
    if (draft.id !== id) {
      throw new Error(`Dynamic strategy record ${id} contains another draft`);
    }
    return draft;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function activeDefinitionHash(
  project: ProjectState,
  clusterId: string,
): string | null {
  const entry =
    replayEvents(project).indexes.decisions[clusterEntityId(clusterId)];
  const data: $FlowFixMe = entry?.data;
  return entry?.state === 'active' && typeof data?.definitionHash === 'string'
    ? data.definitionHash
    : null;
}

export function currentDynamicStrategy(
  project: ProjectState,
  clusterId: string,
): DynamicStrategyDraft | null {
  const entry =
    replayEvents(project).indexes.decisions[clusterEntityId(clusterId)];
  const data: $FlowFixMe = entry?.data;
  if (entry?.state !== 'active' || typeof data?.draftId !== 'string') {
    return null;
  }
  const draft = loadDynamicStrategyDraft(project, data.draftId);
  if (draft == null || draft.definitionHash !== data.definitionHash) {
    throw new Error(
      `Active dynamic strategy for ${clusterId} is missing or invalid`,
    );
  }
  return draft;
}

export function inspectDynamicStrategy(
  project: ProjectState,
  id: string,
): DynamicStrategyInspection {
  const draft = loadDynamicStrategyDraft(project, id);
  if (draft == null) throw new Error(`No dynamic strategy found for ${id}`);
  const active = activeDefinitionHash(project, draft.clusterId);
  return Object.freeze({
    draft,
    state: active === draft.definitionHash ? 'active' : 'superseded',
    activeDefinitionHash: active,
  });
}

export function persistDynamicStrategyDraft({
  project,
  definition,
  authorKind,
  authoredBy,
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +definition: mixed,
  +authorKind: 'agent' | 'human',
  +authoredBy: string,
  +now?: () => string,
}): DynamicStrategyDraft {
  const proposed = createDynamicStrategyDraft({
    definition,
    authorKind,
    authoredBy,
    now,
  });
  const draft = validateDynamicStrategyAgainstCurrentProject(project, proposed);
  const existing = loadDynamicStrategyDraft(project, draft.id);
  if (existing != null) {
    if (existing.definitionHash !== draft.definitionHash) {
      throw new Error(`Dynamic strategy identity collision for ${draft.id}`);
    }
  } else {
    writeRecord(
      project,
      'decisions',
      draft.id,
      { kind: 'dynamic-strategy-draft', draft } as $FlowFixMe,
      { now },
    );
    appendStateEvent({
      project,
      entityKind: 'decision',
      entityId: draft.id,
      state: 'drafted',
      data: {
        clusterId: draft.clusterId,
        definitionHash: draft.definitionHash,
      },
      now,
    });
  }
  const persisted = existing ?? draft;
  if (
    activeDefinitionHash(project, persisted.clusterId) ===
    persisted.definitionHash
  ) {
    return persisted;
  }
  appendStateEvent({
    project,
    entityKind: 'decision',
    entityId: clusterEntityId(persisted.clusterId),
    state: 'active',
    data: {
      clusterId: persisted.clusterId,
      draftId: persisted.id,
      definitionHash: persisted.definitionHash,
    },
    now,
  });
  return persisted;
}

export function assertCurrentDynamicStrategy(
  project: ProjectState,
  draft: DynamicStrategyDraft,
): void {
  validateDynamicStrategyAgainstCurrentProject(project, draft);
  if (activeDefinitionHash(project, draft.clusterId) !== draft.definitionHash) {
    throw new Error(`Dynamic strategy ${draft.id} is no longer active`);
  }
}

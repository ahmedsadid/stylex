/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { inventoryIdentity } from '../inventory/model';
import { planIdentity } from './plan';
import { readRecord, writeRecord } from '../state/project';
import { canonicalJson } from '../state/json';
import type { Inventory, Plan } from '../inventory/model';
import type { JsonValue } from '../state/json';
import type { ProjectState, RecordEnvelope } from '../state/project';

const REPORT_COLLECTION = 'reports';
const INVENTORY_CURRENT = 'inventory-current';
const PLAN_CURRENT = 'plan-current';
const CLASSIFICATIONS = new Set([
  'mechanical',
  'repeatable-contextual',
  'bespoke-contextual',
  'owner-decision',
]);
const FACT_STATUSES = new Set([
  'known',
  'inferred',
  'unknown',
  'resolution-failed',
]);

function isMissing(error: mixed): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function strings(value: mixed): boolean {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function object(value: mixed): boolean {
  return value != null && !Array.isArray(value) && typeof value === 'object';
}

function validFact(value: mixed): boolean {
  const fact: $FlowFixMe = value;
  return (
    object(fact) &&
    typeof fact.id === 'string' &&
    typeof fact.kind === 'string' &&
    FACT_STATUSES.has(fact.status) &&
    Array.isArray(fact.provenance) &&
    fact.provenance.every(
      (item) =>
        object(item) &&
        typeof item.kind === 'string' &&
        (item.file === null || typeof item.file === 'string') &&
        typeof item.detail === 'string',
    ) &&
    strings(fact.inputFiles)
  );
}

function validDependency(value: mixed): boolean {
  const dependency: $FlowFixMe = value;
  return (
    object(dependency) &&
    typeof dependency.specifier === 'string' &&
    (dependency.status === 'known' ||
      dependency.status === 'resolution-failed') &&
    (dependency.resolvedPath === null ||
      typeof dependency.resolvedPath === 'string') &&
    typeof dependency.factId === 'string'
  );
}

function validFile(value: mixed): boolean {
  const file: $FlowFixMe = value;
  return (
    object(file) &&
    typeof file.path === 'string' &&
    (file.sourceHash === null || typeof file.sourceHash === 'string') &&
    (file.status === 'scanned' ||
      file.status === 'parse-failed' ||
      file.status === 'read-failed') &&
    strings(file.siteIds) &&
    strings(file.factIds) &&
    Array.isArray(file.dependencies) &&
    file.dependencies.every(validDependency)
  );
}

function validSite(value: mixed): boolean {
  const site: $FlowFixMe = value;
  return (
    object(site) &&
    typeof site.id === 'string' &&
    typeof site.adapter === 'string' &&
    typeof site.kind === 'string' &&
    typeof site.file === 'string' &&
    object(site.span) &&
    typeof site.span.start === 'number' &&
    typeof site.span.end === 'number' &&
    typeof site.sourceHash === 'string' &&
    (site.syntax === 'supported' || site.syntax === 'refused') &&
    (site.refusalReason === null || typeof site.refusalReason === 'string') &&
    strings(site.factIds) &&
    CLASSIFICATIONS.has(site.classification) &&
    strings(site.routingReasons)
  );
}

function validDiagnostic(value: mixed): boolean {
  const diagnostic: $FlowFixMe = value;
  return (
    object(diagnostic) &&
    typeof diagnostic.file === 'string' &&
    (diagnostic.kind === 'read' || diagnostic.kind === 'parse') &&
    typeof diagnostic.detail === 'string' &&
    typeof diagnostic.factId === 'string'
  );
}

function parseInventory(
  value: mixed,
  project: ProjectState,
  scannedAt: string,
): Inventory {
  const inventory: $FlowFixMe = value;
  if (
    !object(inventory) ||
    typeof inventory.id !== 'string' ||
    inventory.repositoryRoot !== project.repositoryRoot ||
    !strings(inventory.sourceGlobs) ||
    !Array.isArray(inventory.files) ||
    !inventory.files.every(validFile) ||
    !Array.isArray(inventory.sites) ||
    !inventory.sites.every(validSite) ||
    !Array.isArray(inventory.facts) ||
    !inventory.facts.every(validFact) ||
    !Array.isArray(inventory.diagnostics) ||
    !inventory.diagnostics.every(validDiagnostic) ||
    !strings(inventory.configInputs)
  ) {
    throw new Error('Invalid persisted inventory');
  }
  const expected = inventoryIdentity({
    repositoryRoot: inventory.repositoryRoot,
    sourceGlobs: inventory.sourceGlobs,
    files: inventory.files,
    sites: inventory.sites,
    facts: inventory.facts,
    diagnostics: inventory.diagnostics,
    configInputs: inventory.configInputs,
  });
  if (inventory.id !== expected) {
    throw new Error('Integrity check failed for persisted inventory identity');
  }
  return Object.freeze({ ...inventory, scannedAt });
}

function validConflict(value: mixed): boolean {
  const conflict: $FlowFixMe = value;
  return (
    object(conflict) &&
    typeof conflict.path === 'string' &&
    strings(conflict.clusterIds)
  );
}

function validCluster(value: mixed): boolean {
  const cluster: $FlowFixMe = value;
  return (
    object(cluster) &&
    typeof cluster.id === 'string' &&
    strings(cluster.siteIds) &&
    strings(cluster.changeFiles) &&
    strings(cluster.couplingFiles) &&
    strings(cluster.declaredInputs) &&
    strings(cluster.factIds) &&
    CLASSIFICATIONS.has(cluster.classification) &&
    strings(cluster.routingReasons) &&
    (cluster.state === 'planned' || cluster.state === 'blocked') &&
    strings(cluster.blockedReasons)
  );
}

function parsePlan(value: mixed, generatedAt: string): Plan {
  const plan: $FlowFixMe = value;
  if (
    !object(plan) ||
    typeof plan.id !== 'string' ||
    typeof plan.inventoryId !== 'string' ||
    !Array.isArray(plan.clusters) ||
    !plan.clusters.every(validCluster) ||
    !Array.isArray(plan.conflicts) ||
    !plan.conflicts.every(validConflict) ||
    !object(plan.counts) ||
    !object(plan.counts.classification) ||
    !object(plan.counts.state) ||
    typeof plan.diagnosticCount !== 'number'
  ) {
    throw new Error('Invalid persisted plan');
  }
  for (const classification of CLASSIFICATIONS) {
    if (typeof plan.counts.classification[classification] !== 'number') {
      throw new Error('Invalid persisted plan classification counts');
    }
  }
  if (
    typeof plan.counts.state.planned !== 'number' ||
    typeof plan.counts.state.blocked !== 'number'
  ) {
    throw new Error('Invalid persisted plan state counts');
  }
  const expected = planIdentity({
    inventoryId: plan.inventoryId,
    clusters: plan.clusters,
    conflicts: plan.conflicts,
    counts: plan.counts,
    diagnosticCount: plan.diagnosticCount,
  });
  if (plan.id !== expected) {
    throw new Error('Integrity check failed for persisted plan identity');
  }
  return Object.freeze({ ...plan, generatedAt });
}

function readPointer(
  project: ProjectState,
  id: string,
  kind: 'inventory' | 'plan',
): { +id: string, +timestamp: string } | null {
  let payload: JsonValue;
  try {
    payload = readRecord(project, REPORT_COLLECTION, id).payload;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  const pointer: $FlowFixMe = payload;
  if (
    !object(pointer) ||
    pointer.kind !== `${kind}-pointer` ||
    typeof pointer.id !== 'string' ||
    typeof pointer.timestamp !== 'string'
  ) {
    throw new Error(`Invalid current ${kind} pointer`);
  }
  return Object.freeze({ id: pointer.id, timestamp: pointer.timestamp });
}

function writeImmutableReport(
  project: ProjectState,
  id: string,
  payload: JsonValue,
  now?: () => string,
): void {
  try {
    const existing = readRecord(project, REPORT_COLLECTION, id);
    if (canonicalJson(existing.payload) !== canonicalJson(payload)) {
      throw new Error(`Content identity collision for report ${id}`);
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    writeRecord(project, REPORT_COLLECTION, id, payload, { now });
  }
}

export function saveInventory(
  project: ProjectState,
  inventory: Inventory,
  options?: { +now?: () => string },
): void {
  const now = options?.now;
  const { scannedAt, ...stable } = inventory;
  writeImmutableReport(
    project,
    `inventory-${inventory.id}`,
    { kind: 'inventory', inventory: stable } as $FlowFixMe,
    now,
  );
  writeRecord(
    project,
    REPORT_COLLECTION,
    INVENTORY_CURRENT,
    { kind: 'inventory-pointer', id: inventory.id, timestamp: scannedAt },
    { now },
  );
}

export function loadInventory(
  project: ProjectState,
  id: string,
): Inventory | null {
  let record: RecordEnvelope;
  try {
    record = readRecord(project, REPORT_COLLECTION, `inventory-${id}`);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  const payload: $FlowFixMe = record.payload;
  if (!object(payload) || payload.kind !== 'inventory') {
    throw new Error(`Invalid persisted inventory record ${id}`);
  }
  return parseInventory(payload.inventory, project, record.writtenAt);
}

export function loadCurrentInventory(project: ProjectState): Inventory | null {
  const pointer = readPointer(project, INVENTORY_CURRENT, 'inventory');
  if (pointer == null) {
    return null;
  }
  const inventory = loadInventory(project, pointer.id);
  return inventory == null
    ? null
    : Object.freeze({ ...inventory, scannedAt: pointer.timestamp });
}

export function savePlan(
  project: ProjectState,
  plan: Plan,
  options?: { +now?: () => string },
): void {
  const now = options?.now;
  const { generatedAt, ...stable } = plan;
  writeImmutableReport(
    project,
    `plan-${plan.id}`,
    { kind: 'plan', plan: stable } as $FlowFixMe,
    now,
  );
  writeRecord(
    project,
    REPORT_COLLECTION,
    PLAN_CURRENT,
    { kind: 'plan-pointer', id: plan.id, timestamp: generatedAt },
    { now },
  );
}

export function loadPlan(project: ProjectState, id: string): Plan | null {
  let record: RecordEnvelope;
  try {
    record = readRecord(project, REPORT_COLLECTION, `plan-${id}`);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  const payload: $FlowFixMe = record.payload;
  if (!object(payload) || payload.kind !== 'plan') {
    throw new Error(`Invalid persisted plan record ${id}`);
  }
  return parsePlan(payload.plan, record.writtenAt);
}

export function loadCurrentPlan(project: ProjectState): Plan | null {
  const pointer = readPointer(project, PLAN_CURRENT, 'plan');
  if (pointer == null) {
    return null;
  }
  const plan = loadPlan(project, pointer.id);
  return plan == null
    ? null
    : Object.freeze({ ...plan, generatedAt: pointer.timestamp });
}

export function inventoryCounts(inventory: Inventory): JsonValue {
  const classification = {
    mechanical: 0,
    'repeatable-contextual': 0,
    'bespoke-contextual': 0,
    'owner-decision': 0,
  };
  const factStatus = {
    known: 0,
    inferred: 0,
    unknown: 0,
    'resolution-failed': 0,
  };
  const fileStatus = { scanned: 0, 'parse-failed': 0, 'read-failed': 0 };
  for (const site of inventory.sites) {
    classification[site.classification]++;
  }
  for (const fact of inventory.facts) {
    factStatus[fact.status]++;
  }
  for (const file of inventory.files) {
    fileStatus[file.status]++;
  }
  return {
    files: fileStatus,
    sites: classification,
    facts: factStatus,
    diagnostics: inventory.diagnostics.length,
  };
}

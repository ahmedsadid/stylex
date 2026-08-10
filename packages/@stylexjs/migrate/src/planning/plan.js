/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { hashString, shortHash } from '../kernel/hash';
import { canonicalJson } from '../state/json';
import type {
  Classification,
  Cluster,
  ClusterConflict,
  ClusterSuggestion,
  Fact,
  Inventory,
  InventoryFile,
  Plan,
  PlanCounts,
  Site,
} from '../inventory/model';

const CLASSIFICATION_RANK: { +[Classification]: number } = {
  mechanical: 0,
  'repeatable-contextual': 1,
  'bespoke-contextual': 2,
  'owner-decision': 3,
};

function identity(value: mixed): string {
  return shortHash(hashString(canonicalJson(value as $FlowFixMe)));
}

function strongest(
  classifications: $ReadOnlyArray<Classification>,
): Classification {
  let result: Classification = 'mechanical';
  for (const classification of classifications) {
    if (CLASSIFICATION_RANK[classification] > CLASSIFICATION_RANK[result]) {
      result = classification;
    }
  }
  return result;
}

function declaredInputsFor({
  site,
  files,
  facts,
}: {
  +site: Site,
  +files: Map<string, InventoryFile>,
  +facts: Map<string, Fact>,
}): {
  +inputs: $ReadOnlyArray<string>,
  +couplingFiles: $ReadOnlyArray<string>,
  +factIds: $ReadOnlyArray<string>,
  +blockedReasons: $ReadOnlyArray<string>,
} {
  const inputs = new Set<string>([site.file]);
  const factIds = new Set<string>(site.factIds);
  const blockedReasons = new Set<string>();
  const pending = [site.file];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file == null || visited.has(file)) {
      continue;
    }
    visited.add(file);
    const record = files.get(file);
    if (record == null) {
      blockedReasons.add(`declared dependency ${file} was not inventoried`);
      continue;
    }
    if (record.status !== 'scanned') {
      blockedReasons.add(`declared dependency ${file} is ${record.status}`);
    }
    for (const factId of record.factIds) {
      factIds.add(factId);
      const fact = facts.get(factId);
      if (fact == null) {
        blockedReasons.add(`fact ${factId} is missing from the inventory`);
        continue;
      }
      for (const input of fact.inputFiles) {
        inputs.add(input);
      }
      if (fact.status === 'resolution-failed') {
        blockedReasons.add(`${fact.kind} ${fact.id} is resolution-failed`);
      }
    }
    for (const dependency of record.dependencies) {
      factIds.add(dependency.factId);
      if (dependency.status === 'resolution-failed') {
        blockedReasons.add(
          `could not resolve ${dependency.specifier} from ${file}`,
        );
        continue;
      }
      const resolvedPath = dependency.resolvedPath;
      if (resolvedPath != null) {
        inputs.add(resolvedPath);
        pending.push(resolvedPath);
      }
    }
  }
  return Object.freeze({
    inputs: Object.freeze([...inputs].sort()),
    // Read-only dependencies are evidence inputs, not automatic migration
    // coupling. Adapters may add semantic coupling when changing one site can
    // invalidate another; this inventory pass only owns the site's file.
    couplingFiles: Object.freeze([site.file]),
    factIds: Object.freeze([...factIds].sort()),
    blockedReasons: Object.freeze([...blockedReasons].sort()),
  });
}

export function suggestClusters(
  inventory: Inventory,
): $ReadOnlyArray<ClusterSuggestion> {
  const files = new Map(inventory.files.map((file) => [file.path, file]));
  const facts = new Map(inventory.facts.map((fact) => [fact.id, fact]));
  return Object.freeze(
    inventory.sites.map((site) => {
      const declared = declaredInputsFor({ site, files, facts });
      const classification: Classification =
        declared.blockedReasons.length > 0
          ? 'owner-decision'
          : site.classification;
      const routingReasons = [
        ...site.routingReasons,
        ...(declared.blockedReasons.length > 0
          ? ['dependency analysis is incomplete']
          : []),
      ];
      const stable = {
        siteIds: Object.freeze([site.id]),
        changeFiles: Object.freeze([site.file]),
        couplingFiles: declared.couplingFiles,
        declaredInputs: declared.inputs,
        factIds: declared.factIds,
        classification,
        routingReasons: Object.freeze(routingReasons),
        blockedReasons: declared.blockedReasons,
      };
      return Object.freeze({ id: identity(stable), ...stable });
    }),
  );
}

function overlaps(
  first: ClusterSuggestion,
  second: ClusterSuggestion,
): boolean {
  const sites = new Set(first.siteIds);
  if (second.siteIds.some((site) => sites.has(site))) {
    return true;
  }
  const coupling = new Set(first.couplingFiles);
  return second.couplingFiles.some((file) => coupling.has(file));
}

function mergeSuggestions(
  suggestions: $ReadOnlyArray<ClusterSuggestion>,
): $ReadOnlyArray<Cluster> {
  const groups: Array<Array<ClusterSuggestion>> = [];
  for (const suggestion of suggestions) {
    const matching = [];
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].some((existing) => overlaps(existing, suggestion))) {
        matching.push(i);
      }
    }
    if (matching.length === 0) {
      groups.push([suggestion]);
      continue;
    }
    const primary = matching[0];
    groups[primary].push(suggestion);
    for (let i = matching.length - 1; i > 0; i--) {
      const mergedIndex = matching[i];
      groups[primary].push(...groups[mergedIndex]);
      groups.splice(mergedIndex, 1);
    }
  }

  return Object.freeze(
    groups.map((group) => {
      const blockedReasons = [
        ...new Set(group.flatMap((item) => item.blockedReasons)),
      ].sort();
      const classification = strongest(
        group.map((item) => item.classification),
      );
      const state: 'planned' | 'blocked' =
        classification === 'owner-decision' || blockedReasons.length > 0
          ? 'blocked'
          : 'planned';
      const stable = {
        siteIds: Object.freeze(
          [...new Set(group.flatMap((item) => item.siteIds))].sort(),
        ),
        changeFiles: Object.freeze(
          [...new Set(group.flatMap((item) => item.changeFiles))].sort(),
        ),
        couplingFiles: Object.freeze(
          [...new Set(group.flatMap((item) => item.couplingFiles))].sort(),
        ),
        declaredInputs: Object.freeze(
          [...new Set(group.flatMap((item) => item.declaredInputs))].sort(),
        ),
        factIds: Object.freeze(
          [...new Set(group.flatMap((item) => item.factIds))].sort(),
        ),
        classification,
        routingReasons: Object.freeze(
          [...new Set(group.flatMap((item) => item.routingReasons))].sort(),
        ),
        state,
        blockedReasons: Object.freeze(blockedReasons),
      };
      return Object.freeze({ id: identity(stable), ...stable });
    }),
  );
}

export function detectClusterConflicts(
  clusters: $ReadOnlyArray<Cluster>,
): $ReadOnlyArray<ClusterConflict> {
  const owners = new Map<string, Array<string>>();
  for (const cluster of clusters) {
    for (const file of cluster.changeFiles) {
      const current = owners.get(file) ?? [];
      current.push(cluster.id);
      owners.set(file, current);
    }
  }
  return Object.freeze(
    [...owners.entries()]
      .filter(([, clusterIds]) => new Set(clusterIds).size > 1)
      .map(([file, clusterIds]) =>
        Object.freeze({
          path: file,
          clusterIds: Object.freeze([...new Set(clusterIds)].sort()),
        }),
      )
      .sort((a, b) => a.path.localeCompare(b.path)),
  );
}

function planCounts(clusters: $ReadOnlyArray<Cluster>): PlanCounts {
  const classification = {
    mechanical: 0,
    'repeatable-contextual': 0,
    'bespoke-contextual': 0,
    'owner-decision': 0,
  };
  const state = { planned: 0, blocked: 0 };
  for (const cluster of clusters) {
    classification[cluster.classification]++;
    state[cluster.state]++;
  }
  return Object.freeze({
    classification: Object.freeze(classification),
    state: Object.freeze(state),
  });
}

export function createPlan({
  inventory,
  now = () => new Date().toISOString(),
}: {
  +inventory: Inventory,
  +now?: () => string,
}): Plan {
  const clusters = mergeSuggestions(suggestClusters(inventory));
  const conflicts = detectClusterConflicts(clusters);
  if (conflicts.length > 0) {
    throw new Error('cluster merge left conflicting change ownership');
  }
  const counts = planCounts(clusters);
  const stable = {
    inventoryId: inventory.id,
    clusters,
    conflicts,
    counts,
    diagnosticCount: inventory.diagnostics.length,
  };
  return Object.freeze({
    id: identity(stable),
    ...stable,
    generatedAt: now(),
  });
}

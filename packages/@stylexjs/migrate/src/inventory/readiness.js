/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import type { Classification, Inventory } from './model';

export type ReadinessSummary = {
  +styled: {
    +definitions: number,
    +files: number,
    +plannedSites: number,
    +targets: { +intrinsic: number, +component: number, +unknown: number },
    +syntax: { +call: number, +'tagged-template': number },
    +styleForms: { +[string]: number },
    +callbacks: number,
    +themeDependent: number,
    +propDependent: number,
    +withOptions: number,
    +withShouldForwardProp: number,
  },
  +theme: {
    +definitions: number,
    +providers: number,
    +reads: number,
    +files: number,
  },
  +cssProps: {
    +total: number,
    +classification: { +[Classification]: number },
  },
  +samples: $ReadOnlyArray<{
    +factId: string,
    +file: string,
    +name: string,
    +targetKind: string,
    +targetName: string | null,
    +syntax: string,
    +styleForms: $ReadOnlyArray<string>,
    +themeDependent: boolean,
    +propDependent: boolean,
    +hasOptions: boolean,
    +hasShouldForwardProp: boolean,
  }>,
  +limitations: $ReadOnlyArray<string>,
};

function bump(counts: { [string]: number }, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function inventoryReadiness(
  inventory: Inventory,
  options?: { +sampleLimit?: number },
): ReadinessSummary {
  const targetCounts = { intrinsic: 0, component: 0, unknown: 0 };
  const syntaxCounts = { call: 0, 'tagged-template': 0 };
  const styleForms: { [string]: number } = {};
  const styledFiles = new Set<string>();
  const themeFiles = new Set<string>();
  const samples = [];
  let definitions = 0;
  let callbacks = 0;
  let themeDependent = 0;
  let propDependent = 0;
  let withOptions = 0;
  let withShouldForwardProp = 0;
  let themeDefinitions = 0;
  let providers = 0;
  let reads = 0;

  for (const fact of inventory.facts) {
    const file = fact.inputFiles[0] ?? '(unknown)';
    if (fact.kind === 'theme-definition') {
      themeDefinitions++;
      themeFiles.add(file);
    } else if (fact.kind === 'theme-provider') {
      providers++;
      themeFiles.add(file);
    } else if (fact.kind === 'theme-read') {
      reads++;
      themeFiles.add(file);
    }
    if (fact.kind !== 'emotion-styled-readiness') continue;
    const value: $FlowFixMe = fact.value;
    definitions++;
    styledFiles.add(file);
    if (value.targetKind in targetCounts) targetCounts[value.targetKind]++;
    else targetCounts.unknown++;
    if (value.syntax in syntaxCounts) syntaxCounts[value.syntax]++;
    for (const form of value.styleForms ?? []) bump(styleForms, String(form));
    if (value.callback === true) callbacks++;
    if (value.themeDependent === true) themeDependent++;
    if (value.propDependent === true) propDependent++;
    if (value.hasOptions === true) withOptions++;
    if (value.hasShouldForwardProp === true) withShouldForwardProp++;
    samples.push({
      factId: fact.id,
      file,
      name: String(value.name ?? '(anonymous)'),
      targetKind: String(value.targetKind ?? 'unknown'),
      targetName:
        typeof value.targetName === 'string' ? value.targetName : null,
      syntax: String(value.syntax ?? 'unknown'),
      styleForms: Object.freeze(
        (value.styleForms ?? []).map((form) => String(form)),
      ),
      themeDependent: value.themeDependent === true,
      propDependent: value.propDependent === true,
      hasOptions: value.hasOptions === true,
      hasShouldForwardProp: value.hasShouldForwardProp === true,
    });
  }

  const classification = {
    mechanical: 0,
    'repeatable-contextual': 0,
    'bespoke-contextual': 0,
    'owner-decision': 0,
  };
  const cssPropSites = inventory.sites.filter(
    (site) => site.adapter === 'emotion' && site.kind === 'css-prop',
  );
  for (const site of cssPropSites) classification[site.classification]++;
  const sampleLimit = options?.sampleLimit ?? 20;
  if (!Number.isInteger(sampleLimit) || sampleLimit < 0) {
    throw new Error('Readiness sample limit must be a non-negative integer');
  }
  samples.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.name.localeCompare(right.name),
  );

  return Object.freeze({
    styled: Object.freeze({
      definitions,
      files: styledFiles.size,
      // Styled facts are readiness observations only. M10B must build the
      // definition/consumer graph before they become plan-owned sites.
      plannedSites: 0,
      targets: Object.freeze(targetCounts),
      syntax: Object.freeze(syntaxCounts),
      styleForms: Object.freeze(
        Object.fromEntries(
          Object.entries(styleForms).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      ),
      callbacks,
      themeDependent,
      propDependent,
      withOptions,
      withShouldForwardProp,
    }),
    theme: Object.freeze({
      definitions: themeDefinitions,
      providers,
      reads,
      files: themeFiles.size,
    }),
    cssProps: Object.freeze({
      total: cssPropSites.length,
      classification: Object.freeze(classification),
    }),
    samples: Object.freeze(
      samples.slice(0, sampleLimit).map((sample) => Object.freeze(sample)),
    ),
    limitations: Object.freeze([
      'styled counts are binding-backed syntax observations, not convertible sites or semantic claims',
      'styled definitions with any shadowing of the imported binding are omitted conservatively',
      'consumer graphs, component selectors, inherited contracts, refs, polymorphism, static properties, and runtime behavior are not resolved yet',
      'theme-dependent and prop-dependent counts are conservative callback syntax signals',
      'counts are absolute observations, not a coverage or safety claim',
    ]),
  });
}

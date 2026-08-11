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
    +closedTemplates: number,
    +intrinsicClosedTemplates: number,
    +componentClosedTemplates: number,
    +callbacks: number,
    +themeDependent: number,
    +propDependent: number,
    +withOptions: number,
    +withShouldForwardProp: number,
    +usageGraphs: number,
    +firstSliceEligible: number,
    +directJsxConsumers: number,
    +withEscapes: number,
    +blockedReasons: { +[string]: number },
    +templateGrammarFacts: number,
    +flatTemplateGrammarEligible: number,
    +templateGrammarBlockedReasons: { +[string]: number },
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
    +templateExpressions: number | null,
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
  let closedTemplates = 0;
  let intrinsicClosedTemplates = 0;
  let componentClosedTemplates = 0;
  let themeDependent = 0;
  let propDependent = 0;
  let withOptions = 0;
  let withShouldForwardProp = 0;
  let usageGraphs = 0;
  let firstSliceEligible = 0;
  let directJsxConsumers = 0;
  let withEscapes = 0;
  const blockedReasons = {};
  let templateGrammarFacts = 0;
  let flatTemplateGrammarEligible = 0;
  const templateGrammarBlockedReasons = {};
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
    if (fact.kind === 'emotion-styled-usage') {
      const usage: $FlowFixMe = fact.value;
      usageGraphs++;
      directJsxConsumers += (usage.consumers ?? []).length;
      if (usage.firstSliceEligible === true) firstSliceEligible++;
      if ((usage.escapes ?? []).length > 0) withEscapes++;
      for (const reason of usage.blockedReasons ?? []) {
        bump(blockedReasons, String(reason));
      }
      continue;
    }
    if (fact.kind === 'emotion-styled-template-grammar') {
      const grammar: $FlowFixMe = fact.value;
      templateGrammarFacts++;
      if (grammar.supported === true) flatTemplateGrammarEligible++;
      else bump(templateGrammarBlockedReasons, String(grammar.reason));
      continue;
    }
    if (fact.kind !== 'emotion-styled-readiness') continue;
    const value: $FlowFixMe = fact.value;
    definitions++;
    styledFiles.add(file);
    if (value.targetKind in targetCounts) targetCounts[value.targetKind]++;
    else targetCounts.unknown++;
    if (value.syntax in syntaxCounts) syntaxCounts[value.syntax]++;
    for (const form of value.styleForms ?? []) bump(styleForms, String(form));
    if (value.syntax === 'tagged-template' && value.templateExpressions === 0) {
      closedTemplates++;
      if (value.targetKind === 'intrinsic') intrinsicClosedTemplates++;
      if (value.targetKind === 'component') componentClosedTemplates++;
    }
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
      templateExpressions:
        typeof value.templateExpressions === 'number'
          ? value.templateExpressions
          : null,
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
  const styledSites = inventory.sites.filter(
    (site) => site.adapter === 'emotion' && site.kind === 'styled-intrinsic',
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
  const sortedBlockedReasons: { [string]: number } = {};
  for (const reason of Object.keys(blockedReasons).sort()) {
    sortedBlockedReasons[reason] = blockedReasons[reason];
  }
  const sortedTemplateGrammarBlockedReasons: { [string]: number } = {};
  for (const reason of Object.keys(templateGrammarBlockedReasons).sort()) {
    sortedTemplateGrammarBlockedReasons[reason] =
      templateGrammarBlockedReasons[reason];
  }

  return Object.freeze({
    styled: Object.freeze({
      definitions,
      files: styledFiles.size,
      plannedSites: styledSites.length,
      targets: Object.freeze(targetCounts),
      syntax: Object.freeze(syntaxCounts),
      styleForms: Object.freeze(
        Object.fromEntries(
          Object.entries(styleForms).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      ),
      closedTemplates,
      intrinsicClosedTemplates,
      componentClosedTemplates,
      callbacks,
      themeDependent,
      propDependent,
      withOptions,
      withShouldForwardProp,
      usageGraphs,
      firstSliceEligible,
      directJsxConsumers,
      withEscapes,
      blockedReasons: Object.freeze(sortedBlockedReasons),
      templateGrammarFacts,
      flatTemplateGrammarEligible,
      templateGrammarBlockedReasons: Object.freeze(
        sortedTemplateGrammarBlockedReasons,
      ),
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
      'usage graphs cover same-file bindings only; cross-file consumers, inherited contracts, and runtime behavior are not resolved',
      'flat template grammar eligibility is a syntax boundary, not StyleX acceptance or semantic evidence',
      'theme-dependent and prop-dependent counts are conservative callback syntax signals',
      'counts are absolute observations, not a coverage or safety claim',
    ]),
  });
}

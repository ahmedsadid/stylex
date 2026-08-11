/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { canonicalJson, immutableJson } from '../state/json';
import type { JsonValue } from '../state/json';

export const RUNTIME_PROTOCOL_VERSION: string = 'stylex-migrate-runtime-v1';

export type RuntimeViewport = {
  +width: number,
  +height: number,
  +deviceScaleFactor: number,
};

export type RuntimeCaseDefinition = {
  +id: string,
  +changePaths: $ReadOnlyArray<string>,
  +siteIds: $ReadOnlyArray<string>,
  +theme: string,
  +interaction: string,
  +viewport: RuntimeViewport,
};

export type RuntimeEnvironment = {
  +renderer: string,
  +rendererVersion: string,
  +browser: string,
  +browserVersion: string,
  +platform: string,
};

export type RuntimeObservation = {
  +computedStyles: { +[target: string]: { +[property: string]: string } },
  +dom: { +[target: string]: JsonValue },
  +attributes: {
    +[target: string]: { +[name: string]: string | null },
  },
  +refs: { +[name: string]: JsonValue },
  +interactions: { +[name: string]: JsonValue },
};

export type RuntimeCaseObservation = {
  +id: string,
  +observation: RuntimeObservation,
};

export type RuntimeObservationReport = {
  +protocolVersion: string,
  +environment: RuntimeEnvironment,
  +cases: $ReadOnlyArray<RuntimeCaseObservation>,
};

export type RuntimeDifference = {
  +category: 'computedStyles' | 'dom' | 'attributes' | 'refs' | 'interactions',
  +path: string,
  +baseline: JsonValue | void,
  +candidate: JsonValue | void,
};

export type RuntimeCaseComparison = {
  +id: string,
  +changePaths: $ReadOnlyArray<string>,
  +siteIds: $ReadOnlyArray<string>,
  +theme: string,
  +interaction: string,
  +viewport: RuntimeViewport,
  +result: 'matched' | 'different' | 'missing',
  +differences: $ReadOnlyArray<RuntimeDifference>,
};

export type RuntimeComparison = {
  +protocolVersion: string,
  +result: 'matched' | 'different' | 'incomplete' | 'incomparable',
  +environment: RuntimeEnvironment | null,
  +cases: $ReadOnlyArray<RuntimeCaseComparison>,
  +coverage: {
    +expectedCaseIds: $ReadOnlyArray<string>,
    +observedCaseIds: $ReadOnlyArray<string>,
    +matchedCaseIds: $ReadOnlyArray<string>,
    +differentCaseIds: $ReadOnlyArray<string>,
    +missingCaseIds: $ReadOnlyArray<string>,
    +unexpectedCaseIds: $ReadOnlyArray<string>,
  },
  +limitations: $ReadOnlyArray<string>,
};

const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CATEGORIES: $ReadOnlyArray<RuntimeDifference['category']> = [
  'computedStyles',
  'dom',
  'attributes',
  'refs',
  'interactions',
];

function object(value: mixed): boolean {
  return value != null && !Array.isArray(value) && typeof value === 'object';
}

function strings(value: mixed): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item !== '')
  );
}

function validJson(value: mixed): boolean {
  if (
    value == null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(validJson);
  }
  return object(value) && Object.values(value as any).every(validJson);
}

function normalizeViewport(value: mixed): RuntimeViewport {
  const viewport: $FlowFixMe = value;
  if (
    !object(viewport) ||
    typeof viewport.width !== 'number' ||
    !Number.isInteger(viewport.width) ||
    viewport.width < 1 ||
    typeof viewport.height !== 'number' ||
    !Number.isInteger(viewport.height) ||
    viewport.height < 1 ||
    typeof viewport.deviceScaleFactor !== 'number' ||
    !Number.isFinite(viewport.deviceScaleFactor) ||
    viewport.deviceScaleFactor <= 0
  ) {
    throw new Error('Invalid runtime viewport');
  }
  return Object.freeze({
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
  });
}

export function normalizeRuntimeCases(
  values: mixed,
): $ReadOnlyArray<RuntimeCaseDefinition> {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Runtime evidence requires at least one declared case');
  }
  const cases = values.map((value) => {
    const item: $FlowFixMe = value;
    if (
      !object(item) ||
      typeof item.id !== 'string' ||
      !CASE_ID.test(item.id) ||
      !strings(item.changePaths) ||
      item.changePaths.length === 0 ||
      !strings(item.siteIds) ||
      item.siteIds.length === 0 ||
      typeof item.theme !== 'string' ||
      item.theme === '' ||
      typeof item.interaction !== 'string' ||
      item.interaction === ''
    ) {
      throw new Error('Invalid runtime case definition');
    }
    return Object.freeze({
      id: item.id,
      changePaths: Object.freeze([...new Set(item.changePaths)].sort()),
      siteIds: Object.freeze([...new Set(item.siteIds)].sort()),
      theme: item.theme,
      interaction: item.interaction,
      viewport: normalizeViewport(item.viewport),
    });
  });
  if (new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw new Error('Runtime case ids must be unique');
  }
  return Object.freeze(
    cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );
}

function normalizeEnvironment(value: mixed): RuntimeEnvironment {
  const environment: $FlowFixMe = value;
  if (
    !object(environment) ||
    typeof environment.renderer !== 'string' ||
    environment.renderer === '' ||
    typeof environment.rendererVersion !== 'string' ||
    environment.rendererVersion === '' ||
    typeof environment.browser !== 'string' ||
    environment.browser === '' ||
    typeof environment.browserVersion !== 'string' ||
    environment.browserVersion === '' ||
    typeof environment.platform !== 'string' ||
    environment.platform === ''
  ) {
    throw new Error('Invalid runtime environment');
  }
  return Object.freeze({
    renderer: environment.renderer,
    rendererVersion: environment.rendererVersion,
    browser: environment.browser,
    browserVersion: environment.browserVersion,
    platform: environment.platform,
  });
}

function stringMap(value: mixed): boolean {
  return (
    object(value) &&
    Object.values(value as any).every((item) => typeof item === 'string')
  );
}

function normalizeObservation(value: mixed): RuntimeObservation {
  const observation: $FlowFixMe = value;
  if (
    !object(observation) ||
    !object(observation.computedStyles) ||
    !Object.values(observation.computedStyles).every(stringMap) ||
    !object(observation.dom) ||
    !Object.values(observation.dom).every(validJson) ||
    !object(observation.attributes) ||
    !Object.values(observation.attributes).every(
      (attributes) =>
        object(attributes) &&
        Object.values(attributes).every(
          (attribute) => attribute === null || typeof attribute === 'string',
        ),
    ) ||
    !object(observation.refs) ||
    !Object.values(observation.refs).every(validJson) ||
    !object(observation.interactions) ||
    !Object.values(observation.interactions).every(validJson)
  ) {
    throw new Error('Invalid runtime observation');
  }
  return immutableJson(observation) as $FlowFixMe;
}

export function normalizeRuntimeReport(value: mixed): RuntimeObservationReport {
  const report: $FlowFixMe = value;
  if (
    !object(report) ||
    report.protocolVersion !== RUNTIME_PROTOCOL_VERSION ||
    !Array.isArray(report.cases)
  ) {
    throw new Error('Invalid runtime observation report');
  }
  const cases = report.cases.map((item) => {
    if (
      !object(item) ||
      typeof item.id !== 'string' ||
      !CASE_ID.test(item.id)
    ) {
      throw new Error('Invalid runtime case observation');
    }
    return Object.freeze({
      id: item.id,
      observation: normalizeObservation(item.observation),
    });
  });
  if (new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw new Error('Runtime observation case ids must be unique');
  }
  return Object.freeze({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    environment: normalizeEnvironment(report.environment),
    cases: Object.freeze(
      cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    ),
  });
}

function escaped(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function differences(
  category: RuntimeDifference['category'],
  baseline: JsonValue | void,
  candidate: JsonValue | void,
  currentPath: string,
  output: Array<RuntimeDifference>,
): void {
  if (baseline === undefined || candidate === undefined) {
    output.push({
      category,
      path: currentPath,
      baseline,
      candidate,
    });
    return;
  }
  if (canonicalJson(baseline) === canonicalJson(candidate)) {
    return;
  }
  if (
    baseline == null ||
    candidate == null ||
    typeof baseline !== 'object' ||
    typeof candidate !== 'object' ||
    Array.isArray(baseline) ||
    Array.isArray(candidate)
  ) {
    output.push({
      category,
      path: currentPath,
      baseline,
      candidate,
    });
    return;
  }
  for (const key of [
    ...new Set([...Object.keys(baseline), ...Object.keys(candidate)]),
  ].sort()) {
    differences(
      category,
      baseline[key],
      candidate[key],
      `${currentPath}/${escaped(key)}`,
      output,
    );
  }
}

export function compareRuntimeReports({
  cases: inputCases,
  baseline: inputBaseline,
  candidate: inputCandidate,
}: {
  +cases: $ReadOnlyArray<RuntimeCaseDefinition>,
  +baseline: RuntimeObservationReport,
  +candidate: RuntimeObservationReport,
}): RuntimeComparison {
  const cases = normalizeRuntimeCases(inputCases);
  const baseline = normalizeRuntimeReport(inputBaseline);
  const candidate = normalizeRuntimeReport(inputCandidate);
  const expectedCaseIds = cases.map((item) => item.id);
  const baselineById = new Map(baseline.cases.map((item) => [item.id, item]));
  const candidateById = new Map(candidate.cases.map((item) => [item.id, item]));
  const observedCaseIds = [
    ...new Set([...baselineById.keys(), ...candidateById.keys()]),
  ].sort();
  const unexpectedCaseIds = observedCaseIds.filter(
    (id) => !expectedCaseIds.includes(id),
  );
  const missingCaseIds = expectedCaseIds.filter(
    (id) => !baselineById.has(id) || !candidateById.has(id),
  );
  const matchedCaseIds = [];
  const differentCaseIds = [];
  const comparisons = cases.map((definition) => {
    const before = baselineById.get(definition.id);
    const after = candidateById.get(definition.id);
    const foundDifferences: Array<RuntimeDifference> = [];
    if (before != null && after != null) {
      for (const category of CATEGORIES) {
        differences(
          category,
          before.observation[category] as $FlowFixMe,
          after.observation[category] as $FlowFixMe,
          '',
          foundDifferences,
        );
      }
    }
    let result;
    if (before == null || after == null) {
      result = 'missing';
    } else if (foundDifferences.length > 0) {
      result = 'different';
      differentCaseIds.push(definition.id);
    } else {
      result = 'matched';
      matchedCaseIds.push(definition.id);
    }
    return Object.freeze({
      ...definition,
      result,
      differences: Object.freeze(foundDifferences),
    });
  });
  const sameEnvironment =
    canonicalJson(baseline.environment as $FlowFixMe) ===
    canonicalJson(candidate.environment as $FlowFixMe);
  let result;
  if (!sameEnvironment) {
    result = 'incomparable';
  } else if (missingCaseIds.length > 0 || unexpectedCaseIds.length > 0) {
    result = 'incomplete';
  } else if (differentCaseIds.length > 0) {
    result = 'different';
  } else {
    result = 'matched';
  }
  const limitations = [];
  if (!sameEnvironment) {
    limitations.push(
      'Baseline and candidate used different runtime environments.',
    );
  }
  if (missingCaseIds.length > 0) {
    limitations.push(`Missing runtime cases: ${missingCaseIds.join(', ')}.`);
  }
  if (unexpectedCaseIds.length > 0) {
    limitations.push(
      `Unexpected runtime cases: ${unexpectedCaseIds.join(', ')}.`,
    );
  }
  limitations.push(
    'Runtime comparison covers only the recorded cases, states, viewports, and environment.',
  );
  return Object.freeze({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    result,
    environment: sameEnvironment ? baseline.environment : null,
    cases: Object.freeze(comparisons),
    coverage: Object.freeze({
      expectedCaseIds: Object.freeze(expectedCaseIds),
      observedCaseIds: Object.freeze(observedCaseIds),
      matchedCaseIds: Object.freeze(matchedCaseIds),
      differentCaseIds: Object.freeze(differentCaseIds),
      missingCaseIds: Object.freeze(missingCaseIds),
      unexpectedCaseIds: Object.freeze(unexpectedCaseIds),
    }),
    limitations: Object.freeze(limitations),
  }) as $FlowFixMe;
}

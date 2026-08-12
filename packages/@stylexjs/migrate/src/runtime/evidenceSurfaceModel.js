/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import path from 'path';
import { immutableJson } from '../state/json';
import {
  normalizeExpectedRuntimeObservations,
  normalizeRuntimeCases,
} from './model';
import type {
  RuntimeCaseDefinition,
  RuntimeExpectedObservations,
} from './model';

export const EVIDENCE_SURFACE_PROTOCOL_VERSION: string =
  'stylex-migrate-evidence-surface-v2';
export const SYNTHETIC_CSS_EXPECTATIONS_PROTOCOL_VERSION: string =
  'stylex-migrate-synthetic-css-expectations-v1';

export type RuntimeProbeAction = {
  +id: string,
  +kind:
    | 'set-attribute'
    | 'remove-attribute'
    | 'add-class'
    | 'remove-class'
    | 'click'
    | 'hover',
  +selector: string,
  +name: string | null,
  +value: string | null,
};

export type RuntimeProbeTarget = {
  +id: string,
  +selector: string,
  +computedProperties: $ReadOnlyArray<string>,
  +attributes: $ReadOnlyArray<string>,
  +observeDom: boolean,
  +observeRef: boolean,
};

export type RuntimeProbeCase = RuntimeCaseDefinition & {
  +path: string,
  +actions: $ReadOnlyArray<RuntimeProbeAction>,
  +targets: $ReadOnlyArray<RuntimeProbeTarget>,
};

export type RuntimeSyntheticCssExpectations = {
  +protocolVersion: string,
  +source: {
    +kind: 'theme-decision-draft',
    +id: string,
    +definitionHash: string,
  },
  +cases: $ReadOnlyArray<{
    +id: string,
    +computedStyles: {
      +[target: string]: { +[property: string]: string },
    },
  }>,
};

export type EvidenceSurfaceDefinition = {
  +protocolVersion: string,
  +packageRoot: string,
  +playwrightPackage: 'playwright' | '@playwright/test',
  +nativeSurfaceDisposition: 'none-known' | 'known-insufficient',
  +server: {
    +argv: $ReadOnlyArray<string>,
    +cwd: string,
    +inputFiles: $ReadOnlyArray<string>,
    +url: string,
    +timeoutMs: number,
  },
  +cases: $ReadOnlyArray<RuntimeProbeCase>,
  +expectedObservations: RuntimeExpectedObservations | null,
  +syntheticCssExpectations: RuntimeSyntheticCssExpectations | null,
  +rationale: string,
  +limitations: $ReadOnlyArray<string>,
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CSS_PROPERTY = /^--[A-Za-z0-9_-]+$|^[A-Za-z][A-Za-z0-9]*$/;

function object(value: mixed): boolean {
  return value != null && !Array.isArray(value) && typeof value === 'object';
}

function text(value: mixed, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.includes('\0')
  ) {
    throw new Error(`Evidence surface requires a non-empty ${label}`);
  }
  return value.trim();
}

function relative(value: mixed, label: string, allowRoot: boolean): string {
  if (allowRoot && value === '.') return '.';
  const result = text(value, label);
  if (
    result.includes('\\') ||
    path.posix.isAbsolute(result) ||
    path.posix.normalize(result) !== result ||
    result.split('/').some((segment) => segment === '' || segment === '..')
  ) {
    throw new Error(`Invalid evidence-surface ${label}: ${result}`);
  }
  return result;
}

function texts(value: mixed, label: string): $ReadOnlyArray<string> {
  if (!Array.isArray(value)) {
    throw new Error(`Evidence surface requires ${label}`);
  }
  return Object.freeze(
    [...new Set(value.map((item) => text(item, label)))].sort(),
  );
}

function argv(value: mixed): $ReadOnlyArray<string> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Evidence surface requires a server argv array');
  }
  return Object.freeze(value.map((item) => text(item, 'server argument')));
}

function action(value: mixed): RuntimeProbeAction {
  if (!object(value)) throw new Error('Invalid runtime-probe action');
  const input: $FlowFixMe = value;
  const id = text(input.id, 'action id');
  const kind: RuntimeProbeAction['kind'] = input.kind;
  const selector = text(input.selector, 'action selector');
  if (
    !ID.test(id) ||
    ![
      'set-attribute',
      'remove-attribute',
      'add-class',
      'remove-class',
      'click',
      'hover',
    ].includes(kind)
  ) {
    throw new Error('Invalid runtime-probe action');
  }
  const needsName = [
    'set-attribute',
    'remove-attribute',
    'add-class',
    'remove-class',
  ].includes(kind);
  const needsValue = kind === 'set-attribute';
  return Object.freeze({
    id,
    kind,
    selector,
    name: needsName ? text(input.name, 'action name') : null,
    value: needsValue ? text(input.value, 'action value') : null,
  });
}

function target(value: mixed): RuntimeProbeTarget {
  if (!object(value)) throw new Error('Invalid runtime-probe target');
  const input: $FlowFixMe = value;
  const id = text(input.id, 'target id');
  const computedProperties = texts(
    input.computedProperties,
    'target computed properties',
  );
  if (
    !ID.test(id) ||
    computedProperties.length === 0 ||
    computedProperties.some((property) => !CSS_PROPERTY.test(property))
  ) {
    throw new Error('Invalid runtime-probe target');
  }
  return Object.freeze({
    id,
    selector: text(input.selector, 'target selector'),
    computedProperties,
    attributes: texts(input.attributes ?? [], 'target attributes'),
    observeDom:
      input.observeDom == null
        ? true
        : input.observeDom === true
          ? true
          : input.observeDom === false
            ? false
            : (() => {
                throw new Error('Invalid runtime-probe DOM observation flag');
              })(),
    observeRef:
      input.observeRef == null
        ? true
        : input.observeRef === true
          ? true
          : input.observeRef === false
            ? false
            : (() => {
                throw new Error('Invalid runtime-probe ref observation flag');
              })(),
  });
}

export function normalizeSyntheticCssExpectations(
  value: mixed,
): RuntimeSyntheticCssExpectations {
  if (!object(value)) throw new Error('Invalid synthetic CSS expectations');
  const input: $FlowFixMe = value;
  if (
    input.protocolVersion !== SYNTHETIC_CSS_EXPECTATIONS_PROTOCOL_VERSION ||
    !object(input.source) ||
    input.source.kind !== 'theme-decision-draft' ||
    typeof input.source.id !== 'string' ||
    !/^theme-draft-[a-f0-9]{16}$/.test(input.source.id) ||
    typeof input.source.definitionHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.source.definitionHash) ||
    !Array.isArray(input.cases) ||
    input.cases.length === 0
  ) {
    throw new Error('Invalid synthetic CSS expectations');
  }
  const cases = input.cases.map((value) => {
    if (!object(value)) throw new Error('Invalid synthetic CSS case');
    const item: $FlowFixMe = value;
    if (!ID.test(item.id) || !object(item.computedStyles)) {
      throw new Error('Invalid synthetic CSS case');
    }
    const computedStyles = Object.fromEntries(
      Object.entries(item.computedStyles)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([targetId, properties]) => {
          if (!ID.test(targetId) || !object(properties)) {
            throw new Error('Invalid synthetic CSS target');
          }
          const normalized = Object.fromEntries(
            Object.entries(properties)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([property, rawValue]) => {
                if (
                  !CSS_PROPERTY.test(property) ||
                  typeof rawValue !== 'string' ||
                  rawValue.trim() === '' ||
                  rawValue.includes('\0')
                ) {
                  throw new Error('Invalid synthetic CSS declaration');
                }
                return [property, rawValue];
              }),
          );
          if (Object.keys(normalized).length === 0) {
            throw new Error('Synthetic CSS targets require declarations');
          }
          return [targetId, normalized];
        }),
    );
    if (Object.keys(computedStyles).length === 0) {
      throw new Error('Synthetic CSS cases require targets');
    }
    return Object.freeze({ id: item.id, computedStyles });
  });
  if (new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw new Error('Synthetic CSS case ids must be unique');
  }
  return immutableJson({
    protocolVersion: SYNTHETIC_CSS_EXPECTATIONS_PROTOCOL_VERSION,
    source: input.source,
    cases: cases.sort((left, right) => left.id.localeCompare(right.id)),
  }) as $FlowFixMe;
}

export function normalizeEvidenceSurfaceDefinition(
  value: mixed,
): EvidenceSurfaceDefinition {
  if (!object(value)) throw new Error('Invalid evidence-surface definition');
  const input: $FlowFixMe = value;
  if (
    input.protocolVersion !== EVIDENCE_SURFACE_PROTOCOL_VERSION ||
    (input.playwrightPackage !== 'playwright' &&
      input.playwrightPackage !== '@playwright/test') ||
    (input.nativeSurfaceDisposition !== 'none-known' &&
      input.nativeSurfaceDisposition !== 'known-insufficient') ||
    !object(input.server) ||
    !Array.isArray(input.cases) ||
    input.cases.length === 0
  ) {
    throw new Error('Invalid evidence-surface definition');
  }
  const serverUrl = text(input.server.url, 'server URL');
  let parsedUrl;
  try {
    parsedUrl = new URL(serverUrl);
  } catch (_error) {
    throw new Error('Evidence-surface server URL is invalid');
  }
  if (
    parsedUrl.protocol !== 'http:' ||
    (parsedUrl.hostname !== '127.0.0.1' && parsedUrl.hostname !== 'localhost')
  ) {
    throw new Error('Evidence-surface server URL must use local HTTP');
  }
  const timeoutMs = input.server.timeoutMs;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 15 * 60 * 1000
  ) {
    throw new Error('Invalid evidence-surface server timeout');
  }
  const runtimeCases = normalizeRuntimeCases(input.cases);
  const definitions = new Map(runtimeCases.map((item) => [item.id, item]));
  const cases = input.cases.map((value) => {
    if (!object(value)) throw new Error('Invalid runtime-probe case');
    const source: $FlowFixMe = value;
    const definition = definitions.get(source.id);
    if (
      definition == null ||
      !Array.isArray(source.actions) ||
      !Array.isArray(source.targets) ||
      source.targets.length === 0
    ) {
      throw new Error('Invalid runtime-probe case');
    }
    const actions = source.actions.map(action);
    const targets = source.targets.map(target);
    if (
      new Set(actions.map((item) => item.id)).size !== actions.length ||
      new Set(targets.map((item) => item.id)).size !== targets.length
    ) {
      throw new Error('Runtime-probe action and target ids must be unique');
    }
    return Object.freeze({
      ...definition,
      path: text(source.path, 'case URL path'),
      actions: Object.freeze(actions),
      targets: Object.freeze(targets),
    });
  });
  const hasLockedExpectations = input.expectedObservations != null;
  const hasSyntheticExpectations = input.syntheticCssExpectations != null;
  if (hasLockedExpectations === hasSyntheticExpectations) {
    throw new Error(
      'Evidence surfaces require exactly one locked or synthetic expectation source',
    );
  }
  const expectedObservations = hasLockedExpectations
    ? normalizeExpectedRuntimeObservations(input.expectedObservations)
    : null;
  const normalizedSynthetic = hasSyntheticExpectations
    ? normalizeSyntheticCssExpectations(input.syntheticCssExpectations)
    : null;
  const caseIds = cases.map((item) => item.id).sort();
  const expectedIds = (
    expectedObservations?.cases ??
    normalizedSynthetic?.cases ??
    []
  )
    .map((item) => item.id)
    .sort();
  if (
    caseIds.length !== expectedIds.length ||
    caseIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new Error('Evidence-surface cases and expected observations differ');
  }
  if (normalizedSynthetic != null) {
    const syntheticById = new Map(
      normalizedSynthetic.cases.map((item) => [item.id, item]),
    );
    for (const runtimeCase of cases) {
      const expectedCase = syntheticById.get(runtimeCase.id);
      if (expectedCase == null) {
        throw new Error('Synthetic CSS expectations are incomplete');
      }
      const targetsById = new Map(
        runtimeCase.targets.map((item) => [item.id, item]),
      );
      const expectedTargetIds = Object.keys(expectedCase.computedStyles).sort();
      const targetIds = runtimeCase.targets.map((item) => item.id).sort();
      if (
        targetIds.length !== expectedTargetIds.length ||
        targetIds.some((id, index) => id !== expectedTargetIds[index])
      ) {
        throw new Error('Synthetic CSS targets differ from probe targets');
      }
      for (const [targetId, properties] of Object.entries(
        expectedCase.computedStyles,
      )) {
        const probeTarget = targetsById.get(targetId);
        const expectedProperties = Object.keys(properties).sort();
        if (
          probeTarget == null ||
          probeTarget.observeDom ||
          probeTarget.observeRef ||
          probeTarget.attributes.length > 0 ||
          probeTarget.computedProperties.length !== expectedProperties.length ||
          probeTarget.computedProperties.some(
            (property, index) => property !== expectedProperties[index],
          )
        ) {
          throw new Error(
            'Synthetic CSS probes may compare only their exact computed declarations',
          );
        }
      }
    }
  }
  return immutableJson({
    protocolVersion: EVIDENCE_SURFACE_PROTOCOL_VERSION,
    packageRoot: relative(input.packageRoot, 'package root', true),
    playwrightPackage: input.playwrightPackage,
    nativeSurfaceDisposition: input.nativeSurfaceDisposition,
    server: {
      argv: argv(input.server.argv),
      cwd: relative(input.server.cwd, 'server cwd', true),
      inputFiles: Object.freeze(
        texts(input.server.inputFiles, 'server input files').map((file) =>
          relative(file, 'server input file', false),
        ),
      ),
      url: parsedUrl.toString(),
      timeoutMs,
    },
    cases: cases.sort((left, right) => left.id.localeCompare(right.id)),
    expectedObservations,
    syntheticCssExpectations: normalizedSynthetic,
    rationale: text(input.rationale, 'rationale'),
    limitations: texts(input.limitations, 'limitations'),
  }) as $FlowFixMe;
}

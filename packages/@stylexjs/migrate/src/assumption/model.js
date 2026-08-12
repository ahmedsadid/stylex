/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import path from 'path';
import { hashString, shortHash } from '../kernel/hash';
import { canonicalJson, immutableJson } from '../state/json';

export const TEST_ASSUMPTION_PROTOCOL_VERSION: string =
  'stylex-migrate-test-assumption-v1';

export type TestAssumptionFactStatus =
  | 'known'
  | 'inferred'
  | 'unknown'
  | 'resolution-failed';

export type TestAssumptionFact = {
  +statement: string,
  +status: TestAssumptionFactStatus,
  +inputFiles: $ReadOnlyArray<string>,
  +detail: string,
};

export type TestAssumptionInput = {
  +path: string,
  +contentHash: string | null,
  +mode: string | null,
};

export type TestAssumptionDefinition = {
  +protocolVersion: string,
  +inventoryId: string,
  +baseCommit: string,
  +purpose: string,
  +facts: $ReadOnlyArray<TestAssumptionFact>,
  +declaredInputs: $ReadOnlyArray<TestAssumptionInput>,
  +scope: {
    +files: $ReadOnlyArray<string>,
    +cases: $ReadOnlyArray<string>,
  },
  +rationale: string,
  +alternatives: $ReadOnlyArray<string>,
  +limitations: $ReadOnlyArray<string>,
  +authorKind: 'agent' | 'human',
  +authoredBy: string,
};

export type TestAssumption = TestAssumptionDefinition & {
  +id: string,
  +artifactHash: string,
  +createdAt: string,
};

function object(value: mixed): boolean {
  return value != null && !Array.isArray(value) && typeof value === 'object';
}

function text(value: mixed, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.includes('\0')
  ) {
    throw new Error(`Test assumption requires a non-empty ${label}`);
  }
  return value.trim();
}

function file(value: mixed, label: string): string {
  const result = text(value, label);
  if (
    result.includes('\\') ||
    path.posix.isAbsolute(result) ||
    path.posix.normalize(result) !== result ||
    result.split('/').some((segment) => segment === '' || segment === '..')
  ) {
    throw new Error(`Invalid test-assumption ${label}: ${result}`);
  }
  return result;
}

function texts(value: mixed, label: string): $ReadOnlyArray<string> {
  if (!Array.isArray(value)) {
    throw new Error(`Test assumption requires ${label}`);
  }
  return Object.freeze(
    [...new Set(value.map((item) => text(item, label)))].sort(),
  );
}

function files(value: mixed, label: string): $ReadOnlyArray<string> {
  if (!Array.isArray(value)) {
    throw new Error(`Test assumption requires ${label}`);
  }
  return Object.freeze(
    [...new Set(value.map((item) => file(item, label)))].sort(),
  );
}

function status(value: mixed): TestAssumptionFactStatus {
  switch (value) {
    case 'known':
    case 'inferred':
    case 'unknown':
    case 'resolution-failed':
      return value;
    default:
      throw new Error(`Invalid test-assumption fact status: ${String(value)}`);
  }
}

function normalizeDefinition(value: mixed): TestAssumptionDefinition {
  if (!object(value)) throw new Error('Invalid test assumption');
  const input: $FlowFixMe = value;
  if (
    input.protocolVersion !== TEST_ASSUMPTION_PROTOCOL_VERSION ||
    typeof input.inventoryId !== 'string' ||
    !/^[a-f0-9]{16}$/.test(input.inventoryId) ||
    typeof input.baseCommit !== 'string' ||
    !/^[a-f0-9]{40,64}$/.test(input.baseCommit) ||
    !Array.isArray(input.facts) ||
    input.facts.length === 0 ||
    !Array.isArray(input.declaredInputs) ||
    input.declaredInputs.length === 0 ||
    !object(input.scope) ||
    (input.authorKind !== 'agent' && input.authorKind !== 'human')
  ) {
    throw new Error('Invalid test-assumption definition');
  }
  const facts = input.facts.map((value) => {
    if (!object(value)) throw new Error('Invalid test-assumption fact');
    const fact: $FlowFixMe = value;
    return Object.freeze({
      statement: text(fact.statement, 'fact statement'),
      status: status(fact.status),
      inputFiles: files(fact.inputFiles, 'fact input files'),
      detail: text(fact.detail, 'fact detail'),
    });
  });
  const declaredInputs = input.declaredInputs
    .map((value) => {
      if (!object(value)) throw new Error('Invalid test-assumption input');
      const declared: $FlowFixMe = value;
      const contentHash = declared.contentHash;
      const mode = declared.mode;
      if (
        (contentHash !== null &&
          (typeof contentHash !== 'string' ||
            !/^[a-f0-9]{64}$/.test(contentHash))) ||
        (mode !== null && typeof mode !== 'string')
      ) {
        throw new Error('Invalid test-assumption input fingerprint');
      }
      return Object.freeze({
        path: file(declared.path, 'declared input'),
        contentHash,
        mode,
      });
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (
    new Set(declaredInputs.map((item) => item.path)).size !==
    declaredInputs.length
  ) {
    throw new Error('Test assumption contains duplicate declared inputs');
  }
  const declared = new Set(declaredInputs.map((item) => item.path));
  if (
    facts.some((fact) => fact.inputFiles.some((item) => !declared.has(item)))
  ) {
    throw new Error('Test-assumption facts must name declared input files');
  }
  return immutableJson({
    protocolVersion: TEST_ASSUMPTION_PROTOCOL_VERSION,
    inventoryId: input.inventoryId,
    baseCommit: input.baseCommit,
    purpose: text(input.purpose, 'purpose'),
    facts: facts.sort((left, right) =>
      left.statement.localeCompare(right.statement),
    ),
    declaredInputs,
    scope: {
      files: files(input.scope.files, 'scope files'),
      cases: texts(input.scope.cases, 'scope cases'),
    },
    rationale: text(input.rationale, 'rationale'),
    alternatives: texts(input.alternatives, 'alternatives'),
    limitations: texts(input.limitations, 'limitations'),
    authorKind: input.authorKind,
    authoredBy: text(input.authoredBy, 'author name'),
  }) as $FlowFixMe;
}

export function createTestAssumption({
  definition,
  now = () => new Date().toISOString(),
}: {
  +definition: mixed,
  +now?: () => string,
}): TestAssumption {
  const normalized = normalizeDefinition(definition);
  const artifactHash = hashString(canonicalJson(normalized as $FlowFixMe));
  return immutableJson({
    ...normalized,
    id: `test-assumption-${shortHash(artifactHash)}`,
    artifactHash,
    createdAt: now(),
  }) as $FlowFixMe;
}

export function validateTestAssumption(value: mixed): TestAssumption {
  if (!object(value)) throw new Error('Invalid test assumption');
  const input: $FlowFixMe = value;
  const { id, artifactHash, createdAt, ...definition } = input;
  const normalized = normalizeDefinition(definition);
  const expected = hashString(canonicalJson(normalized as $FlowFixMe));
  if (
    artifactHash !== expected ||
    id !== `test-assumption-${shortHash(expected)}` ||
    typeof createdAt !== 'string'
  ) {
    throw new Error('Test assumption integrity check failed');
  }
  return immutableJson({
    ...normalized,
    id,
    artifactHash,
    createdAt,
  }) as $FlowFixMe;
}

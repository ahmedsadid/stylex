/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { hashString, shortHash } from '../kernel/hash';
import { canonicalJson, immutableJson } from '../state/json';

export const DYNAMIC_STRATEGY_PROTOCOL_VERSION: string =
  'stylex-migrate-dynamic-strategy-v1';

export type DynamicStrategyKind =
  | 'stylex-variants'
  | 'css-variable'
  | 'inline-style'
  | 'upstream-computation'
  | 'api-refactor'
  | 'retain-emotion';

export type DynamicStrategyEntry = {
  +definitionFactId: string,
  +propPath: string,
  +strategy: DynamicStrategyKind,
  +rationale: string,
  +evidenceRequirements: $ReadOnlyArray<string>,
};

export type DynamicStrategyDefinition = {
  +protocolVersion: string,
  +inventoryId: string,
  +clusterId: string,
  +entries: $ReadOnlyArray<DynamicStrategyEntry>,
};

export type DynamicStrategyDraft = DynamicStrategyDefinition & {
  +id: string,
  +definitionHash: string,
  +authorKind: 'agent' | 'human',
  +authoredBy: string,
  +createdAt: string,
};

function object(value: mixed): boolean {
  return value != null && !Array.isArray(value) && typeof value === 'object';
}

function strategyKind(value: mixed): DynamicStrategyKind {
  switch (value) {
    case 'stylex-variants':
    case 'css-variable':
    case 'inline-style':
    case 'upstream-computation':
    case 'api-refactor':
    case 'retain-emotion':
      return value;
    default:
      throw new Error(`Unsupported dynamic strategy: ${String(value)}`);
  }
}

function identifier(value: mixed, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{16}$/.test(value)) {
    throw new Error(`Dynamic strategy requires a valid ${label}`);
  }
  return value;
}

function nonEmpty(value: mixed, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Dynamic strategy requires a non-empty ${label}`);
  }
  return value.trim();
}

function strings(value: mixed, label: string): $ReadOnlyArray<string> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Dynamic strategy requires at least one ${label}`);
  }
  const output = value.map((item) => nonEmpty(item, label));
  return Object.freeze([...new Set(output)].sort());
}

function entry(value: mixed): DynamicStrategyEntry {
  if (!object(value)) throw new Error('Invalid dynamic strategy entry');
  const input: $FlowFixMe = value;
  const strategy = strategyKind(input.strategy);
  const propPath = nonEmpty(input.propPath, 'prop path');
  if (propPath.includes('\0') || /\s/.test(propPath)) {
    throw new Error(`Invalid dynamic prop path: ${propPath}`);
  }
  return Object.freeze({
    definitionFactId: identifier(input.definitionFactId, 'definition fact ID'),
    propPath,
    strategy,
    rationale: nonEmpty(input.rationale, 'strategy rationale'),
    evidenceRequirements: strings(
      input.evidenceRequirements,
      'evidence requirement',
    ),
  });
}

function normalizeDefinition(value: mixed): DynamicStrategyDefinition {
  if (!object(value)) throw new Error('Invalid dynamic strategy definition');
  const input: $FlowFixMe = value;
  if (input.protocolVersion !== DYNAMIC_STRATEGY_PROTOCOL_VERSION) {
    throw new Error('Unsupported dynamic strategy protocol');
  }
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    throw new Error('Dynamic strategy requires at least one entry');
  }
  const entries = input.entries
    .map(entry)
    .sort((left, right) =>
      `${left.definitionFactId}:${left.propPath}`.localeCompare(
        `${right.definitionFactId}:${right.propPath}`,
      ),
    );
  const keys = entries.map(
    (item) => `${item.definitionFactId}:${item.propPath}`,
  );
  if (new Set(keys).size !== keys.length) {
    throw new Error('Dynamic strategy contains a duplicate prop-path entry');
  }
  return Object.freeze({
    protocolVersion: DYNAMIC_STRATEGY_PROTOCOL_VERSION,
    inventoryId: identifier(input.inventoryId, 'inventory ID'),
    clusterId: identifier(input.clusterId, 'cluster ID'),
    entries: Object.freeze(entries),
  });
}

export function createDynamicStrategyDraft({
  definition,
  authorKind,
  authoredBy,
  now = () => new Date().toISOString(),
}: {
  +definition: mixed,
  +authorKind: 'agent' | 'human',
  +authoredBy: string,
  +now?: () => string,
}): DynamicStrategyDraft {
  if (authorKind !== 'agent' && authorKind !== 'human') {
    throw new Error('Dynamic strategy author must be an agent or human');
  }
  const normalized = normalizeDefinition(definition);
  const definitionHash = hashString(canonicalJson(normalized as $FlowFixMe));
  return immutableJson({
    ...normalized,
    id: `dynamic-strategy-${shortHash(definitionHash)}`,
    definitionHash,
    authorKind,
    authoredBy: nonEmpty(authoredBy, 'author name'),
    createdAt: now(),
  }) as $FlowFixMe;
}

export function validateDynamicStrategyDraft(
  value: mixed,
): DynamicStrategyDraft {
  if (!object(value)) throw new Error('Invalid dynamic strategy draft');
  const input: $FlowFixMe = value;
  const normalized = normalizeDefinition(input);
  const definitionHash = hashString(canonicalJson(normalized as $FlowFixMe));
  if (
    input.definitionHash !== definitionHash ||
    input.id !== `dynamic-strategy-${shortHash(definitionHash)}` ||
    (input.authorKind !== 'agent' && input.authorKind !== 'human') ||
    typeof input.authoredBy !== 'string' ||
    input.authoredBy.trim() === '' ||
    typeof input.createdAt !== 'string'
  ) {
    throw new Error('Dynamic strategy draft integrity check failed');
  }
  return immutableJson({
    ...normalized,
    id: input.id,
    definitionHash,
    authorKind: input.authorKind,
    authoredBy: input.authoredBy.trim(),
    createdAt: input.createdAt,
  }) as $FlowFixMe;
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { hashString, shortHash } from '../kernel/hash';
import type { Inventory } from '../inventory/model';

function object(value: mixed): boolean {
  return value != null && !Array.isArray(value) && typeof value === 'object';
}

function identifierPart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_$]+/g, '');
  if (sanitized === '') return 'token';
  return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `token${sanitized}`;
}

function fullName(sourcePath: string): string {
  const parts = sourcePath.split('.').map(identifierPart);
  return parts
    .map((part, index) =>
      index === 0 ? part : `${part[0].toUpperCase()}${part.slice(1)}`,
    )
    .join('');
}

function targetNames(paths: $ReadOnlyArray<string>): Map<string, string> {
  const leaves = new Map<string, Array<string>>();
  for (const sourcePath of paths) {
    const leaf = identifierPart(sourcePath.split('.').at(-1) ?? sourcePath);
    const values = leaves.get(leaf) ?? [];
    values.push(sourcePath);
    leaves.set(leaf, values);
  }
  const output = new Map<string, string>();
  const allocated = new Set<string>();
  for (const sourcePath of paths) {
    const leaf = identifierPart(sourcePath.split('.').at(-1) ?? sourcePath);
    let target = leaves.get(leaf)?.length === 1 ? leaf : fullName(sourcePath);
    if (allocated.has(target)) {
      target = `${target}_${shortHash(hashString(sourcePath))}`;
    }
    allocated.add(target);
    output.set(sourcePath, target);
  }
  return output;
}

/** Add token paths only when the input deliberately omits them. */
export function scaffoldThemeDecisionDefinition({
  inventory,
  definition: input,
}: {
  +inventory: Inventory,
  +definition: mixed,
}): mixed {
  const definition: $FlowFixMe = input;
  if (!object(definition)) {
    throw new Error('Theme draft input must be an object');
  }
  if (Array.isArray(definition.tokens) && definition.tokens.length > 0) {
    return definition;
  }
  if (
    !Array.isArray(definition.consumerFiles) ||
    definition.consumerFiles.length === 0 ||
    !definition.consumerFiles.every((file) => typeof file === 'string')
  ) {
    throw new Error(
      'Automatic theme token discovery requires explicit consumer files',
    );
  }
  const consumers = new Set(definition.consumerFiles);
  const paths = [
    ...new Set(
      inventory.facts
        .filter(
          (fact) =>
            fact.kind === 'theme-read' &&
            fact.status === 'known' &&
            fact.provenance.some(
              (item) => item.file != null && consumers.has(item.file),
            ),
        )
        .map((fact) => {
          const value: $FlowFixMe = fact.value;
          return typeof value.sourcePath === 'string' ? value.sourcePath : null;
        })
        .filter((sourcePath): sourcePath is string => sourcePath != null),
    ),
  ].sort();
  if (paths.length === 0) {
    throw new Error('Consumer files contain no known theme reads to scaffold');
  }
  const names = targetNames(paths);
  return {
    ...definition,
    tokens: paths.map((sourcePath) => ({
      sourcePath,
      targetName: String(names.get(sourcePath)),
      existingCssVariable: null,
    })),
  };
}

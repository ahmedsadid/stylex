/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

const SKIPPED_KEYS = new Set([
  'loc',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'comments',
  'tokens',
  'extra',
]);

/**
 * A deliberately small AST walk.
 *
 * Discovery only needs to find nodes of a few kinds; it never rewrites through
 * this walk and never needs scope information, so a full traversal library
 * would be a dependency bought for nothing.
 */
export function walk(node: mixed, visit: (node: $FlowFixMe) => void): void {
  if (node == null || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      walk(child, visit);
    }
    return;
  }
  const record: { +[string]: mixed } = node;
  if (typeof record.type === 'string') {
    visit(node);
  }
  for (const key of Object.keys(record)) {
    if (SKIPPED_KEYS.has(key)) {
      continue;
    }
    walk(record[key], visit);
  }
}

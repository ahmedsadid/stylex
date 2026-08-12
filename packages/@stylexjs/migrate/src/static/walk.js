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
 *
 * The traversal keeps its own stack rather than recursing. Real source produces
 * arbitrarily deep trees — `a + a + a + ...` a few thousand times nests that
 * deeply on the left — and a recursive version overflowed the call stack on
 * exactly that input. Whether it overflowed depended on how much stack the
 * process happened to have left, which made it an intermittent crash rather
 * than an honest refusal.
 *
 * Nodes are visited in the same order a recursive pre-order walk would visit
 * them: children are pushed in reverse so they pop back in source order. One
 * caller depends on that, taking the last match in a file.
 */
export function walk(node: mixed, visit: (node: $FlowFixMe) => void): void {
  const stack: Array<mixed> = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current == null || typeof current !== 'object') {
      continue;
    }
    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i--) {
        stack.push(current[i]);
      }
      continue;
    }
    const record: { +[string]: mixed } = current;
    if (typeof record.type === 'string') {
      visit(current);
    }
    const keys = Object.keys(record);
    for (let i = keys.length - 1; i >= 0; i--) {
      if (SKIPPED_KEYS.has(keys[i])) {
        continue;
      }
      stack.push(record[keys[i]]);
    }
  }
}

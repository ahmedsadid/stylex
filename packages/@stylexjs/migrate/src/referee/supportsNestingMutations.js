/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import type { MutationGate } from './mutations';

export type SupportsNestingMutationId =
  | 'intersection-removed'
  | 'supports-query-changed'
  | 'source-branch-reordered'
  | 'property-renamed'
  | 'value-changed'
  | 'importance-added'
  | 'specificity-changed'
  | 'second-supports-added'
  | 'third-level-added'
  | 'style-key-wiring-changed';

export type SupportsNestingMutation = {
  +id: SupportsNestingMutationId,
  +field: string,
  +expectedGate: MutationGate,
};

export const SUPPORTS_NESTING_MUTATION_MANIFEST: $ReadOnlyArray<SupportsNestingMutation> =
  Object.freeze([
    {
      id: 'intersection-removed',
      field: 'conditions',
      expectedGate: 'referee',
    },
    {
      id: 'supports-query-changed',
      field: 'condition',
      expectedGate: 'grammar',
    },
    {
      id: 'source-branch-reordered',
      field: 'sourceOrder',
      expectedGate: 'referee',
    },
    { id: 'property-renamed', field: 'property', expectedGate: 'referee' },
    { id: 'value-changed', field: 'value', expectedGate: 'referee' },
    { id: 'importance-added', field: 'important', expectedGate: 'grammar' },
    {
      id: 'specificity-changed',
      field: 'specificity',
      expectedGate: 'grammar',
    },
    {
      id: 'second-supports-added',
      field: 'conditions',
      expectedGate: 'grammar',
    },
    { id: 'third-level-added', field: 'nestingDepth', expectedGate: 'grammar' },
    {
      id: 'style-key-wiring-changed',
      field: 'argumentWiring',
      expectedGate: 'binding-integrity',
    },
  ]);

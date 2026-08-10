/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import type { MutationGate } from './mutations';

export type MediaQueryMutationId =
  | 'query-removed'
  | 'query-changed'
  | 'source-branch-reordered'
  | 'property-renamed'
  | 'value-changed'
  | 'importance-added'
  | 'specificity-changed'
  | 'second-query-added'
  | 'at-rule-kind-changed'
  | 'style-key-wiring-changed';

export type MediaQueryMutation = {
  +id: MediaQueryMutationId,
  +field: string,
  +expectedGate: MutationGate,
};

// Compiler priority is recorded but is not a material mutation in this first
// grammar: StyleX's media selector has higher specificity than its default
// selector, and only one query is admitted. Priority becomes material when a
// later grammar permits competing conditional rules.
export const MEDIA_QUERY_MUTATION_MANIFEST: $ReadOnlyArray<MediaQueryMutation> =
  Object.freeze([
    { id: 'query-removed', field: 'condition', expectedGate: 'referee' },
    { id: 'query-changed', field: 'condition', expectedGate: 'grammar' },
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
      id: 'second-query-added',
      field: 'conditions',
      expectedGate: 'grammar',
    },
    {
      id: 'at-rule-kind-changed',
      field: 'conditionKind',
      expectedGate: 'observer',
    },
    {
      id: 'style-key-wiring-changed',
      field: 'argumentWiring',
      expectedGate: 'binding-integrity',
    },
  ]);

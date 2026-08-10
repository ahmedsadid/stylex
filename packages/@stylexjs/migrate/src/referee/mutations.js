/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

export type ConditionalMutationId =
  | 'condition-removed'
  | 'condition-renamed'
  | 'branch-reordered'
  | 'property-renamed'
  | 'value-changed'
  | 'priority-changed'
  | 'specificity-changed'
  | 'importance-added'
  | 'pseudo-element-target-changed'
  | 'style-key-wiring-changed';

export type ConditionalMutation = {
  +id: ConditionalMutationId,
  +field: string,
  +expectedGate: string,
};

export const CONDITIONAL_MUTATION_MANIFEST: $ReadOnlyArray<ConditionalMutation> =
  Object.freeze([
    { id: 'condition-removed', field: 'condition', expectedGate: 'referee' },
    { id: 'condition-renamed', field: 'condition', expectedGate: 'observer' },
    { id: 'branch-reordered', field: 'sourceOrder', expectedGate: 'referee' },
    { id: 'property-renamed', field: 'property', expectedGate: 'referee' },
    { id: 'value-changed', field: 'value', expectedGate: 'referee' },
    {
      id: 'priority-changed',
      field: 'stylexPriority',
      expectedGate: 'referee',
    },
    {
      id: 'specificity-changed',
      field: 'specificity',
      expectedGate: 'grammar',
    },
    { id: 'importance-added', field: 'important', expectedGate: 'grammar' },
    {
      id: 'pseudo-element-target-changed',
      field: 'pseudoElement',
      expectedGate: 'grammar',
    },
    {
      id: 'style-key-wiring-changed',
      field: 'argumentWiring',
      expectedGate: 'binding-integrity',
    },
  ]);

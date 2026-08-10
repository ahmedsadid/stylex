/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import type { MutationGate } from './mutations';

export type PseudoElementMutationId =
  | 'target-removed'
  | 'target-renamed'
  | 'property-renamed'
  | 'value-changed'
  | 'importance-added'
  | 'specificity-changed'
  | 'condition-added'
  | 'unsupported-target-substituted'
  | 'style-key-wiring-changed';

export type PseudoElementMutation = {
  +id: PseudoElementMutationId,
  +field: string,
  +expectedGate: MutationGate,
};

// Priority and source order are deliberately absent. This grammar permits one
// declaration per property and selector target, so neither field can change a
// local winner. They become mandatory mutations if conditions or another
// competing declaration are admitted inside a pseudo-element target.
export const PSEUDO_ELEMENT_MUTATION_MANIFEST: $ReadOnlyArray<PseudoElementMutation> =
  Object.freeze([
    { id: 'target-removed', field: 'pseudoElement', expectedGate: 'referee' },
    { id: 'target-renamed', field: 'pseudoElement', expectedGate: 'referee' },
    { id: 'property-renamed', field: 'property', expectedGate: 'referee' },
    { id: 'value-changed', field: 'value', expectedGate: 'referee' },
    { id: 'importance-added', field: 'important', expectedGate: 'grammar' },
    {
      id: 'specificity-changed',
      field: 'specificity',
      expectedGate: 'grammar',
    },
    { id: 'condition-added', field: 'conditions', expectedGate: 'grammar' },
    {
      id: 'unsupported-target-substituted',
      field: 'pseudoElement',
      expectedGate: 'grammar',
    },
    {
      id: 'style-key-wiring-changed',
      field: 'argumentWiring',
      expectedGate: 'binding-integrity',
    },
  ]);

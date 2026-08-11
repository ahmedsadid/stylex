/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import type { MutationGate } from './mutations';

export type DirectionalMutationId =
  | 'logical-declaration-removed'
  | 'logical-value-changed'
  | 'physical-value-changed'
  | 'physical-property-renamed'
  | 'priority-changed'
  | 'logical-axis-changed'
  | 'source-order-reversed'
  | 'importance-added'
  | 'extra-property-added'
  | 'style-key-wiring-changed';

export type DirectionalMutation = {
  +id: DirectionalMutationId,
  +field: string,
  +expectedGate: MutationGate,
};

export const DIRECTIONAL_MUTATION_MANIFEST: $ReadOnlyArray<DirectionalMutation> =
  Object.freeze([
    {
      id: 'logical-declaration-removed',
      field: 'logicalProperty',
      expectedGate: 'referee',
    },
    {
      id: 'logical-value-changed',
      field: 'logicalValue',
      expectedGate: 'referee',
    },
    {
      id: 'physical-value-changed',
      field: 'physicalValue',
      expectedGate: 'referee',
    },
    {
      id: 'physical-property-renamed',
      field: 'physicalProperty',
      expectedGate: 'referee',
    },
    {
      id: 'priority-changed',
      field: 'stylexPriority',
      expectedGate: 'referee',
    },
    {
      id: 'logical-axis-changed',
      field: 'logicalMapping',
      expectedGate: 'referee',
    },
    {
      id: 'source-order-reversed',
      field: 'sourceOrder',
      expectedGate: 'referee',
    },
    { id: 'importance-added', field: 'important', expectedGate: 'grammar' },
    {
      id: 'extra-property-added',
      field: 'declarationCount',
      expectedGate: 'referee',
    },
    {
      id: 'style-key-wiring-changed',
      field: 'argumentWiring',
      expectedGate: 'binding-integrity',
    },
  ]);

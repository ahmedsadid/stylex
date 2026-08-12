/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import type { MutationGate } from './mutations';

export type ShorthandMutationId =
  | 'top-removed'
  | 'right-mapping-changed'
  | 'bottom-property-renamed'
  | 'left-value-changed'
  | 'top-reset-changed'
  | 'unit-changed'
  | 'importance-added'
  | 'extra-longhand-added'
  | 'shorthand-reintroduced'
  | 'style-key-wiring-changed';

export type ShorthandMutation = {
  +id: ShorthandMutationId,
  +field: string,
  +expectedGate: MutationGate,
};

export const SHORTHAND_MUTATION_MANIFEST: $ReadOnlyArray<ShorthandMutation> =
  Object.freeze([
    { id: 'top-removed', field: 'expandedTop', expectedGate: 'referee' },
    {
      id: 'right-mapping-changed',
      field: 'expandedRight',
      expectedGate: 'referee',
    },
    {
      id: 'bottom-property-renamed',
      field: 'property',
      expectedGate: 'observer',
    },
    { id: 'left-value-changed', field: 'value', expectedGate: 'referee' },
    { id: 'top-reset-changed', field: 'sourceOrder', expectedGate: 'referee' },
    { id: 'unit-changed', field: 'unit', expectedGate: 'referee' },
    { id: 'importance-added', field: 'important', expectedGate: 'referee' },
    {
      id: 'extra-longhand-added',
      field: 'declarationCount',
      expectedGate: 'referee',
    },
    {
      id: 'shorthand-reintroduced',
      field: 'emittedProperty',
      expectedGate: 'observer',
    },
    {
      id: 'style-key-wiring-changed',
      field: 'argumentWiring',
      expectedGate: 'binding-integrity',
    },
  ]);

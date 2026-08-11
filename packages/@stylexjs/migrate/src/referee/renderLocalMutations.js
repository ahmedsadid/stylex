/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import type { MutationGate } from './mutations';

export type RenderLocalMutationId =
  | 'import-source-changed'
  | 'imported-symbol-changed'
  | 'binding-shadowed'
  | 'result-stored'
  | 'extra-argument-added'
  | 'dynamic-argument-used'
  | 'object-spread-added'
  | 'effectful-value-added'
  | 'output-value-changed'
  | 'style-key-wiring-changed';

export type RenderLocalMutation = {
  +id: RenderLocalMutationId,
  +field: string,
  +expectedGate: MutationGate,
};

export const RENDER_LOCAL_MUTATION_MANIFEST: $ReadOnlyArray<RenderLocalMutation> =
  Object.freeze([
    {
      id: 'import-source-changed',
      field: 'importSource',
      expectedGate: 'discovery',
    },
    {
      id: 'imported-symbol-changed',
      field: 'importedSymbol',
      expectedGate: 'discovery',
    },
    {
      id: 'binding-shadowed',
      field: 'bindingResolution',
      expectedGate: 'discovery',
    },
    { id: 'result-stored', field: 'resultIdentity', expectedGate: 'discovery' },
    {
      id: 'extra-argument-added',
      field: 'argumentCount',
      expectedGate: 'discovery',
    },
    {
      id: 'dynamic-argument-used',
      field: 'argumentShape',
      expectedGate: 'discovery',
    },
    {
      id: 'object-spread-added',
      field: 'argumentPurity',
      expectedGate: 'discovery',
    },
    {
      id: 'effectful-value-added',
      field: 'evaluationEffect',
      expectedGate: 'discovery',
    },
    { id: 'output-value-changed', field: 'value', expectedGate: 'referee' },
    {
      id: 'style-key-wiring-changed',
      field: 'argumentWiring',
      expectedGate: 'binding-integrity',
    },
  ]);

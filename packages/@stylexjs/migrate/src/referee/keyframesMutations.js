/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import type { MutationGate } from './mutations';

export type KeyframesMutationId =
  | 'frame-removed'
  | 'frame-selector-changed'
  | 'frame-property-renamed'
  | 'frame-value-changed'
  | 'frame-importance-added'
  | 'animation-reference-detached'
  | 'animation-duration-changed'
  | 'keyframes-call-removed'
  | 'second-keyframes-added'
  | 'style-key-wiring-changed';

export type KeyframesMutation = {
  +id: KeyframesMutationId,
  +field: string,
  +expectedGate: MutationGate,
};

export const KEYFRAMES_MUTATION_MANIFEST: $ReadOnlyArray<KeyframesMutation> =
  Object.freeze([
    { id: 'frame-removed', field: 'frames', expectedGate: 'observer' },
    {
      id: 'frame-selector-changed',
      field: 'selector',
      expectedGate: 'referee',
    },
    {
      id: 'frame-property-renamed',
      field: 'property',
      expectedGate: 'referee',
    },
    { id: 'frame-value-changed', field: 'value', expectedGate: 'referee' },
    {
      id: 'frame-importance-added',
      field: 'important',
      expectedGate: 'grammar',
    },
    {
      id: 'animation-reference-detached',
      field: 'animationName',
      expectedGate: 'grammar',
    },
    {
      id: 'animation-duration-changed',
      field: 'rootDeclaration',
      expectedGate: 'referee',
    },
    {
      id: 'keyframes-call-removed',
      field: 'keyframesCall',
      expectedGate: 'observer',
    },
    {
      id: 'second-keyframes-added',
      field: 'keyframesCount',
      expectedGate: 'observer',
    },
    {
      id: 'style-key-wiring-changed',
      field: 'argumentWiring',
      expectedGate: 'binding-integrity',
    },
  ]);

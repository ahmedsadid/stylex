/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  observeEmotionSerialization,
  observeStyleXCompilation,
  PSEUDO_ELEMENT_REFEREE_MODEL,
  refereePseudoElements,
} from '../src/index';
import type { RefereeDeclaration } from '../src/index';

const STYLEX_SOURCE = `import * as stylex from '@stylexjs/stylex';
const styles = stylex.create({
  root: {
    color: 'black',
    '::before': { color: 'red', content: '"x"' },
    '::after': { color: 'blue' },
  },
});
export const props = stylex.props(styles.root);
`;

function observations(): {
  +source: $ReadOnlyArray<RefereeDeclaration>,
  +target: $ReadOnlyArray<RefereeDeclaration>,
} {
  const source = observeEmotionSerialization({
    color: 'black',
    '::before': { color: 'red', content: '"x"' },
    '::after': { color: 'blue' },
  });
  const target = observeStyleXCompilation(STYLEX_SOURCE, 'pseudo-elements.js');
  if (!source.ok || !target.ok) {
    throw new Error(source.ok ? target.reason : source.reason);
  }
  return { source: source.declarations, target: target.declarations };
}

describe('the first pseudo-element referee grammar', () => {
  test('matches actual Emotion and StyleX output by selector target', () => {
    const observed = observations();
    expect(
      refereePseudoElements(observed.source, observed.target),
    ).toMatchObject({
      status: 'equivalent',
      model: PSEUDO_ELEMENT_REFEREE_MODEL,
      differences: [],
    });
    expect(
      observed.target.map((declaration) => [
        declaration.property,
        declaration.pseudoElement,
        declaration.stylexPriority,
      ]),
    ).toEqual([
      ['color', null, 3000],
      ['color', '::before', 8000],
      ['content', '::before', 8000],
      ['color', '::after', 8000],
    ]);
  });

  test('detects declarations wired to the wrong targets', () => {
    const observed = observations();
    const target = observed.target.map((declaration) =>
      declaration.property !== 'color' || declaration.pseudoElement == null
        ? declaration
        : {
            ...declaration,
            pseudoElement:
              declaration.pseudoElement === '::before' ? '::after' : '::before',
          },
    );
    const result = refereePseudoElements(observed.source, target);
    expect(result.status).toBe('mismatch');
    if (result.status === 'mismatch') {
      expect(result.differences).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            property: 'color',
            pseudoElement: '::before',
            sourceValue: 'red',
            targetValue: 'blue',
          }),
          expect.objectContaining({
            property: 'color',
            pseudoElement: '::after',
            sourceValue: 'blue',
            targetValue: 'red',
          }),
        ]),
      );
    }
  });

  test('refuses other pseudo-elements and all pseudo-class conditions', () => {
    const observed = observations();
    const unsupported = [
      { ...observed.source[0], pseudoElement: '::placeholder' },
      {
        ...observed.source[1],
        pseudoElement: null,
        conditions: [':hover'],
        specificity: [0, 2, 0],
      },
    ];
    const result = refereePseudoElements(unsupported, observed.target);
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') {
      expect(result.reasons.join('\n')).toContain(
        'unsupported pseudo-element ::placeholder',
      );
      expect(result.reasons.join('\n')).toContain('unsupported condition set');
    }
  });
});

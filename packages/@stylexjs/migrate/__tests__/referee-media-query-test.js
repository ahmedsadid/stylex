/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  MEDIA_QUERY_REFEREE_MODEL,
  observeEmotionSerialization,
  observeStyleXCompilation,
  refereeMediaQueries,
} from '../src/index';
import type { RefereeDeclaration } from '../src/index';

const QUERY = '@media (min-width: 800px)';
const STYLEX_SOURCE = `import * as stylex from '@stylexjs/stylex';
const styles = stylex.create({
  root: { color: { default: 'black', '${QUERY}': 'blue' } },
});
export const props = stylex.props(styles.root);
`;

function observations({
  reverseSource = false,
}: { +reverseSource?: boolean } = {}): {
  +source: $ReadOnlyArray<RefereeDeclaration>,
  +target: $ReadOnlyArray<RefereeDeclaration>,
} {
  const source = observeEmotionSerialization(
    reverseSource
      ? { [QUERY]: { color: 'blue' }, color: 'black' }
      : { color: 'black', [QUERY]: { color: 'blue' } },
  );
  const target = observeStyleXCompilation(STYLEX_SOURCE, 'media-query.js');
  if (!source.ok || !target.ok) {
    throw new Error(source.ok ? target.reason : source.reason);
  }
  return { source: source.declarations, target: target.declarations };
}

describe('the first media-query referee grammar', () => {
  test('matches one exact query observed from both compilers', () => {
    const observed = observations();
    expect(refereeMediaQueries(observed.source, observed.target)).toMatchObject(
      {
        status: 'equivalent',
        model: MEDIA_QUERY_REFEREE_MODEL,
        differences: [],
        states: [
          { id: 'default', activeConditions: [] },
          { id: QUERY, activeConditions: [QUERY] },
        ],
      },
    );
    expect(observed.source.map((item) => item.specificity)).toEqual([
      [0, 1, 0],
      [0, 1, 0],
    ]);
    expect(observed.target.map((item) => item.specificity)).toEqual([
      [0, 1, 0],
      [0, 2, 0],
    ]);
    expect(observed.target[1].stylexPriority).toBe(3200);
  });

  test('catches a default authored after an overlapping media declaration', () => {
    const observed = observations({ reverseSource: true });
    const result = refereeMediaQueries(observed.source, observed.target);
    expect(result.status).toBe('mismatch');
    if (result.status === 'mismatch') {
      expect(result.differences).toEqual([
        expect.objectContaining({
          stateId: QUERY,
          property: 'color',
          sourceValue: 'black',
          targetValue: 'blue',
        }),
      ]);
    }
  });

  test('refuses more than one distinct query or any other condition kind', () => {
    const observed = observations();
    const secondQuery = observed.source.map((declaration) =>
      declaration.conditions.length === 0
        ? declaration
        : { ...declaration, conditions: ['@media (min-width: 1200px)'] },
    );
    expect(refereeMediaQueries(secondQuery, observed.target).status).toBe(
      'unsupported',
    );
    const pseudoClass = observed.source.map((declaration) =>
      declaration.conditions.length === 0
        ? declaration
        : { ...declaration, conditions: [':hover'] },
    );
    expect(refereeMediaQueries(pseudoClass, observed.target).status).toBe(
      'unsupported',
    );
  });
});

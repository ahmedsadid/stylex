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
  refereeSupportsNesting,
  SUPPORTS_NESTING_REFEREE_MODEL,
} from '../src/index';

const SUPPORTS = '@supports (display: grid)';
const MEDIA = '@media (min-width: 800px)';

function observe(sourceStyle: mixed, targetValue: string) {
  const source = observeEmotionSerialization(sourceStyle);
  const target = observeStyleXCompilation(
    `import * as stylex from '@stylexjs/stylex';
const styles = stylex.create({ root: { color: ${targetValue} } });
export const props = stylex.props(styles.root);`,
    'supports-nesting.js',
  );
  if (!source.ok || !target.ok) {
    throw new Error(source.ok ? target.reason : source.reason);
  }
  return { source: source.declarations, target: target.declarations };
}

describe('bounded supports nesting referee grammar', () => {
  test('matches one exact supports condition', () => {
    const observed = observe(
      { color: 'black', [SUPPORTS]: { color: 'grid' } },
      `{ default: 'black', '${SUPPORTS}': 'grid' }`,
    );
    expect(
      refereeSupportsNesting(observed.source, observed.target),
    ).toMatchObject({
      status: 'equivalent',
      model: SUPPORTS_NESTING_REFEREE_MODEL,
      differences: [],
    });
    expect(observed.target.map((item) => item.specificity)).toEqual([
      [0, 1, 0],
      [0, 2, 0],
    ]);
  });

  test('matches an exact supports and media intersection', () => {
    const observed = observe(
      {
        color: 'black',
        [SUPPORTS]: { color: 'grid', [MEDIA]: { color: 'wide-grid' } },
      },
      `{ default: 'black', '${SUPPORTS}': { default: 'grid', '${MEDIA}': 'wide-grid' } }`,
    );
    const result = refereeSupportsNesting(observed.source, observed.target);
    expect(result).toMatchObject({
      status: 'equivalent',
      model: SUPPORTS_NESTING_REFEREE_MODEL,
      differences: [],
    });
    if (result.status === 'equivalent') expect(result.states).toHaveLength(4);
    expect(observed.target.map((item) => item.specificity)).toEqual([
      [0, 1, 0],
      [0, 2, 0],
      [0, 3, 0],
    ]);
  });

  test('treats wrapper order as the same activation intersection', () => {
    const observed = observe(
      { color: 'black', [MEDIA]: { [SUPPORTS]: { color: 'wide-grid' } } },
      `{ default: 'black', '${SUPPORTS}': { '${MEDIA}': 'wide-grid' } }`,
    );
    expect(
      refereeSupportsNesting(observed.source, observed.target).status,
    ).toBe('equivalent');
  });

  test('refuses supports-free and repeated condition kinds', () => {
    const observed = observe(
      { color: 'black', [SUPPORTS]: { color: 'grid' } },
      `{ default: 'black', '${SUPPORTS}': 'grid' }`,
    );
    const withoutSupports = observed.source.map((item) => ({
      ...item,
      conditions: item.conditions.map(() => MEDIA),
    }));
    const targetWithoutSupports = observed.target.map((item) => ({
      ...item,
      conditions: item.conditions.map(() => MEDIA),
    }));
    expect(
      refereeSupportsNesting(withoutSupports, targetWithoutSupports).status,
    ).toBe('unsupported');
    const repeated = observed.source.map((item) => ({
      ...item,
      conditions:
        item.conditions.length === 0 ? [] : [SUPPORTS, `${SUPPORTS}x`],
    }));
    expect(refereeSupportsNesting(repeated, observed.target).status).toBe(
      'unsupported',
    );
  });
});

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  BOX_SHORTHAND_REFEREE_MODEL,
  expandBoxShorthand,
  observeEmotionBoxShorthands,
  refereeBoxShorthands,
} from '../src/index';

describe('bounded box shorthand expansion', () => {
  test.each([
    ['1px', ['1px', '1px', '1px', '1px']],
    ['1px 2px', ['1px', '2px', '1px', '2px']],
    ['1px 2px 3px', ['1px', '2px', '3px', '2px']],
    ['1px 2px 3px 4px', ['1px', '2px', '3px', '4px']],
  ])('expands %s using CSS box order', (value, expected) => {
    expect(
      expandBoxShorthand('margin', value)?.map((item) => item.value),
    ).toEqual(expected);
  });

  test('models shorthand reset order independently from the target', () => {
    const source = observeEmotionBoxShorthands({ marginTop: 20, margin: 4 });
    if (!source.ok) throw new Error(source.reason);
    const target = [
      { property: 'margin-top', value: '4px' },
      { property: 'margin-right', value: '4px' },
      { property: 'margin-bottom', value: '4px' },
      { property: 'margin-left', value: '4px' },
    ];
    expect(refereeBoxShorthands(source.declarations, target)).toEqual({
      status: 'equivalent',
      model: BOX_SHORTHAND_REFEREE_MODEL,
      differences: [],
    });
  });

  test('preserves a later longhand override', () => {
    const source = observeEmotionBoxShorthands({ margin: 4, marginTop: 20 });
    if (!source.ok) throw new Error(source.reason);
    expect(
      source.declarations.find((item) => item.property === 'margin-top')?.value,
    ).toBe('20px');
  });
});

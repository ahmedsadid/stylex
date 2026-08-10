/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  KEYFRAMES_REFEREE_MODEL,
  observeEmotionKeyframes,
  observeStyleXKeyframes,
  refereeKeyframes,
} from '../src/index';

function observations(targetOpacity: number = 1) {
  const source = observeEmotionKeyframes({
    '@keyframes fade': { from: { opacity: 0 }, to: { opacity: 1 } },
    animationName: 'fade',
    animationDuration: '1s',
  });
  const target = observeStyleXKeyframes(
    `import * as stylex from '@stylexjs/stylex';
const styles = stylex.create({ root: {
  animationName: stylex.keyframes({ from: { opacity: 0 }, to: { opacity: ${targetOpacity} } }),
  animationDuration: '1s',
} });
export const props = stylex.props(styles.root);`,
    'keyframes.js',
  );
  if (!source.ok || !target.ok)
    throw new Error(source.ok ? target.reason : source.reason);
  return { source: source.observation, target: target.observation };
}

describe('the first keyframes referee grammar', () => {
  test('alpha-renames the generated identifier while comparing its reference', () => {
    const observed = observations();
    expect(observed.source.name).toBe('fade');
    expect(observed.target.name).not.toBe('fade');
    expect(refereeKeyframes(observed.source, observed.target)).toEqual({
      status: 'equivalent',
      model: KEYFRAMES_REFEREE_MODEL,
      differences: [],
    });
  });

  test('detects a changed frame declaration', () => {
    const observed = observations(0.5);
    expect(refereeKeyframes(observed.source, observed.target)).toMatchObject({
      status: 'mismatch',
      differences: ['keyframe declarations differ'],
    });
  });

  test('refuses an animation reference not bound to the observed rule', () => {
    const observed = observations();
    expect(
      refereeKeyframes(observed.source, {
        ...observed.target,
        animationName: 'some-other-name',
      }),
    ).toMatchObject({ status: 'unsupported' });
  });
});

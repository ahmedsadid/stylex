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
  referee,
} from '../src/index';
import type { RefereeResult } from '../src/index';

function stylexSource(conditionOrder: $ReadOnlyArray<string>): string {
  const conditions = conditionOrder
    .map(
      (condition) =>
        `${JSON.stringify(condition)}:${JSON.stringify(condition.slice(1))}`,
    )
    .join(',');
  return [
    'import * as stylex from "@stylexjs/stylex";',
    `const styles = stylex.create({ root: { color: { default: "base", ${conditions} } } });`,
    'export const props = stylex.props(styles.root);',
  ].join('\n');
}

function compare(
  emotionStyle: mixed,
  conditionOrder: $ReadOnlyArray<string>,
): {
  +sourceCss: string,
  +targetCss: string,
  +result: RefereeResult,
} {
  const source = observeEmotionSerialization(emotionStyle);
  const target = observeStyleXCompilation(
    stylexSource(conditionOrder),
    'condition-probe.js',
  );
  if (!source.ok || !target.ok) {
    throw new Error(source.ok ? target.reason : source.reason);
  }
  return {
    sourceCss: source.css,
    targetCss: target.css,
    result: referee(source.declarations, target.declarations),
  };
}

describe('Emotion and StyleX differential cascade fixtures', () => {
  test('matching condition order has the same winner in every state', () => {
    const fixture = compare(
      {
        color: 'base',
        ':hover': { color: 'hover' },
        ':focus': { color: 'focus' },
      },
      [':hover', ':focus'],
    );
    expect(fixture.sourceCss).toBe(
      'color:base;:hover{color:hover;}:focus{color:focus;}',
    );
    expect(fixture.targetCss).toContain(':hover{color:hover}');
    expect(fixture.targetCss).toContain(':focus{color:focus}');
    expect(fixture.result).toMatchObject({
      status: 'equivalent',
      differences: [],
    });
  });

  test('reverse source order exposes the real cascade disagreement', () => {
    const fixture = compare(
      {
        color: 'base',
        ':focus': { color: 'focus' },
        ':hover': { color: 'hover' },
      },
      [':focus', ':hover'],
    );
    const result = fixture.result;
    expect(result.status).toBe('mismatch');
    if (result.status === 'mismatch') {
      expect(result.differences).toHaveLength(1);
      expect(result.differences[0]).toMatchObject({
        stateId: ':focus+:hover',
        sourceValue: 'hover',
        targetValue: 'focus',
      });
    }
  });

  test('unknown pseudo-classes and at-rules remain outside the grammar', () => {
    expect(
      observeEmotionSerialization({
        ':focus-visible': { color: 'focusVisible' },
      }),
    ).toEqual({
      ok: false,
      reason: 'Emotion emitted unsupported selector :focus-visible',
    });
    expect(
      observeEmotionSerialization({
        '@media (min-width: 1px)': { color: 'media' },
      }),
    ).toEqual({
      ok: false,
      reason: 'Emotion emitted unsupported atrule node',
    });
  });
});

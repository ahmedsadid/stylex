/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  compileStyleX,
  DIRECTIONAL_REFEREE_MODEL,
  observeEmotionDirectional,
  observeStyleXDirectionalRules,
  refereeDirectional,
} from '../src/index';

function observations(style: { +[string]: string }) {
  const source = observeEmotionDirectional(style);
  const body = Object.entries(style)
    .map(([property, value]) => `${property}: ${JSON.stringify(value)}`)
    .join(', ');
  const compiled = compileStyleX(
    `import * as stylex from '@stylexjs/stylex';
const styles = stylex.create({ root: { ${body} } });
export const props = stylex.props(styles.root);`,
    'directional.js',
  );
  if (!compiled.ok) throw new Error(compiled.reason);
  const target = observeStyleXDirectionalRules(compiled.ruleMetadata);
  if (!source.ok || !target.ok)
    throw new Error(source.ok ? target.reason : source.reason);
  return { source: source.declarations, target: target.declarations };
}

describe('direction and writing-mode referee', () => {
  test('accepts a physical winner authored after its logical competitor', () => {
    const observed = observations({
      marginInlineStart: '2px',
      marginLeft: '1px',
    });
    expect(refereeDirectional(observed.source, observed.target)).toMatchObject({
      status: 'equivalent',
      model: DIRECTIONAL_REFEREE_MODEL,
      differences: [],
      states: expect.any(Array),
    });
  });

  test('catches the reverse order in horizontal LTR', () => {
    const observed = observations({
      marginLeft: '1px',
      marginInlineStart: '2px',
    });
    const result = refereeDirectional(observed.source, observed.target);
    expect(result.status).toBe('mismatch');
    if (result.status === 'mismatch') {
      expect(result.differences).toContainEqual({
        stateId: 'ltr+horizontal-tb',
        property: 'margin-left',
        sourceValue: '2px',
        targetValue: '1px',
      });
    }
  });

  test('catches conflicts that exist only in vertical writing modes', () => {
    const observed = observations({
      marginTop: '1px',
      marginInlineStart: '2px',
    });
    const result = refereeDirectional(observed.source, observed.target);
    expect(result.status).toBe('mismatch');
    if (result.status === 'mismatch') {
      expect(result.differences.map((item) => item.stateId)).toContain(
        'ltr+vertical-rl',
      );
      expect(result.differences.map((item) => item.stateId)).toContain(
        'ltr+vertical-lr',
      );
    }
  });

  test('catches StyleX lowering block-start to physical top in vertical modes', () => {
    const observed = observations({
      marginRight: '1px',
      marginBlockStart: '2px',
    });
    const result = refereeDirectional(observed.source, observed.target);
    expect(result.status).toBe('mismatch');
    if (result.status === 'mismatch') {
      expect(result.differences.map((item) => item.stateId)).toContain(
        'ltr+vertical-rl',
      );
      expect(result.differences.map((item) => item.stateId)).toContain(
        'ltr+vertical-lr',
      );
    }
  });

  test('catches inline-size lowering that is wrong in vertical modes', () => {
    const observed = observations({ inlineSize: '10px' });
    const result = refereeDirectional(observed.source, observed.target);
    expect(result.status).toBe('mismatch');
    if (result.status === 'mismatch') {
      expect(result.differences.map((item) => item.stateId)).toContain(
        'ltr+vertical-rl',
      );
    }
  });
});

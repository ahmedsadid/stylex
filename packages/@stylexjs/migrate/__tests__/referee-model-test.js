/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { activationStates, referee } from '../src/referee/model';
import type { RefereeDeclaration } from '../src/referee/model';

function declaration({
  id,
  value,
  condition,
  sourceOrder,
  priority,
}: {
  +id: string,
  +value: string,
  +condition?: ':hover' | ':focus',
  +sourceOrder: number,
  +priority?: number,
}): RefereeDeclaration {
  return {
    id,
    property: 'color',
    value,
    important: false,
    pseudoElement: null,
    specificity: condition == null ? [0, 1, 0] : [0, 2, 0],
    conditions: condition == null ? [] : [condition],
    sourceOrder,
    stylexPriority: priority ?? null,
  };
}

describe('the cascade referee model', () => {
  const source = [
    declaration({ id: 'source-default', value: 'base', sourceOrder: 0 }),
    declaration({
      id: 'source-hover',
      value: 'hover',
      condition: ':hover',
      sourceOrder: 1,
    }),
    declaration({
      id: 'source-focus',
      value: 'focus',
      condition: ':focus',
      sourceOrder: 2,
    }),
  ];
  const target = [
    declaration({
      id: 'target-default',
      value: 'base',
      sourceOrder: 0,
      priority: 3000,
    }),
    declaration({
      id: 'target-hover',
      value: 'hover',
      condition: ':hover',
      sourceOrder: 1,
      priority: 3130,
    }),
    declaration({
      id: 'target-focus',
      value: 'focus',
      condition: ':focus',
      sourceOrder: 2,
      priority: 3150,
    }),
  ];

  test('enumerates every simultaneous activation state', () => {
    expect(activationStates(source).map((state) => state.id)).toEqual([
      'default',
      ':focus',
      ':hover',
      ':focus+:hover',
    ]);
  });

  test('accepts matching winners in every state', () => {
    expect(referee(source, target)).toMatchObject({
      status: 'equivalent',
      differences: [],
    });
  });

  test('catches a seeded cascade-order disagreement', () => {
    const reversedSource = [source[0], source[2], source[1]].map(
      (item, sourceOrder) => ({ ...item, sourceOrder }),
    );
    const result = referee(reversedSource, target);
    expect(result.status).toBe('mismatch');
    if (result.status === 'mismatch') {
      expect(result.differences).toEqual([
        {
          stateId: ':focus+:hover',
          property: 'color',
          pseudoElement: null,
          sourceWinner: 'source-hover',
          targetWinner: 'target-focus',
          sourceValue: 'hover',
          targetValue: 'focus',
        },
      ]);
    }
  });

  test('derives target order from compiler priority', () => {
    const mutatedTarget = target.map((item) =>
      item.id === 'target-hover' ? { ...item, stylexPriority: 3200 } : item,
    );
    const result = referee(source, mutatedTarget);
    expect(result.status).toBe('mismatch');
    if (result.status === 'mismatch') {
      expect(result.differences[0]).toMatchObject({
        stateId: ':focus+:hover',
        sourceValue: 'focus',
        targetValue: 'hover',
      });
    }
  });

  test('represents but refuses fields outside the first grammar', () => {
    const unsupported: RefereeDeclaration = {
      ...source[0],
      important: true,
      pseudoElement: '::before',
      specificity: [0, 1, 1],
    };
    const result = referee([unsupported], target);
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') {
      expect(result.reasons.join('\n')).toContain('!important');
      expect(result.reasons.join('\n')).toContain('pseudo-elements');
    }
  });
});

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { canTransition, isTerminal, transition } from '../src/index';

describe('the migration state machine', () => {
  test('a proposer may create a candidate and nothing further', () => {
    expect(canTransition('planned', 'candidate-created', 'proposer')).toBe(
      true,
    );
    expect(
      canTransition('evidence-collected', 'auto-eligible', 'proposer'),
    ).toBe(false);
    expect(canTransition('eligible-for-review', 'approved', 'proposer')).toBe(
      false,
    );
    expect(canTransition('approved', 'write-ready', 'proposer')).toBe(false);
  });

  test('approval is a human act that no automated actor can perform', () => {
    expect(canTransition('eligible-for-review', 'approved', 'human')).toBe(
      true,
    );
    expect(canTransition('eligible-for-review', 'approved', 'kernel')).toBe(
      false,
    );
    expect(() =>
      transition('eligible-for-review', 'approved', 'kernel'),
    ).toThrow('may not set state "approved"');
  });

  test('states cannot be skipped', () => {
    expect(() => transition('planned', 'applied', 'kernel')).toThrow(
      'Invalid migration state transition',
    );
    expect(() => transition('candidate-created', 'approved', 'human')).toThrow(
      'Invalid migration state transition',
    );
  });

  test('a new attempt discards collected evidence', () => {
    expect(
      canTransition('evidence-collected', 'candidate-created', 'proposer'),
    ).toBe(true);
  });

  test('applied is terminal', () => {
    expect(isTerminal('applied')).toBe(true);
    expect(isTerminal('planned')).toBe(false);
  });

  test('a stale plan goes back to planning rather than straight to a write', () => {
    expect(canTransition('write-ready', 'stale', 'kernel')).toBe(true);
    expect(canTransition('stale', 'planned', 'kernel')).toBe(true);
    expect(canTransition('stale', 'write-ready', 'kernel')).toBe(false);
  });
});

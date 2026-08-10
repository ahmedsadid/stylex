/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { VERSION } from '../src/index';

describe('@stylexjs/migrate scaffold', () => {
  test('the package entry point loads', () => {
    expect(typeof VERSION).toBe('string');
  });
});

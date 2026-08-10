/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { observeStyleXCompiler } from '../src/index';
import type { CompilerProbe, StyleXCompilerFacts } from '../src/index';

const fixture: StyleXCompilerFacts = require('./__fixtures__/referee/stylex-compiler-facts-v1.json');

describe('StyleX compiler facts', () => {
  test('match the versioned golden fixture', () => {
    const probes: $ReadOnlyArray<CompilerProbe> = fixture.probes.map(
      ({ id, filename, source }) => ({ id, filename, source }),
    );
    expect(observeStyleXCompiler(probes)).toEqual(fixture);
  });

  test('reject duplicate probe identities', () => {
    const { id, filename, source } = fixture.probes[0];
    const probe = { id, filename, source };
    expect(() => observeStyleXCompiler([probe, probe])).toThrow(
      'Invalid StyleX compiler fact probe',
    );
  });
});

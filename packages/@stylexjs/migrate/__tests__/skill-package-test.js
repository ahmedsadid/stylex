/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import fs from 'fs';
import path from 'path';

const SKILL_ROOT = path.join(__dirname, '../skills/stylex-migrate');

describe('M7 vendor-neutral skill package', () => {
  test('ships a neutral router and the referenced protocol resources', () => {
    const manifest: $FlowFixMe = require('../package.json');
    expect(manifest.files).toContain('skills');
    const skill = fs.readFileSync(path.join(SKILL_ROOT, 'SKILL.md'), 'utf8');
    expect(skill).toMatch(
      /^---\nname: stylex-migrate\ndescription:(?: .+\n|\n(?: {2}.+\n)+)---\n/,
    );
    expect(skill).toContain('stylex-migrate context inspect');
    expect(skill).toContain('Do not apply, commit');
    expect(skill).toContain('runtime-matched');
    expect(skill).toContain('styled-theme-intrinsic');
    expect(skill).toContain('theme propose');
    expect(skill).toContain('no-runtime warning');
    expect(skill).toContain('provider subtree');
    expect(skill).toContain('stylex-migrate theme bridge open');
    expect(skill).toContain('task.requiredOutputs');
    expect(skill).toContain('emotion-styled-dynamic-value');
    expect(skill).toContain('styled-dynamic-intrinsic');
    const dynamicReference = fs.readFileSync(
      path.join(SKILL_ROOT, 'references', 'themes-and-runtime-values.md'),
      'utf8',
    );
    expect(dynamicReference).toContain('Use StyleX variants');
    expect(dynamicReference).toContain('CSS custom-property');
    expect(dynamicReference).toContain('Retain Emotion');
    expect(dynamicReference).toContain('Preserve styling-prop filtering');
    for (const reference of [
      'protocol.md',
      'commands.md',
      'emotion-css-prop.md',
      'themes-and-runtime-values.md',
      'component-contracts.md',
      'runtime-evidence.md',
    ]) {
      expect(
        fs.statSync(path.join(SKILL_ROOT, 'references', reference)).isFile(),
      ).toBe(true);
    }
    expect(fs.existsSync(path.join(SKILL_ROOT, 'agents'))).toBe(false);
  });
});

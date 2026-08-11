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
    expect(skill).toMatch(/^---\nname: stylex-migrate\ndescription: .+\n---\n/);
    expect(skill).toContain('stylex-migrate context inspect');
    expect(skill).toContain('Do not apply, commit');
    for (const reference of [
      'protocol.md',
      'commands.md',
      'emotion-css-prop.md',
      'themes-and-runtime-values.md',
      'component-contracts.md',
    ]) {
      expect(
        fs.statSync(path.join(SKILL_ROOT, 'references', reference)).isFile(),
      ).toBe(true);
    }
    expect(fs.existsSync(path.join(SKILL_ROOT, 'agents'))).toBe(false);
  });
});

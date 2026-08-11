/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { scaffoldThemeDecisionDefinition, scanRepository } from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

describe('theme decision scaffolding', () => {
  let repo: string;

  afterEach(() => removeTempDir(repo));

  test('derives stable collision-free names from known consumer reads', () => {
    repo = createTempRepo({
      'src/Card.tsx': `import styled from '@emotion/styled';
const CardRoot = styled.div\`
  color: \${p => p.theme.content.primary};
  background-color: \${p => p.theme.background.primary};
  border-color: \${p => p.theme.border.secondary};
\`;
export const Card = () => <CardRoot />;
`,
    });
    const inventory = scanRepository({ repositoryRoot: repo });
    const result: $FlowFixMe = scaffoldThemeDecisionDefinition({
      inventory,
      definition: { consumerFiles: ['src/Card.tsx'] },
    });
    expect(result.tokens).toEqual([
      {
        sourcePath: 'background.primary',
        targetName: 'backgroundPrimary',
        existingCssVariable: null,
      },
      {
        sourcePath: 'border.secondary',
        targetName: 'secondary',
        existingCssVariable: null,
      },
      {
        sourcePath: 'content.primary',
        targetName: 'contentPrimary',
        existingCssVariable: null,
      },
    ]);
  });

  test('preserves an explicit token map', () => {
    repo = createTempRepo({ 'src/file.ts': 'export const value = 1;\n' });
    const inventory = scanRepository({ repositoryRoot: repo });
    const definition = {
      consumerFiles: ['src/file.ts'],
      tokens: [{ sourcePath: 'theme.value', targetName: 'chosen' }],
    };
    expect(scaffoldThemeDecisionDefinition({ inventory, definition })).toBe(
      definition,
    );
  });
});

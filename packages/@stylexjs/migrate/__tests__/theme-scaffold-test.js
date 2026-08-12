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
        targetName: 'borderSecondary',
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

  test('selects a bounded deterministic batch from bridge-ready consumers', () => {
    repo = createTempRepo({
      'src/A.tsx': `import styled from '@emotion/styled';
const Root = styled.div\`color: \${p => p.theme.colors.a};\`;
export const A = () => <Root />;
`,
      'src/B.tsx': `import styled from '@emotion/styled';
const Root = styled.div\`color: \${p => p.theme.colors.b};\`;
export const B = () => <Root />;
`,
      'other/C.tsx': `import styled from '@emotion/styled';
const Root = styled.div\`color: \${p => p.theme.colors.c};\`;
export const C = () => <Root />;
`,
    });
    const inventory = scanRepository({ repositoryRoot: repo });
    const result: $FlowFixMe = scaffoldThemeDecisionDefinition({
      inventory,
      definition: {
        consumerSelection: {
          mode: 'bridge-ready',
          includeGlobs: ['src/**'],
          maxFiles: 1,
        },
      },
    });
    expect(result.consumerFiles).toEqual(['src/A.tsx']);
    expect(result.tokens).toEqual([
      {
        sourcePath: 'colors.a',
        targetName: 'colorsA',
        existingCssVariable: null,
      },
    ]);
  });

  test('refuses unbounded, empty, or conflicting candidate selection', () => {
    repo = createTempRepo({ 'src/file.ts': 'export const value = 1;\n' });
    const inventory = scanRepository({ repositoryRoot: repo });
    expect(() =>
      scaffoldThemeDecisionDefinition({
        inventory,
        definition: {
          consumerSelection: {
            mode: 'bridge-ready',
            includeGlobs: ['src/**'],
            maxFiles: 0,
          },
        },
      }),
    ).toThrow('maxFiles from 1 to 100');
    expect(() =>
      scaffoldThemeDecisionDefinition({
        inventory,
        definition: {
          consumerFiles: ['src/file.ts'],
          consumerSelection: {
            mode: 'bridge-ready',
            includeGlobs: ['src/**'],
            maxFiles: 1,
          },
        },
      }),
    ).toThrow('either consumerFiles or consumerSelection');
  });
});

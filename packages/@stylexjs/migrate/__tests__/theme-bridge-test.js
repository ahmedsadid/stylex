/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  THEME_DECISION_PROTOCOL_VERSION,
  createThemeDecisionDraft,
  inspectThemeBridge,
} from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

function draft(boundaryFile: string): $FlowFixMe {
  return createThemeDecisionDraft({
    draftedBy: 'agent',
    definition: {
      protocolVersion: THEME_DECISION_PROTOCOL_VERSION,
      inventoryId: 'inventory-fixture',
      targetModule: 'src/theme/tokens.stylex.ts',
      varsExport: 'themeVars',
      defaultVariant: 'light',
      variants: [
        { name: 'light', exportName: 'lightTheme' },
        { name: 'dark', exportName: 'darkTheme' },
      ],
      tokens: [
        {
          sourcePath: 'colors.foreground',
          targetName: 'colorsForeground',
          values: { light: '#111', dark: '#eee' },
          existingCssVariable: null,
        },
      ],
      sourceFiles: ['src/theme/source.ts'],
      consumerFiles: ['src/Card.tsx'],
      bridge: {
        coverageGlobs: ['src/**'],
        boundaryFiles: [boundaryFile],
      },
    },
  });
}

describe('theme bridge inspection', () => {
  let repo: string;

  afterEach(() => removeTempDir(repo));

  test('observes a generated variant applied with a real StyleX namespace', () => {
    repo = createTempRepo({
      'src/App.tsx': `import * as stylex from '@stylexjs/stylex';
import {darkTheme} from './theme/tokens.stylex';
export const App = () => <main {...stylex.props(darkTheme)}>App</main>;
`,
    });
    expect(
      inspectThemeBridge({
        repositoryRoot: repo,
        draft: draft('src/App.tsx'),
      }),
    ).toMatchObject({
      status: 'observed',
      observations: [
        {
          file: 'src/App.tsx',
          status: 'observed',
          importedVariants: ['darkTheme'],
          appliedVariants: ['darkTheme'],
        },
      ],
    });
  });

  test('does not confuse an Emotion-only provider with an implemented bridge', () => {
    repo = createTempRepo({
      'src/App.tsx': `import {ThemeProvider} from '@emotion/react';
import {darkTheme} from './theme/source';
export const App = ({children}) => <ThemeProvider theme={darkTheme}>{children}</ThemeProvider>;
`,
    });
    expect(
      inspectThemeBridge({
        repositoryRoot: repo,
        draft: draft('src/App.tsx'),
      }),
    ).toMatchObject({
      status: 'not-observed',
      observations: [
        {
          status: 'not-observed',
          importedVariants: [],
          appliedVariants: [],
        },
      ],
    });
  });
});

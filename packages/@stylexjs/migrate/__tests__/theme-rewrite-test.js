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
  approveThemeDecision,
  createThemeDecisionDraft,
  parseSource,
  proposeApprovedThemeFiles,
} from '../src/index';

function approved(consumerFiles: $ReadOnlyArray<string>) {
  const draft = createThemeDecisionDraft({
    definition: {
      protocolVersion: THEME_DECISION_PROTOCOL_VERSION,
      inventoryId: 'inventory-1',
      targetModule: 'src/theme/tokens.stylex.ts',
      varsExport: 'themeVars',
      defaultVariant: 'lightTheme',
      variants: [
        { name: 'lightTheme', exportName: 'lightTheme' },
        { name: 'darkTheme', exportName: 'darkTheme' },
      ],
      tokens: [
        {
          sourcePath: 'colors.foreground',
          targetName: 'foreground',
          values: { lightTheme: '#111', darkTheme: '#eee' },
          existingCssVariable: null,
        },
      ],
      sourceFiles: ['src/theme/themes.ts'],
      consumerFiles,
    },
    draftedBy: 'agent',
  });
  return {
    draft,
    approval: approveThemeDecision({
      draft,
      actor: 'human',
      approvedBy: 'reviewer',
    }),
  };
}

describe('M9 approved theme rewrite', () => {
  test('converts a mapped callback value and emits a complete vars module', () => {
    const decision = approved(['src/components/Card.tsx']);
    const result = proposeApprovedThemeFiles({
      files: {
        'src/components/Card.tsx': `/** @jsxImportSource @emotion/react */
export const Card = () => (
  <div css={(theme) => ({color: theme.colors.foreground, paddingTop: 4})}>Card</div>
);
`,
        'src/theme/tokens.stylex.ts': null,
      },
      ...decision,
    });
    expect(result.status).toBe('proposed');
    if (result.status !== 'proposed') throw new Error(result.reason);
    expect(result.files['src/components/Card.tsx']).toContain(
      "import { themeVars } from '../theme/tokens.stylex';",
    );
    expect(result.files['src/components/Card.tsx']).toContain(
      'color: themeVars.foreground',
    );
    expect(result.files['src/components/Card.tsx']).toContain(
      '{...stylex.props(styles.div)}',
    );
    expect(result.files['src/theme/tokens.stylex.ts']).toContain(
      "foreground: '#111'",
    );
    expect(result.files['src/theme/tokens.stylex.ts']).toContain(
      'export const darkTheme = stylex.createTheme',
    );
    for (const [file, source] of Object.entries(result.files)) {
      expect(parseSource(source, file).ok).toBe(true);
    }
  });

  test('replaces a bounded provider and computes its deeper relative import', () => {
    const decision = approved(['src/features/account/Provider.tsx']);
    const result = proposeApprovedThemeFiles({
      files: {
        'src/features/account/Provider.tsx': `import {ThemeProvider} from '@emotion/react';
import {darkTheme} from '../../theme/themes';
export const Account = () => (
  <ThemeProvider theme={darkTheme}>
    <main aria-label="Account">Account</main>
  </ThemeProvider>
);
`,
        'src/theme/tokens.stylex.ts': null,
      },
      ...decision,
    });
    expect(result.status).toBe('proposed');
    if (result.status !== 'proposed') throw new Error(result.reason);
    const output = result.files['src/features/account/Provider.tsx'];
    expect(output).toContain(
      "import { darkTheme } from '../../theme/tokens.stylex';",
    );
    expect(output).not.toContain("from '@emotion/react'");
    expect(output).not.toContain('<ThemeProvider');
    expect(output).toContain('<main {...stylex.props(darkTheme)}');
    expect(output).not.toContain("from '../../theme/themes'");
    expect(parseSource(output, 'src/features/account/Provider.tsx').ok).toBe(
      true,
    );
  });

  test.each([
    [
      'an unmapped token',
      `/** @jsxImportSource @emotion/react */
       export const Card = () => <div css={(theme) => ({color: theme.colors.missing})} />;`,
    ],
    [
      'a complex provider',
      `import {ThemeProvider} from '@emotion/react';
       const darkTheme = {};
       export const App = () => <ThemeProvider theme={darkTheme}><div /><span /></ThemeProvider>;`,
    ],
    [
      'a mixed className site',
      `/** @jsxImportSource @emotion/react */
       export const Card = () => <div className="x" css={(theme) => ({color: theme.colors.foreground})} />;`,
    ],
    [
      'a styled provider child',
      `import {ThemeProvider} from '@emotion/react';
       const darkTheme = {};
       export const App = () => <ThemeProvider theme={darkTheme}><div css={{color: 'red'}} /></ThemeProvider>;`,
    ],
  ])('refuses %s without a partial proposal', (_label, source) => {
    const decision = approved(['src/Card.tsx']);
    expect(
      proposeApprovedThemeFiles({
        files: {
          'src/Card.tsx': source,
          'src/theme/tokens.stylex.ts': null,
        },
        ...decision,
      }),
    ).toMatchObject({ status: 'refused', file: 'src/Card.tsx' });
  });

  test('refuses to overwrite a different target module', () => {
    const decision = approved(['src/Card.tsx']);
    const result = proposeApprovedThemeFiles({
      files: {
        'src/Card.tsx': `/** @jsxImportSource @emotion/react */
          export const Card = () => <div css={(theme) => ({color: theme.colors.foreground})} />;`,
        'src/theme/tokens.stylex.ts': 'export const mine = true;\n',
      },
      ...decision,
    });
    expect(result).toMatchObject({
      status: 'refused',
      file: 'src/theme/tokens.stylex.ts',
      reason: 'theme target module already exists with different content',
    });
  });
});

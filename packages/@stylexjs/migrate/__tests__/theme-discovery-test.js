/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { discoverThemeFacts, parseSource, scanRepository } from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

function discover(source: string, file: string = 'src/App.tsx') {
  const parsed = parseSource(source, file);
  if (!parsed.ok) throw new Error(parsed.reason);
  return discoverThemeFacts({ ast: parsed.ast, file });
}

describe('M9 bounded theme discovery', () => {
  test('records definitions, variants, providers, aliases, casts, reads, and CSS vars', () => {
    const facts = discover(`
      import {ThemeProvider, useTheme as useEmotionTheme} from '@emotion/react';
      export const lightTheme = {
        colors: {foreground: '#111', accent: 'var(--accent)'},
        space: {small: 4},
      };
      export const darkTheme = {
        colors: {foreground: '#eee', accent: 'var(--accent-dark)'},
        space: {small: 4},
      };
      const Card = () => {
        const theme = useEmotionTheme();
        const palette = theme.colors;
        const foreground = palette.foreground as string;
        return <div css={{color: foreground}} />;
      };
      export const App = () => <ThemeProvider theme={darkTheme}><Card /></ThemeProvider>;
    `);
    const byKind = (kind: string) => facts.filter((fact) => fact.kind === kind);
    expect(byKind('theme-definition')).toHaveLength(2);
    expect(byKind('theme-definition')[0].status).toBe('known');
    expect(byKind('theme-definition').map((fact) => fact.value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          existingCssVariables: expect.arrayContaining(['--accent']),
        }),
      ]),
    );
    expect(byKind('theme-provider')[0]).toMatchObject({
      status: 'known',
      value: { variant: 'darkTheme' },
    });
    expect(byKind('theme-variant')[0]).toMatchObject({ status: 'known' });
    expect(byKind('theme-alias')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'known',
          value: { name: 'palette', sourcePath: 'colors' },
        }),
      ]),
    );
    expect(byKind('theme-read').map((fact) => fact.value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourcePath: 'colors.foreground' }),
      ]),
    );
    expect(byKind('theme-cast')[0]).toMatchObject({ status: 'known' });
  });

  test('marks callback reads and unresolved definition values as inferred', () => {
    const facts = discover(`
      /** @jsxImportSource @emotion/react */
      import {ThemeProvider} from '@emotion/react';
      const tenantTheme = {colors: {foreground: getTenantColor()}};
      export const App = () => (
        <ThemeProvider theme={tenantTheme}>
          <div css={(theme) => ({color: theme.colors.foreground})} />
        </ThemeProvider>
      );
    `);
    expect(
      facts.find((fact) => fact.kind === 'theme-definition'),
    ).toMatchObject({
      status: 'inferred',
      value: { unresolvedPaths: ['colors.foreground'] },
    });
    expect(facts.find((fact) => fact.kind === 'theme-read')).toMatchObject({
      status: 'inferred',
      value: { sourcePath: 'colors.foreground' },
    });
  });

  test('attaches theme facts to inventory sites and declared inputs', () => {
    const repo = createTempRepo({
      'src/App.tsx': `/** @jsxImportSource @emotion/react */
        import {useTheme} from '@emotion/react';
        export const lightTheme = {colors: {foreground: '#111'}};
        export const App = () => {
          const theme = useTheme();
          return <div css={{color: theme.colors.foreground}} />;
        };`,
    });
    try {
      const inventory = scanRepository({ repositoryRoot: repo });
      const themeFacts = inventory.facts.filter((fact) =>
        fact.kind.startsWith('theme-'),
      );
      expect(themeFacts.length).toBeGreaterThan(1);
      expect(inventory.sites[0].factIds).toEqual(
        expect.arrayContaining(themeFacts.map((fact) => fact.id)),
      );
      expect(inventory.sites[0]).toMatchObject({
        classification: 'repeatable-contextual',
        refusalReason: 'non-literal-value',
      });
    } finally {
      removeTempDir(repo);
    }
  });
});

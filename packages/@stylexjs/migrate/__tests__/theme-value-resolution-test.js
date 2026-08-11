/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  resolveThemeDecisionDefinition,
  resolveThemeValue,
} from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

describe('theme value resolution', () => {
  let repo: string;

  afterEach(() => removeTempDir(repo));

  test('resolves requested values through aliases, helpers, spreads, and tsconfig paths', () => {
    repo = createTempRepo({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { 'app/*': ['src/*'] },
        },
      }),
      'src/tokens/colors.ts': `export const colors = {
  light: {foreground: '#111'},
  dark: {foreground: '#eee'},
};
`,
      'src/base.ts': `import {colors} from 'app/tokens/colors';
export const baseLight = {tokens: {content: {primary: colors.light.foreground}}};
export const baseDark = {tokens: {content: {primary: colors.dark.foreground}}};
`,
      'src/theme.ts': `import {baseLight, baseDark} from './base';
const utility = () => ({visuallyHidden: {position: 'absolute'}});
const common = {space: {small: 4}};
const lightDefinition = {
  ...common,
  ...baseLight,
  ...utility(),
};
export const lightTheme = lightDefinition;
export const darkTheme = {
  ...common,
  ...baseDark,
  ...utility(),
};
`,
    });

    expect(
      resolveThemeValue({
        repositoryRoot: repo,
        moduleFile: 'src/theme.ts',
        exportName: 'lightTheme',
        sourcePath: 'tokens.content.primary',
      }),
    ).toEqual({
      status: 'known',
      value: '#111',
      inputFiles: ['src/base.ts', 'src/theme.ts', 'src/tokens/colors.ts'],
    });
    expect(
      resolveThemeValue({
        repositoryRoot: repo,
        moduleFile: 'src/theme.ts',
        exportName: 'darkTheme',
        sourcePath: 'space.small',
      }),
    ).toMatchObject({ status: 'known', value: 4 });
  });

  test('resolves re-exports, namespace imports, casts, templates, and signed numbers', () => {
    repo = createTempRepo({
      'src/values.ts': `const actual = {
  text: \`#fff\`,
  offset: -2,
};
export {actual as values};
`,
      'src/index.ts': "export {values as palette} from './values';\n",
      'src/theme.ts': `import * as tokens from './index';
export const theme = ({colors: tokens.palette} as const);
`,
    });
    expect(
      resolveThemeValue({
        repositoryRoot: repo,
        moduleFile: 'src/theme.ts',
        exportName: 'theme',
        sourcePath: 'colors.text',
      }),
    ).toMatchObject({ status: 'known', value: '#fff' });
    expect(
      resolveThemeValue({
        repositoryRoot: repo,
        moduleFile: 'src/theme.ts',
        exportName: 'theme',
        sourcePath: 'colors.offset',
      }),
    ).toMatchObject({ status: 'known', value: -2 });
  });

  test('refuses optional members and uncertain later overrides', () => {
    repo = createTempRepo({
      'src/theme.ts': `const dynamic = getRuntimeTheme();
const source = {foreground: '#111'};
export const optionalTheme = {colors: source?.colors};
export const spreadTheme = {colors: {foreground: '#111'}, ...dynamic};
`,
    });
    expect(
      resolveThemeValue({
        repositoryRoot: repo,
        moduleFile: 'src/theme.ts',
        exportName: 'optionalTheme',
        sourcePath: 'colors.foreground',
      }),
    ).toMatchObject({ status: 'resolution-failed' });
    expect(
      resolveThemeValue({
        repositoryRoot: repo,
        moduleFile: 'src/theme.ts',
        exportName: 'spreadTheme',
        sourcePath: 'colors.foreground',
      }),
    ).toMatchObject({ status: 'resolution-failed' });
  });

  test('does not evaluate unrelated unsupported branches', () => {
    repo = createTempRepo({
      'src/theme.ts': `export const theme = {
  colors: {foreground: '#111'},
  runtimeOnly: makeRuntimeValue(user),
};
`,
    });
    expect(
      resolveThemeValue({
        repositoryRoot: repo,
        moduleFile: 'src/theme.ts',
        exportName: 'theme',
        sourcePath: 'colors.foreground',
      }),
    ).toMatchObject({ status: 'known', value: '#111' });
  });

  test('hydrates a decision map and pins every transitive source module', () => {
    repo = createTempRepo({
      'src/tokens.ts': 'export const palette = {light: \'#111\', dark: \'#eee\'};\n',
      'src/theme.ts': `import {palette} from './tokens';
export const lightTheme = {colors: {foreground: palette.light}};
export const darkTheme = {colors: {foreground: palette.dark}};
`,
    });
    expect(
      resolveThemeDecisionDefinition({
        repositoryRoot: repo,
        definition: {
          variants: [
            { name: 'light', exportName: 'lightTheme' },
            { name: 'dark', exportName: 'darkTheme' },
          ],
          tokens: [
            {
              sourcePath: 'colors.foreground',
              targetName: 'foreground',
              existingCssVariable: null,
            },
          ],
          sourceFiles: ['src/theme.ts'],
        },
      }),
    ).toMatchObject({
      sourceFiles: ['src/theme.ts', 'src/tokens.ts'],
      tokens: [
        {
          sourcePath: 'colors.foreground',
          values: { light: '#111', dark: '#eee' },
        },
      ],
    });
  });

  test('refuses a supplied value that differs from source', () => {
    repo = createTempRepo({
      'src/theme.ts': 'export const lightTheme = {color: \'#111\'};\n',
    });
    expect(() =>
      resolveThemeDecisionDefinition({
        repositoryRoot: repo,
        definition: {
          variants: [{ name: 'light', exportName: 'lightTheme' }],
          tokens: [
            {
              sourcePath: 'color',
              values: { light: '#wrong' },
            },
          ],
          sourceFiles: ['src/theme.ts'],
        },
      }),
    ).toThrow('does not match source');
  });
});

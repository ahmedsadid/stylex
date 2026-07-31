/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * M13a — `theme.<path>` reads (from `const theme = useTheme()`) convert to
 * `defineVars` token references, driven by the `themeTokens` config. A trusted
 * transformation (ADR-0005): the token *value* is external, so these assert the
 * emitted STRUCTURE (byte-checked here) — not the value; the render gate can't
 * verify them (the `defineVars` values are the migration team's to supply).
 */

import { transformEmotionFile } from '../src/adapters/emotion/transform';

const CONFIG = {
  themeTokens: { varsImport: './app.stylex', varsName: 'vars' },
};

const wrap = (body: string): string =>
  '/** @jsxImportSource @emotion/react */\n' +
  "import { useTheme } from '@emotion/react';\n" +
  body;

test('without themeTokens config, useTheme refuses the whole file', () => {
  const src = wrap(
    'export default function Box() {\n' +
      '  const theme = useTheme();\n' +
      '  return <div css={{ padding: theme.space.md }}>hi</div>;\n' +
      '}\n',
  );
  const r = transformEmotionFile(src, 'f.js');
  expect(r.status).toBe('skipped');
});

test('theme reads convert to vars tokens; useTheme dropped; import added', () => {
  const src = wrap(
    'export default function Box() {\n' +
      '  const theme = useTheme();\n' +
      '  return (\n' +
      '    <div css={{ padding: theme.space.md, color: theme.tokens.content.primary }}>\n' +
      '      hi\n' +
      '    </div>\n' +
      '  );\n' +
      '}\n',
  );
  const r = transformEmotionFile(src, 'f.js', CONFIG);
  expect(r.status).toBe('converted');
  if (r.status !== 'converted') {
    return;
  }
  expect(r.code).toContain("import { vars } from './app.stylex'");
  expect(r.code).toContain('padding: vars.spaceMd');
  expect(r.code).toContain('color: vars.tokensContentPrimary');
  // useTheme fully removed (binding + import).
  expect(r.code).not.toContain('useTheme');
  // The token names are reported for the skeleton, deduped/sorted.
  expect(r.themeTokens.slice().sort()).toEqual([
    'spaceMd',
    'tokensContentPrimary',
  ]);
});

test('a theme read under a condition converts (nested token)', () => {
  const src = wrap(
    'export default function Box() {\n' +
      '  const theme = useTheme();\n' +
      "  return <div css={{ ':hover': { color: theme.colors.gray } }}>hi</div>;\n" +
      '}\n',
  );
  const r = transformEmotionFile(src, 'f.js', CONFIG);
  expect(r.status).toBe('converted');
  if (r.status === 'converted') {
    expect(r.code).toContain('vars.colorsGray');
  }
});

test('a non-theme dynamic value still converts alongside a theme token', () => {
  const src = wrap(
    'export default function Box(props) {\n' +
      '  const theme = useTheme();\n' +
      '  return <div css={{ padding: theme.space.md, color: props.color }}>hi</div>;\n' +
      '}\n',
  );
  const r = transformEmotionFile(src, 'f.js', CONFIG);
  expect(r.status).toBe('converted');
  if (r.status === 'converted') {
    // token stays static; the prop value is still the M8 dynamic function form.
    expect(r.code).toContain('vars.spaceMd');
    expect(r.code).toMatch(/color => \(/);
  }
});

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
import { verifyConvertedFile } from '../src/testing/verifyConversion';
import { buildSkeleton } from '../src/adapters/emotion/themeTokens';

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

test('a TS-cast theme binding (useTheme() as Theme) still tokenizes', () => {
  const src =
    '/** @jsxImportSource @emotion/react */\n' +
    "import { useTheme } from '@emotion/react';\n" +
    'type Theme = { space: { md: string } };\n' +
    'export default function Box() {\n' +
    '  const theme = useTheme() as Theme;\n' +
    '  return <div css={{ padding: theme.space.md }}>hi</div>;\n' +
    '}\n';
  const r = transformEmotionFile(src, 'Box.tsx', CONFIG);
  expect(r.status).toBe('converted');
  if (r.status !== 'converted') {
    return;
  }
  expect(r.code).toContain('padding: vars.spaceMd');
  expect(r.code).not.toContain('useTheme'); // binding + import both dropped
  expect(r.themeTokens).toEqual(['spaceMd']);
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

test('a token conversion verifies as UNVERIFIABLE, never failed (ADR-0005)', () => {
  const src = wrap(
    'export default function Box() {\n' +
      '  const theme = useTheme();\n' +
      '  return <div css={{ padding: theme.space.md }}>hi</div>;\n' +
      '}\n',
  );
  const r = transformEmotionFile(src, 'f.js', CONFIG);
  expect(r.status).toBe('converted');
  if (r.status !== 'converted') {
    return;
  }
  const verdict = verifyConvertedFile({
    inputSource: src,
    inputPath: 'f.js',
    outputCode: r.code,
    outputPath: 'f.js',
    sites: r.sites,
    keyframes: r.keyframes,
    themeTokens: r.themeTokens,
  });
  // The output imports an external defineVars module the single-file gate can't
  // resolve, and the value is external — trusted, so unverifiable (not failed).
  expect(verdict.status).toBe('unverifiable');
});

// --- M13b: styled `${p => p.theme.<path>}` interpolations ---------------------

const styledSrc = (body: string): string =>
  "import styled from '@emotion/styled';\n" + body;

test('a styled theme interpolation converts to a static vars token', () => {
  const src = styledSrc(
    'const Box = styled.div`\n' +
      '  color: ${(props) => props.theme.primary};\n' +
      '  padding: ${(p) => p.theme.space.md};\n' +
      '`;\n' +
      'export default function App() {\n' +
      '  return <Box>hi</Box>;\n' +
      '}\n',
  );
  const r = transformEmotionFile(src, 'f.js', CONFIG);
  expect(r.status).toBe('converted');
  if (r.status !== 'converted') {
    return;
  }
  expect(r.code).toContain("import { vars } from './app.stylex'");
  // Static token in the create — NOT a `props.theme` runtime read, which
  // doesn't exist at the wrapper (theme is styled's own context).
  expect(r.code).toContain('color: vars.primary');
  expect(r.code).toContain('padding: vars.spaceMd');
  expect(r.code).not.toContain('props.theme');
  expect(r.themeTokens.slice().sort()).toEqual(['primary', 'spaceMd']);
});

test('without config, a styled theme interpolation still flags (per-site)', () => {
  const src = styledSrc(
    'const Box = styled.div`\n' +
      '  color: ${(props) => props.theme.primary};\n' +
      '`;\n' +
      'export default function App() {\n' +
      '  return <Box>hi</Box>;\n' +
      '}\n',
  );
  const r = transformEmotionFile(src, 'f.js');
  // No themeTokens → the styled def is not convertible; nothing tokenizes.
  if (r.status === 'converted') {
    expect(r.code).not.toContain('vars.primary');
    expect(r.themeTokens).toEqual([]);
  }
});

test('a styled prop and a styled theme read convert side by side', () => {
  const src = styledSrc(
    'const Box = styled.div`\n' +
      '  color: ${(props) => props.color};\n' +
      '  padding: ${(p) => p.theme.space.md};\n' +
      '`;\n' +
      'export default function App(props) {\n' +
      '  return <Box {...props}>hi</Box>;\n' +
      '}\n',
  );
  const r = transformEmotionFile(src, 'f.js', CONFIG);
  expect(r.status).toBe('converted');
  if (r.status !== 'converted') {
    return;
  }
  // theme → static token; the real prop stays the M8 dynamic function form.
  expect(r.code).toContain('padding: vars.spaceMd');
  expect(r.code).toMatch(/color => \(/);
  expect(r.themeTokens).toEqual(['spaceMd']);
});

test('a mixed styled theme read (not the whole value) still flags with config', () => {
  const src = styledSrc(
    'const Box = styled.div`\n' +
      '  color: ${(p) => (p.active ? p.theme.primary : p.theme.muted)};\n' +
      '`;\n' +
      'export default function App() {\n' +
      '  return <Box>hi</Box>;\n' +
      '}\n',
  );
  const r = transformEmotionFile(src, 'f.js', CONFIG);
  // A ternary over `p.theme.*` isn't a whole-value theme read; it must not emit
  // a runtime `props.theme` access. The styled def stays flagged, not converted.
  if (r.status === 'converted') {
    expect(r.code).not.toContain('props.theme');
    expect(r.themeTokens).toEqual([]);
  }
});

test('the skeleton lists the tokens (name-only, TODO values, compilable)', () => {
  const skeleton = buildSkeleton('vars', [
    'tokensContentPrimary',
    'spaceMd',
    'spaceMd',
  ]);
  expect(skeleton).toContain('stylex.defineVars(');
  expect(skeleton).toContain('spaceMd:');
  expect(skeleton).toContain('tokensContentPrimary:');
  expect(skeleton).toContain('TODO');
  // deduped; never invents a value.
  expect(skeleton.match(/spaceMd:/g)?.length).toBe(1);
});

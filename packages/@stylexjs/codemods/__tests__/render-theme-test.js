/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Theme render-check (`renderTheme`). The load-bearing test is the
 * ANTI-TAUTOLOGY one: a deliberately-wrong authored `defineVars` value must
 * produce a `mismatch`. A confidence check that cannot fail is worse than none,
 * so proving it CAN fail is the whole point. Plus: a correct value matches, the
 * placeholder skeleton is refused up front, and `isSkeletonVars` detects it.
 */

import { verifyThemeRender, isSkeletonVars } from '../src/testing/renderTheme';
import { buildSkeleton } from '../src/adapters/emotion/themeTokens';

const emotionInput =
  '/** @jsxImportSource @emotion/react */\n' +
  "import { useTheme } from '@emotion/react';\n" +
  'export default function App() {\n' +
  '  const theme = useTheme();\n' +
  '  return <div css={{ padding: theme.space.md }}>hi</div>;\n' +
  '}\n';

const stylexOutput =
  "import * as stylex from '@stylexjs/stylex';\n" +
  "import { vars } from './app.stylex';\n" +
  'const styles = stylex.create({ box: { padding: vars.spaceMd } });\n' +
  'export default function App() {\n' +
  '  return <div {...stylex.props(styles.box)}>hi</div>;\n' +
  '}\n';

// INDEPENDENT SOURCE A: the real runtime theme (space.md = 16px).
const themeModuleSource = "export default { space: { md: '16px' } };\n";

const varsModule = (spaceMd: string): string =>
  "import * as stylex from '@stylexjs/stylex';\n" +
  `export const vars = stylex.defineVars({ spaceMd: '${spaceMd}' });\n`;

const inputs = (spaceMd: string) => ({
  emotionInput,
  stylexOutput,
  themeModuleSource, // 16px, authored independently
  varsModuleSource: varsModule(spaceMd), // INDEPENDENT SOURCE B
  varsImportPath: './app.stylex',
});

test('a correct authored value renders identically (or cleanly unavailable)', async () => {
  const verdict = await verifyThemeRender(inputs('16px'));
  if (verdict.status === 'unavailable') {
    return; // no browser — opt-in gate stays green
  }
  expect(verdict.status).toBe('match');
}, 60000);

test('ANTI-TAUTOLOGY: a wrong authored value is caught as a mismatch', async () => {
  // The theme says 16px; the defineVars was (mis)authored 20px. Because the two
  // sides draw from independent sources, the camera MUST see the difference.
  const verdict = await verifyThemeRender(inputs('20px'));
  if (verdict.status === 'unavailable') {
    return; // can't prove it here without a browser; proven in CI where present
  }
  expect(verdict.status).toBe('mismatch');
  if (verdict.status === 'mismatch') {
    expect(verdict.diffs.some((d) => d.property.includes('padding'))).toBe(
      true,
    );
  }
}, 60000);

test('a .tsx component + .ts theme render-check (TS stripped by extension)', async () => {
  // The confidence workflow is most needed on TypeScript codebases; the render
  // pipeline strips TS by the filename extension so these don't just skip.
  const tsInput =
    '/** @jsxImportSource @emotion/react */\n' +
    "import { useTheme } from '@emotion/react';\n" +
    'type Theme = { space: { md: string } };\n' +
    'const meta = { k: 1 } satisfies Record<string, number>;\n' +
    'export default function Box(): React.ReactElement {\n' +
    '  const theme = useTheme();\n' +
    '  return <div css={{ padding: theme.space.md }}>hi{meta.k}</div>;\n' +
    '}\n';
  const tsOutput =
    "import * as stylex from '@stylexjs/stylex';\n" +
    "import { vars } from './app.stylex';\n" +
    'const styles = stylex.create({ box: { padding: vars.spaceMd } });\n' +
    'export default function Box(): React.ReactElement {\n' +
    '  return <div {...stylex.props(styles.box)}>hi1</div>;\n' +
    '}\n';
  const tsTheme =
    'type Theme = { space: { md: string } };\n' +
    "const theme: Theme = { space: { md: '16px' } };\n" +
    'export default theme;\n';
  const base = {
    emotionInput: tsInput,
    stylexOutput: tsOutput,
    themeModuleSource: tsTheme,
    varsImportPath: './app.stylex',
    componentFilename: 'Box.tsx',
    themeFilename: 'theme.ts',
  };
  const ok = await verifyThemeRender({
    ...base,
    varsModuleSource: varsModule('16px'),
  });
  if (ok.status === 'unavailable') {
    return;
  }
  expect(ok.status).toBe('match');
  const wrong = await verifyThemeRender({
    ...base,
    varsModuleSource: varsModule('20px'),
  });
  expect(wrong.status).toBe('mismatch'); // anti-tautology holds under TS too
}, 60000);

test('the placeholder skeleton is refused up front (no false alarms)', async () => {
  const skeleton = buildSkeleton('vars', ['spaceMd']);
  const verdict = await verifyThemeRender({
    ...inputs('16px'),
    varsModuleSource: skeleton,
  });
  expect(verdict.status).toBe('placeholder');
  if (verdict.status === 'placeholder') {
    expect(verdict.reason).toMatch(/placeholder/i);
  }
});

test('isSkeletonVars detects the generated skeleton, not a real module', () => {
  expect(isSkeletonVars(buildSkeleton('vars', ['spaceMd', 'colorFg']))).toBe(
    true,
  );
  expect(isSkeletonVars(varsModule('16px'))).toBe(false);
});

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * The confidence workflow (`renderCheck`): run the render gate over a migration.
 * Proves the three robustness properties that make it usable at scale —
 * `match` on a real conversion, graceful `skipped` when a component can't build
 * in isolation (never throws), and a clean `unavailable` short-circuit with no
 * browser — plus the batch tally / report formatting.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { transformEmotionFile } from '../src/adapters/emotion/transform';
import { runRenderCheck } from '../src/cli/renderCheckRun';
import { DEFAULT_CONFIG } from '../src/config/loadConfig';
import {
  renderCheckFile,
  renderCheckBatch,
  formatRenderCheckReport,
} from '../src/testing/renderCheck';
import type { RenderCheckReport } from '../src/testing/renderCheck';

const emotionInput =
  '/** @jsxImportSource @emotion/react */\n' +
  'export default function App() {\n' +
  "  return <div css={{ color: 'rgb(1, 2, 3)', padding: 8 }}>hi</div>;\n" +
  '}\n';

function convert(source: string, filename: string = 'in.js'): string {
  const r = transformEmotionFile(source, filename);
  if (r.status !== 'converted') {
    throw new Error(`fixture did not convert: ${r.status}`);
  }
  return r.code;
}

test('a real conversion renders identically (or cleanly unavailable)', async () => {
  const outputCode = convert(emotionInput);
  const result = await renderCheckFile({
    path: 'in.js',
    inputSource: emotionInput,
    outputCode,
  });
  if (result.status === 'unavailable') {
    return; // no browser here — the opt-in gate stays green
  }
  expect(result.status).toBe('match');
}, 60000);

test('a .tsx conversion renders (TS is stripped by extension, not skipped)', async () => {
  // Real TS syntax (type alias, `satisfies`, non-null) that Flow-stripping would
  // choke on — the render pipeline now picks the TS stripper by the .tsx filename.
  const tsx =
    '/** @jsxImportSource @emotion/react */\n' +
    'type P = { label: string };\n' +
    'const meta = { k: 1 } satisfies Record<string, number>;\n' +
    'export default function Box({ label }: P): React.ReactElement {\n' +
    '  const n = [8, 9][0]!;\n' +
    "  return <div css={{ color: 'rgb(3, 4, 5)', padding: n }}>{label}{meta.k}</div>;\n" +
    '}\n';
  const outputCode = convert(tsx, 'Box.tsx');
  const result = await renderCheckFile({
    path: 'Box.tsx',
    inputSource: tsx,
    outputCode,
  });
  if (result.status === 'unavailable') {
    return;
  }
  expect(result.status).toBe('match');
}, 60000);

test('a component that cannot build in isolation is SKIPPED, never throws', async () => {
  // The StyleX output references a module esbuild cannot resolve from source —
  // exactly what a real theme/local-import conversion looks like standalone.
  const outputCode =
    "import * as stylex from '@stylexjs/stylex';\n" +
    "import { vars } from './does-not-exist.stylex';\n" +
    'const styles = stylex.create({ box: { color: vars.primary } });\n' +
    'export default function App() {\n' +
    '  return <div {...stylex.props(styles.box)}>hi</div>;\n' +
    '}\n';
  const result = await renderCheckFile({
    path: 'themey.js',
    inputSource: emotionInput,
    outputCode,
  });
  expect(result.status).toBe('skipped');
  if (result.status === 'skipped') {
    expect(result.reason).toMatch(/could not render/i);
  }
}, 60000);

test('no browser → the whole batch short-circuits to unavailable', async () => {
  const prev = process.env.STYLEX_CODEMOD_RENDER_GATE;
  process.env.STYLEX_CODEMOD_RENDER_GATE = '0'; // force "no browser"
  try {
    const report = await renderCheckBatch([
      { path: 'a.js', inputSource: emotionInput, outputCode: 'x' },
      { path: 'b.js', inputSource: emotionInput, outputCode: 'y' },
    ]);
    expect(report.unavailable).toBe(2);
    expect(report.matched).toBe(0);
    expect(report.results.every((r) => r.status === 'unavailable')).toBe(true);
  } finally {
    if (prev == null) {
      delete process.env.STYLEX_CODEMOD_RENDER_GATE;
    } else {
      process.env.STYLEX_CODEMOD_RENDER_GATE = prev;
    }
  }
}, 30000);

test('runRenderCheck drives the gate over a real dir (clean conversions only)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stylex-rc-'));
  // A clean conversion (checked) and a partial one (has a flagged site → skipped
  // from the render check, since its output still carries Emotion css).
  fs.writeFileSync(path.join(dir, 'clean.jsx'), emotionInput);
  fs.writeFileSync(
    path.join(dir, 'partial.jsx'),
    '/** @jsxImportSource @emotion/react */\n' +
      'export default function P() {\n' +
      "  return <div css={{ color: 'red', '& span': { color: 'blue' } }}>x</div>;\n" +
      '}\n',
  );
  const report = await runRenderCheck({
    patterns: ['*.jsx'],
    cwd: dir,
    config: DEFAULT_CONFIG,
  });
  // Exactly one file is render-checked (the clean one); the partial is excluded.
  expect(report.results.length).toBe(1);
  expect(report.results[0].path).toMatch(/clean\.jsx$/);
  // Its verdict is match (browser present) or unavailable (none) — never a crash.
  expect(['match', 'unavailable']).toContain(report.results[0].status);
}, 60000);

describe('runRenderCheck routes theme conversions to the theme check', () => {
  const themeComponent =
    '/** @jsxImportSource @emotion/react */\n' +
    "import { useTheme } from '@emotion/react';\n" +
    'export default function Box() {\n' +
    '  const theme = useTheme();\n' +
    '  return <div css={{ padding: theme.space.md }}>hi</div>;\n' +
    '}\n';
  const themeModule = "export default { space: { md: '16px' } };\n";
  const varsModule = (v: string) =>
    "import * as stylex from '@stylexjs/stylex';\n" +
    `export const vars = stylex.defineVars({ spaceMd: '${v}' });\n`;

  function setup(dir: string, varsValue: string) {
    fs.writeFileSync(path.join(dir, 'Box.jsx'), themeComponent);
    fs.writeFileSync(path.join(dir, 'theme.js'), themeModule);
    fs.writeFileSync(path.join(dir, 'app.stylex.js'), varsModule(varsValue));
    return {
      ...DEFAULT_CONFIG,
      themeTokens: {
        varsImport: './app.stylex',
        varsName: 'vars',
        themePath: 'theme.js',
        varsPath: 'app.stylex.js',
      },
    };
  }

  test('a correct authored value matches (or is cleanly unavailable)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stylex-rct-'));
    const report = await runRenderCheck({
      patterns: ['Box.jsx'],
      cwd: dir,
      config: setup(dir, '16px'),
    });
    expect(report.results.length).toBe(1);
    expect(['match', 'unavailable']).toContain(report.results[0].status);
  }, 60000);

  test('a WRONG authored value is caught as a mismatch (anti-tautology, e2e)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stylex-rct-'));
    const report = await runRenderCheck({
      patterns: ['Box.jsx'],
      cwd: dir,
      config: setup(dir, '20px'), // theme says 16px
    });
    expect(['mismatch', 'unavailable']).toContain(report.results[0].status);
  }, 60000);
});

test('the report formatter summarizes counts and lists what to review', () => {
  const report: RenderCheckReport = {
    matched: 3,
    mismatched: 1,
    skipped: 2,
    placeholder: 0,
    unavailable: 0,
    results: [
      { path: '/repo/a.js', status: 'match' },
      {
        path: '/repo/b.js',
        status: 'mismatch',
        props: {},
        diffs: [{ path: '', property: 'color', before: 'red', after: 'blue' }],
      },
      { path: '/repo/c.js', status: 'skipped', reason: 'could not render' },
    ],
  };
  const text = formatRenderCheckReport(report, '/repo');
  expect(text).toContain('3 matched');
  expect(text).toContain('1 DIFFER');
  expect(text).toContain('b.js');
  expect(text).toContain('color: red → blue');
  expect(text).toContain('c.js'); // listed under "could not render"
});

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadConfig,
  validateConfig,
  DEFAULT_CONFIG,
  ConfigError,
} from '../src/config/loadConfig';
import { runCodemod } from '../src/cli/run';
import { formatReport } from '../src/cli/report';

const CONVERTIBLE =
  '/** @jsxImportSource @emotion/react */\n' +
  "import * as React from 'react';\n" +
  'export default function A() {\n' +
  "  return <div css={{ color: 'red' }}>A</div>;\n" +
  '}\n';

const FLAGGED =
  '/** @jsxImportSource @emotion/react */\n' +
  "import * as React from 'react';\n" +
  'export default function B() {\n' +
  "  return <span css={{ '& > li': { color: 'red' } }}>B</span>;\n" +
  '}\n';

const REFUSED =
  '/** @jsxImportSource @emotion/react */\n' +
  "import * as React from 'react';\n" +
  "import { create } from '@stylexjs/stylex';\n" +
  "const s = create({ a: { color: 'red' } });\n" +
  'export default function C() {\n' +
  "  return <span css={{ color: 'gray' }}>{s ? 'x' : 'y'}</span>;\n" +
  '}\n';

const PLAIN = 'export default function D() {\n  return null;\n}\n';

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stylex-codemod-'));
  fs.writeFileSync(path.join(dir, 'convert.jsx'), CONVERTIBLE);
  fs.writeFileSync(path.join(dir, 'flag.jsx'), FLAGGED);
  fs.writeFileSync(path.join(dir, 'refuse.jsx'), REFUSED);
  fs.writeFileSync(path.join(dir, 'plain.jsx'), PLAIN);
  return dir;
}

describe('loadConfig', () => {
  test('missing config falls back to defaults', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stylex-cfg-'));
    expect(loadConfig({ cwd: dir })).toEqual(DEFAULT_CONFIG);
  });

  test('an explicit missing config path throws', () => {
    expect(() => loadConfig({ configPath: '/nope/x.js' })).toThrow(ConfigError);
  });

  test('validates and merges over defaults', () => {
    expect(validateConfig({ hoverGuard: false }, 'x')).toEqual({
      hoverGuard: false,
      logicalProperties: true,
      themeTokens: null,
      renderCases: [],
    });
  });

  test('unknown option throws', () => {
    expect(() => validateConfig({ nope: true }, 'x')).toThrow(/unknown option/);
  });

  test('non-boolean option throws', () => {
    expect(() => validateConfig({ hoverGuard: 'yes' }, 'x')).toThrow(
      /must be a boolean/,
    );
  });

  test('themeTokens: a valid object is accepted, a malformed one throws', () => {
    expect(
      validateConfig(
        { themeTokens: { varsImport: './app.stylex', varsName: 'vars' } },
        'x',
      ).themeTokens,
    ).toEqual({ varsImport: './app.stylex', varsName: 'vars' });
    expect(() =>
      validateConfig({ themeTokens: { varsImport: './x' } }, 'x'),
    ).toThrow(/varsImport.*varsName|varsName/);
  });

  test('renderCases: a valid array is accepted, a malformed one throws', () => {
    expect(
      validateConfig(
        { renderCases: [{ include: 'Button', cases: [{ size: 'lg' }, {}] }] },
        'x',
      ).renderCases,
    ).toEqual([{ include: 'Button', cases: [{ size: 'lg' }, {}] }]);
    expect(() =>
      validateConfig({ renderCases: [{ include: 42, cases: [] }] }, 'x'),
    ).toThrow(/include must be a string/);
    expect(() =>
      validateConfig({ renderCases: [{ include: 'x', cases: [1] }] }, 'x'),
    ).toThrow(/cases must be an array of prop objects/);
  });
});

describe('runCodemod (dry run is the default)', () => {
  test('reports convert / flag / refuse / unchanged without writing', () => {
    const dir = makeProject();
    const before = fs.readFileSync(path.join(dir, 'convert.jsx'), 'utf8');
    const report = runCodemod({
      patterns: ['*.jsx'],
      cwd: dir,
      config: DEFAULT_CONFIG,
      write: false,
    });
    expect(report.dryRun).toBe(true);
    expect(report.summary).toMatchObject({
      files: 4,
      converted: 1, // convert.jsx (no flags)
      partiallyConverted: 1, // flag.jsx (a TODO)
      skipped: 1, // refuse.jsx
      unchanged: 1, // plain.jsx
    });
    expect(report.summary.totalFlags).toBe(1);
    // Dry run wrote nothing.
    expect(fs.readFileSync(path.join(dir, 'convert.jsx'), 'utf8')).toEqual(
      before,
    );
    expect(report.results.every((r) => r.wrote === false)).toBe(true);
  });

  test('--write applies the conversion to disk', () => {
    const dir = makeProject();
    runCodemod({
      patterns: ['convert.jsx'],
      cwd: dir,
      config: DEFAULT_CONFIG,
      write: true,
    });
    const after = fs.readFileSync(path.join(dir, 'convert.jsx'), 'utf8');
    expect(after).toContain('stylex.props(styles.a)');
    expect(after).not.toContain('css={{');
  });

  test('logicalProperties: false is threaded through', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stylex-opt-'));
    fs.writeFileSync(
      path.join(dir, 'a.jsx'),
      '/** @jsxImportSource @emotion/react */\n' +
        "import * as React from 'react';\n" +
        'export default function A() {\n' +
        '  return <div css={{ marginLeft: 8 }}>A</div>;\n' +
        '}\n',
    );
    runCodemod({
      patterns: ['a.jsx'],
      cwd: dir,
      config: {
        hoverGuard: true,
        logicalProperties: false,
        themeTokens: null,
        renderCases: [],
      },
      write: true,
    });
    const after = fs.readFileSync(path.join(dir, 'a.jsx'), 'utf8');
    expect(after).toContain('marginLeft'); // NOT converted to marginInlineStart
  });

  test('themeTokens: converts theme reads and writes the vars skeleton', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stylex-theme-'));
    fs.writeFileSync(
      path.join(dir, 'a.jsx'),
      '/** @jsxImportSource @emotion/react */\n' +
        "import { useTheme } from '@emotion/react';\n" +
        'export default function A() {\n' +
        '  const theme = useTheme();\n' +
        '  return <div css={{ padding: theme.space.md }}>A</div>;\n' +
        '}\n',
    );
    const report = runCodemod({
      patterns: ['a.jsx'],
      cwd: dir,
      config: {
        hoverGuard: true,
        logicalProperties: true,
        themeTokens: { varsImport: './app.stylex', varsName: 'vars' },
        renderCases: [],
      },
      write: true,
    });
    expect(fs.readFileSync(path.join(dir, 'a.jsx'), 'utf8')).toContain(
      'vars.spaceMd',
    );
    // The skeleton is reported and written (name-only) next to the run.
    expect(report.themeSkeleton).not.toBeNull();
    const skeletonPath = path.join(dir, 'app.stylex.js');
    expect(fs.existsSync(skeletonPath)).toBe(true);
    expect(fs.readFileSync(skeletonPath, 'utf8')).toContain('spaceMd:');
  });
});

describe('formatReport', () => {
  test('renders a preview with a summary and an apply hint', () => {
    const dir = makeProject();
    const report = runCodemod({
      patterns: ['*.jsx'],
      cwd: dir,
      config: DEFAULT_CONFIG,
      write: false,
    });
    const text = formatReport(report, { cwd: dir });
    expect(text).toContain('Dry run');
    expect(text).toMatch(/convert\.jsx/);
    expect(text).toMatch(/\+1 TODO/); // flag.jsx marker count
    expect(text).toMatch(/refuse\.jsx/);
    expect(text).toContain('Re-run with --write to apply.');
    // unchanged file hidden unless verbose
    expect(text).not.toMatch(/plain\.jsx/);
  });

  test('ranks the top flag/refusal reasons, bucketing specifics', () => {
    const outcome = (over: $FlowFixMe) => ({
      file: 'f',
      status: 'converted',
      flags: [],
      reasons: [],
      wrote: false,
      ...over,
    });
    const report = {
      dryRun: true,
      themeSkeleton: null,
      results: [
        // Two partials flagged for the same reason (different quoted names) →
        // should bucket to one "styled(…) component" entry with count 2.
        outcome({ flags: ["styled('Button') component"] }),
        outcome({ flags: ["styled('Card') component"] }),
        outcome({ flags: ['css on a component element'] }),
        outcome({
          status: 'skipped',
          reasons: ["import from 'x' is not convertible yet"],
        }),
      ],
      summary: {
        files: 4,
        converted: 0,
        partiallyConverted: 3,
        skipped: 1,
        unchanged: 0,
        errors: 0,
        totalFlags: 3,
      },
    };
    const text = formatReport(report);
    expect(text).toContain('Top reasons sites were flagged');
    expect(text).toMatch(/2 {2}styled\(…\) component/); // bucketed count
    expect(text).toContain('Top reasons files were refused');
    expect(text).toMatch(/import from '…' is not convertible yet/);
  });

  test('shows the trust callout after a conversion, and a legend when complex', () => {
    const base: $FlowFixMe = {
      dryRun: true,
      themeSkeleton: null,
      results: [
        {
          file: 'a.jsx',
          status: 'converted',
          flags: ['css on a component element'],
          reasons: [],
          wrote: false,
        },
      ],
      summary: {
        files: 1,
        converted: 0,
        partiallyConverted: 1,
        skipped: 0,
        unchanged: 0,
        errors: 0,
        totalFlags: 1,
      },
    };
    const text = formatReport(base);
    expect(text).toContain('TRUSTED'); // trust model made visible
    expect(text).toContain('--render-check');
    expect(text).toMatch(/legend|convert = rewritten/); // legend shown (complex)
  });

  test('an all-clean run stays terse (no legend, still the trust line)', () => {
    const report: $FlowFixMe = {
      dryRun: true,
      themeSkeleton: null,
      results: [
        {
          file: 'a.jsx',
          status: 'converted',
          flags: [],
          reasons: [],
          wrote: false,
        },
      ],
      summary: {
        files: 1,
        converted: 1,
        partiallyConverted: 0,
        skipped: 0,
        unchanged: 0,
        errors: 0,
        totalFlags: 0,
      },
    };
    const text = formatReport(report);
    expect(text).not.toContain('convert = rewritten'); // no legend needed
    expect(text).toContain('TRUSTED'); // still explains the trust model
  });
});

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
  applyThemeFlags,
  DEFAULT_CONFIG,
  ConfigError,
} from '../src/config/loadConfig';
import { runCodemod } from '../src/cli/run';
import { formatReport } from '../src/cli/report';
import { runInit } from '../src/cli/init';
import { makeProgress } from '../src/cli/progress';
import { main } from '../src/cli/index';

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

  test('applyThemeFlags: --theme-vars configures theme without a config file', () => {
    const cfg = applyThemeFlags(DEFAULT_CONFIG, {
      themeVars: 'vars:./app.stylex',
    });
    expect(cfg.themeTokens).toEqual({
      varsName: 'vars',
      varsImport: './app.stylex',
      themePath: undefined,
      varsPath: undefined,
    });
  });

  test('applyThemeFlags: --theme-path/--vars-path augment; bad --theme-vars throws', () => {
    const cfg = applyThemeFlags(DEFAULT_CONFIG, {
      themeVars: 'vars:./app.stylex',
      themePath: './theme',
      varsPath: './app.stylex.js',
    });
    expect(cfg.themeTokens?.themePath).toBe('./theme');
    expect(cfg.themeTokens?.varsPath).toBe('./app.stylex.js');
    // path flags alone (no themeTokens) are inert.
    expect(
      applyThemeFlags(DEFAULT_CONFIG, { themePath: './theme' }).themeTokens,
    ).toBeNull();
    // malformed value → a clear ConfigError.
    expect(() =>
      applyThemeFlags(DEFAULT_CONFIG, { themeVars: 'novalue' }),
    ).toThrow(/<name>:<import>/);
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

  test('onProgress fires once per file with (done, total)', () => {
    const dir = makeProject();
    const ticks: Array<string> = [];
    runCodemod({
      patterns: ['*.jsx'],
      cwd: dir,
      config: DEFAULT_CONFIG,
      onProgress: (done, total) => {
        ticks.push(`${done}/${total}`);
      },
    });
    expect(ticks).toEqual(['1/4', '2/4', '3/4', '4/4']);
  });

  test('makeProgress is a safe no-op when stderr is not a TTY', () => {
    // In the test runner stderr isn't a TTY, so tick/done write nothing + throw
    // nothing (guarding against progress corrupting piped/CI output).
    const p = makeProgress('Transforming');
    expect(() => {
      p.tick(1, 10);
      p.done();
    }).not.toThrow();
  });

  test('--ignore excludes extra globs on top of node_modules', () => {
    const dir = makeProject();
    fs.writeFileSync(path.join(dir, 'convert.test.jsx'), CONVERTIBLE);
    const all = runCodemod({
      patterns: ['*.jsx'],
      cwd: dir,
      config: DEFAULT_CONFIG,
    });
    const filtered = runCodemod({
      patterns: ['*.jsx'],
      cwd: dir,
      config: DEFAULT_CONFIG,
      ignore: ['**/*.test.*'],
    });
    expect(filtered.summary.files).toBe(all.summary.files - 1);
    expect(filtered.results.every((r) => !r.file.endsWith('.test.jsx'))).toBe(
      true,
    );
  });

  test('--diff attaches a unified diff to each conversion and renders it', () => {
    const dir = makeProject();
    const report = runCodemod({
      patterns: ['convert.jsx'],
      cwd: dir,
      config: DEFAULT_CONFIG,
      write: false,
      diff: true,
    });
    const converted = report.results.find((r) => r.status === 'converted');
    expect(converted?.diff).toContain('@@'); // a unified-diff hunk header
    expect(converted?.diff).toContain('+import * as stylex');
    const text = formatReport(report, { cwd: dir, diff: true });
    expect(text).toContain('+import * as stylex'); // shown under the file line
    // Without --diff the diff isn't computed.
    const noDiff = runCodemod({
      patterns: ['convert.jsx'],
      cwd: dir,
      config: DEFAULT_CONFIG,
      write: false,
    });
    expect(noDiff.results.find((r) => r.status === 'converted')?.diff).toBe(
      undefined,
    );
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

describe('main (CLI entry)', () => {
  test('--json emits a parseable structured report on stdout', async () => {
    const dir = makeProject();
    const prevCwd = process.cwd();
    const chunks: Array<string> = [];
    const out: $FlowFixMe = process.stdout;
    const origWrite = out.write;
    out.write = (s: $FlowFixMe): boolean => {
      chunks.push(String(s));
      return true;
    };
    let code;
    try {
      process.chdir(dir);
      code = await main(['emotion', '*.jsx', '--json']);
    } finally {
      out.write = origWrite;
      process.chdir(prevCwd);
    }
    const parsed = JSON.parse(chunks.join(''));
    expect(parsed.run.summary.files).toBe(4);
    expect(parsed.render).toBeNull();
    expect(code).toBe(0);
  });

  test('a bad --theme-vars exits 2 with a clear message', async () => {
    const dir = makeProject();
    const prevCwd = process.cwd();
    const errStream: $FlowFixMe = process.stderr;
    const origErr = errStream.write;
    let err = '';
    errStream.write = (s: $FlowFixMe): boolean => {
      err += String(s);
      return true;
    };
    let code;
    try {
      process.chdir(dir);
      code = await main(['emotion', '*.jsx', '--theme-vars', 'bogus']);
    } finally {
      errStream.write = origErr;
      process.chdir(prevCwd);
    }
    expect(code).toBe(2);
    expect(err).toMatch(/<name>:<import>/);
  });
});

describe('init', () => {
  test('scaffolds a VALID config + quick-start; never clobbers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stylex-init-'));
    const first = runInit(dir);
    expect(first.created).toBe(true);
    expect(fs.existsSync(path.join(dir, 'stylex-codemod.config.js'))).toBe(
      true,
    );
    expect(first.message).toContain('Quick start:');
    expect(first.message).toContain('--write');
    // The scaffold must load cleanly and equal the defaults (options commented).
    expect(loadConfig({ configPath: first.path })).toEqual(DEFAULT_CONFIG);
    // Re-running leaves it untouched.
    const second = runInit(dir);
    expect(second.created).toBe(false);
    expect(second.message).toMatch(/already exists/);
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

  test('emits tailored next-steps for the actual result', () => {
    const report: $FlowFixMe = {
      dryRun: true,
      themeSkeleton: { path: '/p/app.stylex.js', content: '' },
      results: [
        {
          file: 'a.jsx',
          status: 'converted',
          flags: ["styled('X') component"],
          reasons: [],
          wrote: false,
        },
        {
          file: 'c.tsx',
          status: 'skipped',
          flags: [],
          reasons: ["'@emotion/react' import of 'useTheme' is not convertible"],
          wrote: false,
        },
      ],
      summary: {
        files: 2,
        converted: 0,
        partiallyConverted: 1,
        skipped: 1,
        unchanged: 0,
        errors: 0,
        totalFlags: 1,
      },
    };
    const text = formatReport(report, { cwd: '/p' });
    expect(text).toContain('Next steps:');
    expect(text).toMatch(/Theme reads \(useTheme\) were refused/); // theme-blocked
    expect(text).toContain('--theme-vars');
    expect(text).toContain('Re-run with --write to apply.');
    expect(text).toMatch(/app\.stylex\.js/); // skeleton path, relativized
    expect(text).toMatch(/TODO\(stylex-migration\)/); // has-TODOs step
    expect(text).toContain('composition is left for you'); // styled(Component) step
  });

  test('a clean-no-theme run has no theme/styled steps', () => {
    const report: $FlowFixMe = {
      dryRun: false,
      themeSkeleton: null,
      results: [
        {
          file: 'a.jsx',
          status: 'converted',
          flags: [],
          reasons: [],
          wrote: true,
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
    expect(text).not.toContain('Next steps:'); // nothing actionable → no section
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

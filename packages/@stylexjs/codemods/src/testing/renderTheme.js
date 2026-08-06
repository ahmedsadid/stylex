/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Theme render-check — the confidence pass for THEME conversions, the biggest
 * "trusted, not statically verified" bucket (ADR-0005). It renders the Emotion
 * input and the StyleX output in a real browser and diffs computed styles, like
 * the rest of the render gate — but a theme conversion reads external values, so
 * each side must be given the REAL value from its own source:
 *
 *   - **Emotion (before):** wrapped in `<ThemeProvider theme={…}>` with the
 *     team's REAL runtime theme.
 *   - **StyleX (after):** compiled with the team's authored `defineVars` module
 *     resolvable (`unstable_moduleResolution: commonJS`), so `vars.spaceMd`
 *     renders its authored value and the defineVars `:root` CSS is injected.
 *
 * ## Why the two inputs are SEPARATE parameters (the anti-tautology rule)
 *
 * The whole point is to catch a wrong authored value (`spaceMd: '20px'` when the
 * theme says `16px`) or a wrong token mapping. That only works if the two sides
 * draw from INDEPENDENT sources. So `verifyThemeRender` takes the runtime theme
 * and the `defineVars` module as two distinct arguments and NEVER derives one
 * from the other — if a future change bridged them, the check could only ever
 * report "match" and would verify nothing. It is proven to be able to FAIL by
 * `render-theme-test.js` (a deliberately-wrong authored value → mismatch).
 *
 * A `defineVars` still full of the codemod's placeholder skeleton values can't be
 * meaningfully checked (it would mismatch everything) — `verifyThemeRender`
 * refuses it up front with a clear reason instead of crying wolf.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';
import * as babel from '@babel/core';
import styleXPlugin from '@stylexjs/babel-plugin';
import { RENDER_DONE_FLAG, renderStyleDiff } from './renderGate';
import type { RenderDoc } from './renderGate';
import type { VerifyRenderResult } from './renderPipeline';

// Temp files live UNDER this dir so esbuild resolves bare imports (react,
// @stylexjs/stylex) via the repo's hoisted node_modules by walking up.
const RESOLVE_DIR = __dirname;

// The normalized name the StyleX component's vars import is rewritten to, and
// the defineVars module is written as — so path shape never matters.
const VARS_MODULE = 'vars.stylex';

export type ThemeRenderVerdict =
  | VerifyRenderResult
  // The authored defineVars is still the codemod's placeholder skeleton — a
  // meaningful check needs real values first (not a mismatch, not a crash).
  | { +status: 'placeholder', +reason: string };

/** Atomic CSS from `@stylexjs/babel-plugin` metadata, priority-ordered. */
function cssFromMetadata(metadata: mixed): string {
  const rules: $FlowFixMe = (metadata as $FlowFixMe)?.stylex ?? [];
  return rules
    .slice()
    .sort((a: $FlowFixMe, b: $FlowFixMe) => (a[2] ?? 0) - (b[2] ?? 0))
    .map((rule: $FlowFixMe) => rule[1]?.ltr)
    .filter(Boolean)
    .join('\n');
}

/** Whether a `defineVars` module is still the codemod's name-only skeleton (all
 * placeholder values), so a render check would be meaningless. */
export function isSkeletonVars(varsModuleSource: string): boolean {
  return /GENERATED SKELETON \(stylex-migration/.test(varsModuleSource);
}

const mountCommon =
  "import * as React from 'react';\n" +
  "import { createRoot } from 'react-dom/client';\n" +
  "import { flushSync } from 'react-dom';\n";

/** StyleX output → a `RenderDoc` with `defineVars` resolved to its authored
 * values (both the component CSS and the `:root` var CSS injected). */
async function stylexThemeRenderDoc(
  dir: string,
  outputSource: string,
  varsModuleSource: string,
  varsImportPath: string,
  props: { +[string]: mixed },
): Promise<RenderDoc> {
  // Normalize the vars import to a sibling module so no path structure matters.
  const rewritten = outputSource
    .split(`'${varsImportPath}'`)
    .join(`'./${VARS_MODULE}'`)
    .split(`"${varsImportPath}"`)
    .join(`"./${VARS_MODULE}"`);
  fs.writeFileSync(path.join(dir, `${VARS_MODULE}.js`), varsModuleSource);
  fs.writeFileSync(path.join(dir, 'sx-component.jsx'), rewritten);
  fs.writeFileSync(
    path.join(dir, 'sx-mount.jsx'),
    "import App from './sx-component.jsx';\n" +
      mountCommon +
      `const props = ${JSON.stringify(props)};\n` +
      "flushSync(() => createRoot(document.getElementById('render-root'))" +
      '.render(React.createElement(App, props)));\n' +
      `window.${RENDER_DONE_FLAG} = true;\n`,
  );

  const cssChunks: Array<string> = [];
  const stylexBabel: $FlowFixMe = {
    name: 'stylex-babel',
    setup(build: $FlowFixMe) {
      build.onLoad({ filter: /\.(jsx?|tsx?)$/ }, (args: $FlowFixMe) => {
        if (!args.path.startsWith(dir)) {
          return undefined; // only our temp files; node_modules stay default
        }
        const compiled = babel.transformSync(
          fs.readFileSync(args.path, 'utf8'),
          {
            filename: args.path,
            // Resolve presets/plugins from the package, not the user's cwd (the
            // CLI runs from a project dir that need not have @babel/preset-*).
            cwd: RESOLVE_DIR,
            babelrc: false,
            configFile: false,
            presets: [
              '@babel/preset-flow',
              ['@babel/preset-react', { runtime: 'automatic' }],
            ],
            plugins: [
              [
                styleXPlugin,
                {
                  unstable_moduleResolution: { type: 'commonJS', rootDir: dir },
                },
              ],
            ],
          },
        );
        if (compiled != null && compiled.metadata != null) {
          cssChunks.push(cssFromMetadata(compiled.metadata));
        }
        return {
          contents: compiled?.code ?? '',
          loader: 'js',
          resolveDir: path.dirname(args.path),
        };
      });
    },
  };

  const result = await esbuild.build({
    entryPoints: [path.join(dir, 'sx-mount.jsx')],
    bundle: true,
    format: 'iife',
    write: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    absWorkingDir: dir,
    plugins: [stylexBabel],
  });
  return { script: result.outputFiles[0].text, css: cssChunks.join('\n') };
}

/** Emotion input → a `RenderDoc`, mounted under a `ThemeProvider` carrying the
 * team's REAL runtime theme (Emotion injects its own CSS). */
async function emotionThemeRenderDoc(
  dir: string,
  inputSource: string,
  themeModuleSource: string,
  props: { +[string]: mixed },
): Promise<RenderDoc> {
  const strip = (source: string, filename: string): string => {
    const out = babel.transformSync(source, {
      filename,
      cwd: RESOLVE_DIR, // resolve presets from the package, not the user's cwd
      babelrc: false,
      configFile: false,
      presets: ['@babel/preset-flow'],
      plugins: ['@babel/plugin-syntax-jsx'],
    });
    if (out == null || out.code == null) {
      throw new Error(`theme render: strip produced no output for ${filename}`);
    }
    return out.code;
  };
  fs.writeFileSync(
    path.join(dir, 'em-component.jsx'),
    strip(inputSource, 'input.js'),
  );
  fs.writeFileSync(
    path.join(dir, 'theme.js'),
    strip(themeModuleSource, 'theme.js'),
  );
  fs.writeFileSync(
    path.join(dir, 'em-mount.jsx'),
    "import App from './em-component.jsx';\n" +
      "import theme from './theme.js';\n" +
      "import { ThemeProvider } from '@emotion/react';\n" +
      mountCommon +
      `const props = ${JSON.stringify(props)};\n` +
      "flushSync(() => createRoot(document.getElementById('render-root')).render(\n" +
      '  React.createElement(ThemeProvider, { theme },\n' +
      '    React.createElement(App, props))));\n' +
      `window.${RENDER_DONE_FLAG} = true;\n`,
  );

  const result = await esbuild.build({
    entryPoints: [path.join(dir, 'em-mount.jsx')],
    bundle: true,
    format: 'iife',
    write: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    absWorkingDir: dir,
    jsx: 'automatic',
    jsxImportSource: '@emotion/react',
  });
  return { script: result.outputFiles[0].text };
}

export type ThemeRenderInputs = {
  +emotionInput: string, // the original Emotion source
  +stylexOutput: string, // the converted StyleX source
  // INDEPENDENT SOURCE A: the team's real runtime theme module (a default
  // export used as the Emotion `<ThemeProvider theme={…}>`).
  +themeModuleSource: string,
  // INDEPENDENT SOURCE B: the team's authored `defineVars` module. NEVER derived
  // from the theme above — that independence is the whole check.
  +varsModuleSource: string,
  +varsImportPath: string, // what the output imports vars from (e.g. './app.stylex')
};

/**
 * Render-check a theme conversion. Emotion side under the real theme, StyleX
 * side under the authored `defineVars` — two independent sources — diffed in a
 * real browser. `placeholder` if the vars are still the skeleton; `unavailable`
 * if no browser; `mismatch` (with the offending props) on the first case that
 * diverges; else `match`.
 */
export async function verifyThemeRender(
  inputs: ThemeRenderInputs,
  options?: { +cases?: $ReadOnlyArray<{ +[string]: mixed }> },
): Promise<ThemeRenderVerdict> {
  if (isSkeletonVars(inputs.varsModuleSource)) {
    return {
      status: 'placeholder',
      reason:
        'the defineVars module still has the generated placeholder values — ' +
        'fill in the real theme values before render-checking theme',
    };
  }
  const cases = options?.cases ?? [{}];
  const dir = fs.mkdtempSync(path.join(RESOLVE_DIR, '.render-theme-'));
  try {
    for (const props of cases) {
      const before = await emotionThemeRenderDoc(
        dir,
        inputs.emotionInput,
        inputs.themeModuleSource,
        props,
      );
      const after = await stylexThemeRenderDoc(
        dir,
        inputs.stylexOutput,
        inputs.varsModuleSource,
        inputs.varsImportPath,
        props,
      );
      const verdict = await renderStyleDiff(before, after);
      if (verdict.status === 'unavailable') {
        return verdict;
      }
      if (verdict.status === 'mismatch') {
        return { status: 'mismatch', diffs: verdict.diffs, props };
      }
    }
    return { status: 'match' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * The source → render pipeline for the render gate (M14b). Turns a component's
 * Emotion *input* and its StyleX *output* into `RenderDoc`s that
 * `renderStyleDiff` can compare, by actually building and mounting each side
 * the way its library runs in production:
 *
 *   - **Emotion (before):** Flow-strip, then bundle with esbuild using the
 *     `@emotion/react` automatic JSX runtime. Mounted client-side, Emotion
 *     injects its own `<style>` — no CSS extraction needed.
 *   - **StyleX (after):** compile through the real `@stylexjs/babel-plugin`
 *     (same plugin the compile gate uses), collect its atomic CSS from the
 *     metadata, and bundle the transformed module. Mounted client-side, the
 *     `@stylexjs/stylex` runtime resolves `stylex.props(...)` to classNames on
 *     the element; the compiled CSS is injected as `css`.
 *
 * Both mount a React component into `#render-root` and set the render gate's
 * done-flag once committed (`flushSync`, so Emotion's injection and StyleX's
 * runtime have run before we measure).
 *
 * Test-only, heavyweight (esbuild + a browser), and used only behind the opt-in
 * render-gate test — so it lives under `src/testing/` alongside the gate.
 */

import * as esbuild from 'esbuild';
import * as babel from '@babel/core';
import styleXPlugin from '@stylexjs/babel-plugin';
import { RENDER_DONE_FLAG, renderStyleDiff } from './renderGate';
import type { RenderDoc, RenderVerdict } from './renderGate';

export type RenderBuildOptions = {
  // Props passed to the component (must be JSON-serializable). Default `{}`.
  +props?: { +[string]: mixed },
  +filename?: string,
};

// esbuild JSX options, kept a precise (indexer-free) type so it can be spread
// into the build config without Flow's cannot-spread-indexer.
type EsbuildJsx = { +jsx?: string, +jsxImportSource?: string };

// esbuild resolves bare imports (react, @emotion/react, @stylexjs/stylex) by
// walking up from here to the repo's hoisted node_modules.
const RESOLVE_DIR = __dirname;

// The virtual module name the mount entry imports the component from.
const SOURCE_MODULE = 'stylex-render-source';

const mountEntry = (props: { +[string]: mixed }): string =>
  `import App from '${SOURCE_MODULE}';\n` +
  "import * as React from 'react';\n" +
  "import { createRoot } from 'react-dom/client';\n" +
  "import { flushSync } from 'react-dom';\n" +
  `const props = ${JSON.stringify(props)};\n` +
  "flushSync(() => createRoot(document.getElementById('render-root'))" +
  '.render(React.createElement(App, props)));\n' +
  `window.${RENDER_DONE_FLAG} = true;\n`;

// Serves the (already-transformed) component source as a virtual module so the
// mount entry can `import App from SOURCE_MODULE` without a temp file.
function sourcePlugin(code: string, loader: string): $FlowFixMe {
  return {
    name: 'stylex-render-source',
    setup(build: $FlowFixMe) {
      build.onResolve({ filter: new RegExp(`^${SOURCE_MODULE}$`) }, () => ({
        path: SOURCE_MODULE,
        namespace: 'srs',
      }));
      build.onLoad({ filter: /.*/, namespace: 'srs' }, () => ({
        contents: code,
        resolveDir: RESOLVE_DIR,
        loader,
      }));
    },
  };
}

async function bundle(
  componentCode: string,
  loader: string,
  props: { +[string]: mixed },
  jsx: EsbuildJsx,
): Promise<string> {
  const result = await esbuild.build({
    stdin: {
      contents: mountEntry(props),
      resolveDir: RESOLVE_DIR,
      loader: 'js',
    },
    plugins: [sourcePlugin(componentCode, loader)],
    bundle: true,
    format: 'iife',
    write: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    absWorkingDir: RESOLVE_DIR,
    ...jsx,
  });
  return result.outputFiles[0].text;
}

/** The type-stripping preset for a file, by extension: TypeScript for
 * `.ts/.tsx` (matching the compile gate), else Flow. The dialect is carried by
 * the filename — Flow and TS annotations overlap but aren't interchangeable, so
 * preset-typescript on Flow source (or vice versa) would mis-parse. */
export function typeStripPresets(filename: string): Array<$FlowFixMe> {
  return /\.(ts|tsx|mts|cts)$/.test(filename)
    ? [['@babel/preset-typescript', { allExtensions: true, isTSX: true }]]
    : ['@babel/preset-flow'];
}

/** Emotion input → a script-mounted `RenderDoc` (Emotion injects its own CSS). */
export async function emotionRenderDoc(
  source: string,
  options?: RenderBuildOptions,
): Promise<RenderDoc> {
  const filename = options?.filename ?? 'before.js';
  // Strip Flow/TS types but KEEP the JSX + css prop for esbuild's Emotion runtime.
  const stripped = babel.transformSync(source, {
    filename,
    cwd: RESOLVE_DIR, // resolve presets from the package, not the user's cwd
    babelrc: false,
    configFile: false,
    presets: [...typeStripPresets(filename)],
    plugins: ['@babel/plugin-syntax-jsx'],
  });
  if (stripped == null || stripped.code == null) {
    throw new Error('emotionRenderDoc: Flow-strip produced no output');
  }
  const script = await bundle(stripped.code, 'jsx', options?.props ?? {}, {
    jsx: 'automatic',
    jsxImportSource: '@emotion/react',
  });
  return { script };
}

/** Extracts the atomic CSS from `@stylexjs/babel-plugin` metadata, ordered by
 * priority so the injected stylesheet's cascade matches the runtime's. */
function cssFromMetadata(metadata: mixed): string {
  const rules: $FlowFixMe = (metadata as $FlowFixMe)?.stylex ?? [];
  return rules
    .slice()
    .sort((a: $FlowFixMe, b: $FlowFixMe) => (a[2] ?? 0) - (b[2] ?? 0))
    .map((rule: $FlowFixMe) => rule[1]?.ltr)
    .filter(Boolean)
    .join('\n');
}

/** StyleX output → a script-mounted `RenderDoc` with the compiled CSS injected. */
export async function stylexRenderDoc(
  source: string,
  options?: RenderBuildOptions,
): Promise<RenderDoc> {
  const filename = options?.filename ?? 'after.js';
  // The codemod LEAVES a classic `@jsx jsx` pragma in place (M9). preset-react's
  // automatic runtime rejects a file that sets a pragma, so honor it: classic
  // runtime reads the `@jsx` factory from the file (`jsx`, still imported from
  // @emotion/react and bundled). Without a pragma, use the automatic runtime.
  const classicPragma = /@jsx\s+[A-Za-z_$]/.test(source);
  // Strip Flow/TS, transform JSX, and compile StyleX (real plugin) in one pass;
  // the plugin's metadata carries the atomic CSS.
  const compiled = babel.transformSync(source, {
    filename,
    cwd: RESOLVE_DIR, // resolve presets from the package, not the user's cwd
    babelrc: false,
    configFile: false,
    presets: [
      ...typeStripPresets(filename),
      [
        '@babel/preset-react',
        classicPragma ? { runtime: 'classic' } : { runtime: 'automatic' },
      ],
    ],
    plugins: [[styleXPlugin, {}]],
  });
  if (compiled == null || compiled.code == null) {
    throw new Error('stylexRenderDoc: StyleX compile produced no output');
  }
  // Bind before the intervening call: `cssFromMetadata` would otherwise
  // invalidate Flow's refinement of `compiled.code` to a non-null string.
  const code = compiled.code;
  const css = cssFromMetadata(compiled.metadata);
  const script = await bundle(code, 'js', options?.props ?? {}, {});
  return { script, css };
}

/** A verdict annotated with the prop-case that produced it, if any. */
export type VerifyRenderResult =
  | RenderVerdict
  | { +status: 'mismatch', +diffs: $ReadOnlyArray<$FlowFixMe>, +props: mixed };

/**
 * The render gate as a verifier for a whole conversion: render the Emotion
 * `input` and the StyleX `output` under each prop-case and diff. Returns on the
 * FIRST case that diverges (annotated with the offending props) so a caller
 * sees which usage broke; `match` only if every case matches. `unavailable`
 * (no browser) short-circuits, never throws.
 *
 * `cases` is the set of prop objects to exercise (default `[{}]`) — the way to
 * probe behaviors a single default render can't: `as`, forwarded DOM props, and
 * non-DOM props a faithful `styled` wrapper must filter.
 */
export async function verifyRender(
  emotionSource: string,
  stylexSource: string,
  options?: {
    +cases?: $ReadOnlyArray<{ +[string]: mixed }>,
    // The real filename — its extension decides Flow vs TS type-stripping so a
    // `.tsx` source renders instead of skipping. Both sides share it (a `.tsx`
    // input converts to a `.tsx` output).
    +filename?: string,
  },
): Promise<VerifyRenderResult> {
  const cases = options?.cases ?? [{}];
  const filename = options?.filename;
  for (const props of cases) {
    const before = await emotionRenderDoc(emotionSource, { props, filename });
    const after = await stylexRenderDoc(stylexSource, { props, filename });
    const verdict = await renderStyleDiff(before, after);
    if (verdict.status === 'unavailable') {
      return verdict;
    }
    if (verdict.status === 'mismatch') {
      return { status: 'mismatch', diffs: verdict.diffs, props };
    }
  }
  return { status: 'match' };
}

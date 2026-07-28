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
import { RENDER_DONE_FLAG } from './renderGate';
import type { RenderDoc } from './renderGate';

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
  'import * as React from \'react\';\n' +
  'import { createRoot } from \'react-dom/client\';\n' +
  'import { flushSync } from \'react-dom\';\n' +
  `const props = ${JSON.stringify(props)};\n` +
  'flushSync(() => createRoot(document.getElementById(\'render-root\'))' +
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

/** Emotion input → a script-mounted `RenderDoc` (Emotion injects its own CSS). */
export async function emotionRenderDoc(
  source: string,
  options?: RenderBuildOptions,
): Promise<RenderDoc> {
  const filename = options?.filename ?? 'before.js';
  // Strip Flow types but KEEP the JSX + css prop for esbuild's Emotion runtime.
  const stripped = babel.transformSync(source, {
    filename,
    babelrc: false,
    configFile: false,
    presets: ['@babel/preset-flow'],
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
  // Strip Flow, transform JSX, and compile StyleX (real plugin) in one pass;
  // the plugin's metadata carries the atomic CSS.
  const compiled = babel.transformSync(source, {
    filename,
    babelrc: false,
    configFile: false,
    presets: [
      '@babel/preset-flow',
      ['@babel/preset-react', { runtime: 'automatic' }],
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

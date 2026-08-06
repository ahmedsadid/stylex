/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * The `--render-check` driver: glob the same files as a run, transform each, and
 * render-check the CLEAN conversions in a real browser (see `renderCheck`).
 *
 * Only fully-converted files (zero TODO flags) are checked: a partially-converted
 * file still has leftover Emotion `css` the StyleX render pipeline can't apply, so
 * comparing it would report a false mismatch. Partial files are a manual-review
 * concern anyway. Sample props per file come from the config's `renderCases`.
 */

import * as fs from 'fs';
import * as path from 'path';
// $FlowFixMe[cannot-resolve-module] - fast-glob has no flow libdef here
import fastGlob from 'fast-glob';
import { transformEmotionFile } from '../adapters/emotion/transform';
import { pickTransformOptions } from '../config/loadConfig';
import { deriveRenderCases } from './deriveRenderCases';
import { renderCheckBatch } from '../testing/renderCheck';
import type {
  RenderCheckReport,
  RenderCheckItem,
  RenderCheckResult,
  RenderCaseSet,
  ThemeRenderContext,
} from '../testing/renderCheck';
import type { CodemodConfig } from '../config/loadConfig';

/** Reads the two theme modules a theme render-check needs (the real runtime
 * theme + the authored defineVars), once. `null` when theme render-check isn't
 * configured (both `themePath` and `varsPath` set) or a module can't be read —
 * theme conversions then fall through to the regular path (and skip). */
function loadThemeContext(
  config: CodemodConfig,
  cwd: string,
): ThemeRenderContext | null {
  const t = config.themeTokens;
  if (t == null) {
    return null;
  }
  // Bind before the reads — a readFileSync between two property refinements
  // would otherwise invalidate the second (Flow).
  const { themePath, varsPath, varsImport } = t;
  if (themePath == null || varsPath == null) {
    return null;
  }
  try {
    return {
      themeModuleSource: fs.readFileSync(path.resolve(cwd, themePath), 'utf8'),
      varsModuleSource: fs.readFileSync(path.resolve(cwd, varsPath), 'utf8'),
      varsImportPath: varsImport,
      themeFilename: themePath, // its extension → Flow vs TS stripping
    };
  } catch {
    return null;
  }
}

export type RenderCheckRunOptions = {
  +patterns: $ReadOnlyArray<string>,
  +config: CodemodConfig,
  +cwd?: string,
  +ignore?: $ReadOnlyArray<string>,
  +onProgress?: (result: RenderCheckResult) => void,
};

/** The sample props to render `file` under: an explicit `renderCases` rule wins
 * (first whose `include` is a substring of the path); else props derived from a
 * co-located Storybook file; else undefined (renders under `[{}]`). */
function renderCasesFor(
  config: CodemodConfig,
  file: string,
): RenderCaseSet | void {
  for (const rule of config.renderCases) {
    if (file.includes(rule.include)) {
      return rule.cases;
    }
  }
  const derived = deriveRenderCases(file);
  return derived.length > 0 ? derived : undefined;
}

export async function runRenderCheck(
  options: RenderCheckRunOptions,
): Promise<RenderCheckReport> {
  const cwd = options.cwd ?? process.cwd();
  const files: Array<string> = fastGlob.sync(options.patterns.slice(), {
    cwd,
    absolute: true,
    ignore: ['**/node_modules/**', ...(options.ignore ?? [])],
  });

  const themeContext = loadThemeContext(options.config, cwd);
  const items: Array<RenderCheckItem> = [];
  for (const file of files) {
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let result;
    try {
      result = transformEmotionFile(
        source,
        file,
        pickTransformOptions(options.config),
      );
    } catch {
      continue; // a crash is the run's concern, not the render check's
    }
    if (result.status !== 'converted') {
      continue;
    }
    // Clean conversions only (see module doc): no leftover Emotion, and it
    // actually converted something.
    if (result.flags.length > 0) {
      continue;
    }
    if (result.sites.length === 0 && result.keyframes.length === 0) {
      continue;
    }
    // A theme conversion (referenced ≥1 token) is routed to the theme
    // render-check when its two modules are configured; else it falls through to
    // the regular path (and skips, since its output imports an unresolvable
    // defineVars module).
    const theme = result.themeTokens.length > 0 ? themeContext : null;
    items.push({
      path: file,
      inputSource: source,
      outputCode: result.code,
      cases: renderCasesFor(options.config, file),
      theme,
    });
  }

  return renderCheckBatch(items, { onProgress: options.onProgress });
}

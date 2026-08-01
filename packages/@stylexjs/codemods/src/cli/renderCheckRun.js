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
// $FlowFixMe[cannot-resolve-module] - fast-glob has no flow libdef here
import fastGlob from 'fast-glob';
import { transformEmotionFile } from '../adapters/emotion/transform';
import { pickTransformOptions } from '../config/loadConfig';
import { renderCheckBatch } from '../testing/renderCheck';
import type {
  RenderCheckReport,
  RenderCheckItem,
  RenderCheckResult,
  RenderCaseSet,
} from '../testing/renderCheck';
import type { CodemodConfig } from '../config/loadConfig';

export type RenderCheckRunOptions = {
  +patterns: $ReadOnlyArray<string>,
  +config: CodemodConfig,
  +cwd?: string,
  +onProgress?: (result: RenderCheckResult) => void,
};

/** The sample props to render `file` under: the first `renderCases` rule whose
 * `include` is a substring of the path, else undefined (renders under `[{}]`). */
function renderCasesFor(
  config: CodemodConfig,
  file: string,
): RenderCaseSet | void {
  for (const rule of config.renderCases) {
    if (file.includes(rule.include)) {
      return rule.cases;
    }
  }
  return undefined;
}

export async function runRenderCheck(
  options: RenderCheckRunOptions,
): Promise<RenderCheckReport> {
  const cwd = options.cwd ?? process.cwd();
  const files: Array<string> = fastGlob.sync(options.patterns.slice(), {
    cwd,
    absolute: true,
    ignore: ['**/node_modules/**'],
  });

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
    items.push({
      path: file,
      inputSource: source,
      outputCode: result.code,
      cases: renderCasesFor(options.config, file),
    });
  }

  return renderCheckBatch(items, { onProgress: options.onProgress });
}

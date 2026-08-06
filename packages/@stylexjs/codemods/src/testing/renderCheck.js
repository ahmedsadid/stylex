/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * The confidence workflow: run the render gate over a WHOLE migration, not just
 * fixtures. For each converted file it renders the Emotion input and the StyleX
 * output in a real browser and diffs the computed styles (see `renderPipeline` /
 * `renderGate`). This is how the *trusted* conversions — dynamic values and, once
 * wired, theme tokens — earn confidence: the semantic-diff gate proves the static
 * CSS, the render gate proves the rest actually renders the same.
 *
 * Two robustness rules make it usable at scale:
 *   - **Never throw.** A real component may not build in isolation (it imports
 *     local modules, hooks, context that esbuild can't resolve from source). That
 *     is not a conversion bug — it becomes a `skipped` result ("couldn't render"),
 *     to review by hand, exactly like a flagged site.
 *   - **Probe the browser once.** `isRenderGateAvailable` is checked up front; if
 *     no Chrome is present the whole batch short-circuits to `unavailable` instead
 *     of trying (and failing) to launch per file.
 *
 * Heavyweight (esbuild + a browser) and depends on the render pipeline, so it
 * lives here under `src/testing/` with the rest of the render machinery.
 */

import { verifyRender } from './renderPipeline';
import { isRenderGateAvailable } from './renderGate';
import { verifyThemeRender } from './renderTheme';
import type { StyleDiff } from './renderGate';

/** Sample prop objects to render a component under (default `[{}]`). */
export type RenderCaseSet = $ReadOnlyArray<{ +[string]: mixed }>;

/** A theme conversion needs its two INDEPENDENT value sources to render (see
 * `renderTheme`): the real runtime theme and the authored defineVars module. */
export type ThemeRenderContext = {
  +themeModuleSource: string,
  +varsModuleSource: string,
  +varsImportPath: string,
  +themeFilename?: string, // the theme module path (its extension → dialect)
};

export type RenderCheckItem = {
  +path: string,
  +inputSource: string, // the original Emotion source
  +outputCode: string, // the converted StyleX source
  +cases?: RenderCaseSet,
  // Present for a theme conversion → routed to the theme render-check.
  +theme?: ThemeRenderContext | null,
};

export type RenderCheckResult =
  // Rendered identically under every case — the conversion is render-verified.
  | { +path: string, +status: 'match' }
  // Rendered differently — a real signal to review (with the offending props).
  | {
      +path: string,
      +status: 'mismatch',
      +diffs: $ReadOnlyArray<StyleDiff>,
      +props: mixed,
    }
  // Could not be rendered in isolation (build/bundle failure) — review by hand.
  | { +path: string, +status: 'skipped', +reason: string }
  // A theme conversion whose defineVars is still the placeholder skeleton —
  // fill in real values before it can be checked (not a failure).
  | { +path: string, +status: 'placeholder', +reason: string }
  // No browser to render with (opt-in tool absent) — not a verdict.
  | { +path: string, +status: 'unavailable', +reason: string };

export type RenderCheckReport = {
  +matched: number,
  +mismatched: number,
  +skipped: number,
  +placeholder: number,
  +unavailable: number,
  +results: $ReadOnlyArray<RenderCheckResult>,
};

/**
 * Render-check a single converted file. Wraps `verifyRender` so a component that
 * cannot be built in isolation yields a `skipped` result rather than throwing.
 */
export async function renderCheckFile(
  item: RenderCheckItem,
): Promise<RenderCheckResult> {
  const { path } = item;
  try {
    if (item.theme != null) {
      const tv = await verifyThemeRender(
        {
          emotionInput: item.inputSource,
          stylexOutput: item.outputCode,
          themeModuleSource: item.theme.themeModuleSource,
          varsModuleSource: item.theme.varsModuleSource,
          varsImportPath: item.theme.varsImportPath,
          componentFilename: item.path, // .tsx/.jsx → dialect
          themeFilename: item.theme.themeFilename,
        },
        { cases: item.cases },
      );
      if (tv.status === 'placeholder') {
        return { path, status: 'placeholder', reason: tv.reason };
      }
      if (tv.status === 'match') {
        return { path, status: 'match' };
      }
      if (tv.status === 'unavailable') {
        return { path, status: 'unavailable', reason: tv.reason };
      }
      return { path, status: 'mismatch', diffs: tv.diffs, props: tv.props };
    }
    const verdict = await verifyRender(item.inputSource, item.outputCode, {
      cases: item.cases,
      filename: item.path, // extension → Flow vs TS type-stripping
    });
    if (verdict.status === 'match') {
      return { path, status: 'match' };
    }
    if (verdict.status === 'unavailable') {
      return { path, status: 'unavailable', reason: verdict.reason };
    }
    return {
      path,
      status: 'mismatch',
      diffs: verdict.diffs,
      props: verdict.props,
    };
  } catch (error) {
    return {
      path,
      status: 'skipped',
      reason:
        'could not render in isolation: ' +
        (error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * Render-check a batch of converted files. Probes for a browser ONCE; if none is
 * available the whole batch is `unavailable` (no per-file launch attempts).
 * `onProgress` is called with each result as it completes.
 */
export async function renderCheckBatch(
  items: $ReadOnlyArray<RenderCheckItem>,
  options?: { +onProgress?: (result: RenderCheckResult) => void },
): Promise<RenderCheckReport> {
  if (items.length > 0 && !(await isRenderGateAvailable())) {
    const results = items.map((item): RenderCheckResult => ({
      path: item.path,
      status: 'unavailable',
      reason: 'no Chrome could be launched (render check needs a browser)',
    }));
    return tally(results);
  }

  const results: Array<RenderCheckResult> = [];
  for (const item of items) {
    const result = await renderCheckFile(item);
    if (options?.onProgress != null) {
      options.onProgress(result);
    }
    results.push(result);
  }
  return tally(results);
}

function tally(results: $ReadOnlyArray<RenderCheckResult>): RenderCheckReport {
  let matched = 0;
  let mismatched = 0;
  let skipped = 0;
  let placeholder = 0;
  let unavailable = 0;
  for (const r of results) {
    if (r.status === 'match') matched++;
    else if (r.status === 'mismatch') mismatched++;
    else if (r.status === 'skipped') skipped++;
    else if (r.status === 'placeholder') placeholder++;
    else unavailable++;
  }
  return { matched, mismatched, skipped, placeholder, unavailable, results };
}

/** A human-readable render-check report. `cwd` shortens absolute paths. */
export function formatRenderCheckReport(
  report: RenderCheckReport,
  cwd?: string,
): string {
  const rel = (p: string) =>
    cwd != null && p.startsWith(cwd) ? p.slice(cwd.length + 1) : p;
  const lines: Array<string> = [];
  lines.push('Render check (real-browser computed-style diff):');
  lines.push(
    `  ${report.matched} matched, ${report.mismatched} DIFFER, ` +
      `${report.skipped} could not render, ${report.placeholder} theme ` +
      `placeholders, ${report.unavailable} unavailable`,
  );
  const placeholders = report.results.filter((r) => r.status === 'placeholder');
  if (placeholders.length > 0) {
    lines.push('');
    lines.push(
      '  ⏳ Theme not verified — fill in the defineVars values first:',
    );
    for (const r of placeholders.slice(0, 20)) {
      if (r.status === 'placeholder') lines.push(`  - ${rel(r.path)}`);
    }
  }
  const mismatches = report.results.filter((r) => r.status === 'mismatch');
  if (mismatches.length > 0) {
    lines.push('');
    lines.push('  ⚠️ Rendered differently (review these):');
    for (const r of mismatches) {
      if (r.status !== 'mismatch') continue;
      lines.push(`  - ${rel(r.path)}`);
      for (const d of r.diffs.slice(0, 5)) {
        lines.push(`      ${d.property}: ${d.before} → ${d.after}`);
      }
    }
  }
  const skips = report.results.filter((r) => r.status === 'skipped');
  if (skips.length > 0) {
    lines.push('');
    lines.push('  🔍 Could not render in isolation (review by hand):');
    for (const r of skips.slice(0, 20)) {
      if (r.status === 'skipped') lines.push(`  - ${rel(r.path)}`);
    }
    if (skips.length > 20) {
      lines.push(`  … and ${skips.length - 20} more`);
    }
  }
  return lines.join('\n');
}

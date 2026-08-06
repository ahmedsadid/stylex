/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * L13 report — renders a RunReport as human-readable text. Kept separate from
 * `run` so the report can be asserted on the structured data in tests and the
 * text formatting stays presentation-only.
 */

import * as path from 'path';
import type { RunReport, FileOutcome } from './run';

function relativize(file: string, cwd: string): string {
  const rel = path.relative(cwd, file);
  return rel === '' || rel.startsWith('..') ? file : rel;
}

/** Buckets a reason so specifics (quoted names, parentheticals, line numbers)
 * collapse and the same class of reason groups in the histogram. */
function normalizeReason(reason: string): string {
  return reason
    .replace(/'[^']*'/g, "'…'")
    .replace(/\([^)]*\)/g, '(…)')
    .replace(/\bline \d+/g, 'line …')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The top `n` reasons (by count) drawn from every outcome's `pick`ed list. */
function topReasons(
  results: $ReadOnlyArray<FileOutcome>,
  pick: (o: FileOutcome) => $ReadOnlyArray<string>,
  n: number,
): Array<[string, number]> {
  const hist: Map<string, number> = new Map();
  for (const outcome of results) {
    for (const reason of pick(outcome)) {
      const key = normalizeReason(reason);
      hist.set(key, (hist.get(key) ?? 0) + 1);
    }
  }
  return [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** Renders a titled "N  reason" histogram section, or nothing when empty. */
function histogramSection(
  title: string,
  entries: Array<[string, number]>,
): Array<string> {
  if (entries.length === 0) {
    return [];
  }
  const lines = ['', title];
  for (const [reason, count] of entries) {
    lines.push(`  ${String(count).padStart(4)}  ${reason}`);
  }
  return lines;
}

function outcomeLine(outcome: FileOutcome, cwd: string): string {
  const file = relativize(outcome.file, cwd);
  if (outcome.status === 'converted') {
    const suffix =
      outcome.flags.length > 0
        ? ` (+${outcome.flags.length} TODO${outcome.flags.length === 1 ? '' : 's'})`
        : '';
    return `  convert  ${file}${suffix}`;
  }
  if (outcome.status === 'unchanged') {
    return `  skip     ${file}`;
  }
  const detail = outcome.reasons[0] != null ? ` — ${outcome.reasons[0]}` : '';
  const label = outcome.status === 'error' ? 'ERROR  ' : 'refuse ';
  return `  ${label} ${file}${detail}`;
}

export function formatReport(
  report: RunReport,
  options?: { +cwd?: string, +verbose?: boolean },
): string {
  const cwd = options?.cwd ?? process.cwd();
  const verbose = options?.verbose ?? false;
  const lines: Array<string> = [];

  const s0 = report.summary;
  const hasComplexity =
    s0.skipped > 0 || s0.partiallyConverted > 0 || s0.errors > 0;

  lines.push(report.dryRun ? 'Dry run (no files written):' : 'Applied:');
  // A one-line legend of the outcome verbs — only when there's something beyond
  // clean converts to explain, so repeat clean runs stay terse.
  if (hasComplexity) {
    lines.push(
      '  (convert = rewritten · +N TODOs = converted, N sites need a hand · ' +
        'refuse = left untouched · skip = no Emotion)',
    );
  }
  for (const outcome of report.results) {
    if (outcome.status === 'unchanged' && !verbose) {
      continue; // unchanged files are noise unless asked for
    }
    lines.push(outcomeLine(outcome, cwd));
    if (verbose) {
      for (const flag of outcome.flags) {
        lines.push(`             TODO: ${flag}`);
      }
    }
  }

  const s = report.summary;
  lines.push('');
  lines.push(
    `${s.files} file(s): ${s.converted} converted, ` +
      `${s.partiallyConverted} partial (+TODOs), ${s.skipped} refused, ` +
      `${s.unchanged} unchanged` +
      (s.errors > 0 ? `, ${s.errors} error(s)` : ''),
  );
  if (s.totalFlags > 0) {
    lines.push(`${s.totalFlags} TODO marker(s) left for manual follow-up.`);
  }

  // Trust model (invisible otherwise): what's provably equivalent vs trusted.
  if (s.converted > 0 || s.partiallyConverted > 0) {
    lines.push('');
    lines.push(
      'ℹ Static styles are verified CSS-equivalent. Theme tokens & dynamic ' +
        '(props-driven)',
    );
    lines.push(
      '  values are TRUSTED (wiring checked, not the value) — run ' +
        '--render-check to',
    );
    lines.push('  confirm them in a real browser.');
  }

  // Where the manual work is: the most common TODO (partial-conversion) and
  // whole-file-refusal reasons, bucketed and ranked.
  lines.push(
    ...histogramSection(
      'Top reasons sites were flagged (partial conversions):',
      topReasons(report.results, (o) => o.flags, 5),
    ),
  );
  lines.push(
    ...histogramSection(
      'Top reasons files were refused (whole file):',
      topReasons(
        report.results,
        (o) => (o.status === 'skipped' ? o.reasons : []),
        5,
      ),
    ),
  );

  const steps = nextSteps(report, cwd);
  if (steps.length > 0) {
    lines.push('');
    lines.push('Next steps:');
    steps.forEach((step, i) => lines.push(`  ${i + 1}. ${step}`));
  }
  return lines.join('\n');
}

/** Concrete, result-driven next actions — the payoff that lets a first-timer act
 * without reading the docs. Each is included only when it applies. */
function nextSteps(report: RunReport, cwd: string): Array<string> {
  const s = report.summary;
  const steps: Array<string> = [];
  const anyText = (re: RegExp): boolean =>
    report.results.some(
      (o) =>
        o.reasons.some((r) => re.test(r)) || o.flags.some((f) => re.test(f)),
    );
  const themeBlocked = report.results.some(
    (o) => o.status === 'skipped' && o.reasons.some((r) => /useTheme/.test(r)),
  );

  if (themeBlocked) {
    steps.push(
      'Theme reads (useTheme) were refused. Add a `themeTokens` config ' +
        '(varsImport + varsName), or pass `--theme-vars <name>:<import>`, to ' +
        'convert them, then re-run.',
    );
  }
  if (report.dryRun && (s.converted > 0 || s.partiallyConverted > 0)) {
    steps.push('Re-run with --write to apply.');
  }
  if (report.themeSkeleton != null) {
    steps.push(
      'Theme tokens were converted (trusted, not statically verified). Fill in ' +
        `the real values in ${relativize(report.themeSkeleton.path, cwd)}, ` +
        'then run with --render-check to confirm they render the same.',
    );
  }
  if (s.totalFlags > 0) {
    steps.push(
      `${s.totalFlags} site(s) need a hand — search \`TODO(stylex-migration)\` ` +
        'in the converted files.',
    );
  }
  if (anyText(/styled\(/)) {
    steps.push(
      '`styled(Component)` composition is left for you: its correctness ' +
        "can't be verified from a single file, so hand-migrate those.",
    );
  }
  return steps;
}

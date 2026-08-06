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

  lines.push(report.dryRun ? 'Dry run (no files written):' : 'Applied:');
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

  if (report.dryRun && (s.converted > 0 || s.partiallyConverted > 0)) {
    lines.push('');
    lines.push('Re-run with --write to apply.');
  }
  return lines.join('\n');
}

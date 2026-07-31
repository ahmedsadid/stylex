/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * M9 corpus runner. Points the codemod at a real OSS Emotion codebase and
 * measures it: convert / flag / refuse counts, a flag- and refuse-reason
 * histogram (which re-ranks the remaining milestones), and — critically —
 * runs the shared taste-test (`verifyConvertedFile`) on every conversion so
 * the two invariants can be asserted at real scale:
 *
 *   - **0 crashes** (the M7 robustness invariant), and
 *   - **0 verify-failures** (no conversion silently changes the CSS).
 *
 * Idle in the normal suite. To run:
 *   CORPUS_GLOB="/path/to/repo/src/ ** / *.{js,jsx,ts,tsx}" \
 *   CORPUS_LABEL=react-select CORPUS_REPORT=/tmp/report.md \
 *   yarn jest corpus-validate
 */

import * as fs from 'fs';
// $FlowFixMe[cannot-resolve-module] - fast-glob has no flow libdef here
import fastGlob from 'fast-glob';
import type { TransformResult } from '../src/adapters/emotion/transform';
import { transformEmotionFile } from '../src/adapters/emotion/transform';
import { verifyConvertedFile } from '../src/testing/verifyConversion';

const GLOB = process.env.CORPUS_GLOB ?? null;
const LABEL = process.env.CORPUS_LABEL ?? 'corpus';
const REPORT_PATH = process.env.CORPUS_REPORT ?? null;
// M13: set CORPUS_THEME_VARS=<varsName>:<varsImport> to convert theme reads.
const THEME_TOKENS = (() => {
  const raw = process.env.CORPUS_THEME_VARS;
  if (raw == null || !raw.includes(':')) {
    return null;
  }
  const [varsName, ...rest] = raw.split(':');
  return { varsName, varsImport: rest.join(':') };
})();
const XFORM_OPTIONS =
  THEME_TOKENS != null ? { themeTokens: THEME_TOKENS } : undefined;

/** Buckets specifics (quoted names, parentheticals) so reasons group. */
function normalizeReason(reason: string): string {
  return reason
    .replace(/'[^']*'/g, "'…'")
    .replace(/\([^)]*\)/g, '(…)')
    .replace(/\s+/g, ' ')
    .trim();
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topN(map: Map<string, number>, n: number): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

describe('M9 corpus validation', () => {
  test('measures outcomes and verifies conversions (0 crashes, 0 verify-failures)', () => {
    if (GLOB == null) {
      return; // idle unless CORPUS_GLOB is set
    }
    // Split on ';' (not ',', which appears inside brace globs like `*.{ts,tsx}`).
    const files: Array<string> = fastGlob.sync(
      GLOB.split(';').map((s) => s.trim()),
      {
        ignore: [
          '**/node_modules/**',
          '**/dist/**',
          '**/lib/**',
          '**/build/**',
          '**/*.d.ts',
          '**/*.test.*',
          '**/*.spec.*',
          '**/*.stories.*',
        ],
      },
    );

    const stats = {
      files: files.length,
      emotionFiles: 0,
      convertedClean: 0,
      convertedPartial: 0,
      flaggedOnly: 0,
      refused: 0,
      unchanged: 0,
      crashed: 0,
      todos: 0,
      verifyOk: 0,
      verifyFailed: 0,
      unverifiable: 0,
    };
    const flagHist: Map<string, number> = new Map();
    const refuseHist: Map<string, number> = new Map();
    const failures: Array<{ file: string, detail: string }> = [];
    const unverifiable: Array<{ file: string, reason: string }> = [];
    const crashes: Array<{ file: string, error: string }> = [];

    for (const file of files) {
      let source: string;
      try {
        source = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }

      let result: TransformResult | null = null;
      try {
        result = transformEmotionFile(source, file, XFORM_OPTIONS);
      } catch (error) {
        stats.crashed++;
        crashes.push({
          file,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (result == null || result.status === 'unchanged') {
        stats.unchanged++;
        continue;
      }
      if (result.status === 'skipped') {
        stats.refused++;
        stats.emotionFiles++;
        for (const reason of result.reasons) {
          bump(refuseHist, normalizeReason(reason));
        }
        continue;
      }

      // status === 'converted'
      stats.emotionFiles++;
      const { flags, sites, keyframes, code, themeTokens } = result;
      stats.todos += flags.length;
      for (const reason of flags) {
        bump(flagHist, normalizeReason(reason));
      }
      const convertedSomething = sites.length > 0 || keyframes.length > 0;
      if (!convertedSomething) {
        stats.flaggedOnly++;
      } else if (flags.length === 0) {
        stats.convertedClean++;
      } else {
        stats.convertedPartial++;
      }

      if (convertedSomething) {
        let verdict;
        try {
          verdict = verifyConvertedFile({
            inputSource: source,
            inputPath: file,
            outputCode: code,
            outputPath: file,
            sites,
            keyframes,
            themeTokens,
          });
        } catch (error) {
          stats.crashed++;
          crashes.push({
            file,
            error: `verify: ${error instanceof Error ? error.message : String(error)}`,
          });
          continue;
        }
        if (verdict.status === 'ok') {
          stats.verifyOk++;
        } else if (verdict.status === 'failed') {
          stats.verifyFailed++;
          if (failures.length < 25) {
            failures.push({ file, detail: verdict.failures.join(' | ') });
          }
        } else {
          stats.unverifiable++;
          if (unverifiable.length < 15) {
            unverifiable.push({ file, reason: verdict.reason });
          }
        }
      }
    }

    const out: Array<string> = [];
    const line = (s: string) => out.push(s);
    line(`# M9 corpus report — ${LABEL}`);
    line('');
    line('## Outcomes');
    line(
      `- files scanned: ${stats.files} (with Emotion: ${stats.emotionFiles})`,
    );
    line(`- converted clean (0 TODOs): ${stats.convertedClean}`);
    line(`- converted partial (+TODOs): ${stats.convertedPartial}`);
    line(`- flagged only (nothing convertible): ${stats.flaggedOnly}`);
    line(`- refused (whole-file): ${stats.refused}`);
    line(`- unchanged (no Emotion): ${stats.unchanged}`);
    line(`- **crashed: ${stats.crashed}** (must be 0)`);
    line(`- total TODOs left in place: ${stats.todos}`);
    line('');
    line('## Verify (files that converted ≥1 site/keyframe)');
    line(`- ok (provably CSS-equivalent): ${stats.verifyOk}`);
    line(`- **failed: ${stats.verifyFailed}** (must be 0 — each is a bug)`);
    line(
      `- unverifiable (union gate can't check per-site): ${stats.unverifiable}`,
    );
    line('');
    line('## Top flag reasons (→ re-rank M10–M12)');
    for (const [reason, n] of topN(flagHist, 15)) {
      line(`- ${n}  ${reason}`);
    }
    line('');
    line('## Top refuse reasons');
    for (const [reason, n] of topN(refuseHist, 15)) {
      line(`- ${n}  ${reason}`);
    }
    if (failures.length > 0) {
      line('');
      line('## ⚠️ VERIFY FAILURES (bugs to fix)');
      for (const f of failures) {
        line(`- ${f.file}`);
        line(`    ${f.detail}`);
      }
    }
    if (unverifiable.length > 0) {
      line('');
      line('## Unverifiable samples');
      for (const u of unverifiable) {
        line(`- ${u.file} — ${u.reason}`);
      }
    }
    if (crashes.length > 0) {
      line('');
      line('## ⚠️ CRASHES');
      for (const c of crashes) {
        line(`- ${c.file} — ${c.error}`);
      }
    }
    const report = out.join('\n');
    process.stdout.write(`\n${report}\n\n`);
    if (REPORT_PATH != null) {
      fs.writeFileSync(REPORT_PATH, report);
    }

    // The two invariants M9 exists to prove.
    expect(stats.crashed).toBe(0);
    expect(stats.verifyFailed).toBe(0);
  }, 600000);
});

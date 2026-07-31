/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * The shared "taste-test": run the compile, lint, and semantic-diff gates on a
 * CONVERTED file. No hand-written `expected` is needed — the answer is derived
 * from the input itself (Emotion's own serializer) and from the output (the
 * StyleX compiler), then the two are compared. `expected.js` in a fixture is a
 * regression pin, not the source of correctness; this is.
 *
 * Used by both the fixture harness (alongside its byte-exact answer-key check)
 * and the real-world corpus runner (M9), where there is no answer key.
 *
 * Returns one of three outcomes so a real-code run never crashes:
 *   - `ok`           — compile + lint + semantic-diff all clean.
 *   - `failed`       — a gate found a real problem (a bug to fix or refuse).
 *   - `unverifiable` — the gate could not represent this file (an unusual
 *                      value it throws on, or ≥2 sites that restate the same
 *                      coordinate with different values, which the union-based
 *                      gate can't tell apart per-site). NOT "wrong" — "unproven".
 *
 * Test-only: imports `@emotion/serialize` (a devDep, the semantic-diff ground
 * truth), so it lives under `src/testing/` like `stylexToIR`.
 */

import { serializeStyles } from '@emotion/serialize';
import { compileGate } from '../core/gates/compile';
import { lintGate } from '../core/gates/lint';
import {
  semanticDiffGate,
  canonicalizeNetCss,
  netCssFromSerializedCss,
  netCssFromStylexMetadata,
  keyframesFromStylexMetadata,
  parseFrames,
} from '../core/gates/semanticDiff';

export type VerifyInput = {
  +inputSource: string,
  +inputPath: string,
  +outputCode: string,
  +outputPath: string,
  // Inexact (`...`): the caller's site/keyframe objects carry extra fields
  // (e.g. a `key`) we don't need here.
  +sites: $ReadOnlyArray<{ +cssObject: { +[string]: mixed }, ... }>,
  +keyframes: $ReadOnlyArray<{
    +framesObject: { +[selector: string]: { +[string]: mixed } },
    ...
  }>,
  // M13: `defineVars` token names the output references. When non-empty the
  // output can't be statically verified — it imports a `defineVars` module this
  // single-file gate can't resolve, and the token values are external (trusted,
  // ADR-0005) — so the whole file is `unverifiable`, not `failed`.
  +themeTokens?: $ReadOnlyArray<string>,
};

export type VerifyResult =
  | { +status: 'ok' }
  | { +status: 'failed', +failures: $ReadOnlyArray<string> }
  | { +status: 'unverifiable', +reason: string };

/** Deterministic JSON with recursively-sorted keys, for set comparison. */
function canonicalJson(value: mixed): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const obj: { +[string]: mixed } = value;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

export function verifyConvertedFile(input: VerifyInput): VerifyResult {
  const { inputSource, inputPath, outputCode, outputPath, sites, keyframes } =
    input;
  const failures: Array<string> = [];

  // M13: a theme-token conversion references an external `defineVars` module
  // (ADR-0005). The compile gate can't resolve it in isolation and the token
  // values are external, so the file is trusted/unverifiable, never failed —
  // correctness rests on the human-authored `defineVars` + the render gate.
  if (input.themeTokens != null && input.themeTokens.length > 0) {
    return {
      status: 'unverifiable',
      reason: `references ${input.themeTokens.length} external defineVars token(s); trusted, not statically verifiable (ADR-0005)`,
    };
  }

  // Does it run? — the output must compile (also yields the after-CSS metadata).
  const compiled = compileGate(outputCode, { filename: outputPath });
  if (!compiled.ok) {
    return {
      status: 'failed',
      failures: [`compile: ${compiled.errors.join('; ')}`],
    };
  }

  // Is it tidy? — lint at error, zero autofixes.
  const linted = lintGate(outputCode, { filename: outputPath });
  if (!linted.ok) {
    failures.push(
      `lint: ${linted.messages
        .map((m) => `${m.ruleId ?? 'error'} "${m.message}" (line ${m.line})`)
        .join('; ')}`,
    );
  }

  // Does it taste the same? — derive the before-CSS from the input (any
  // pre-existing StyleX + Emotion's serializer over each converted site) and
  // the after-CSS from the compiled output, then diff (minus the allowlist).
  try {
    // Build the before-CSS as a union over each site, keyed by CANONICAL
    // coordinate. Canonicalizing per-site (not just inside `semanticDiffGate`)
    // is what lets the union-conflict check see a shorthand and a longhand from
    // two sites as the SAME coordinate — e.g. one site's `padding` and another's
    // `padding-right` both land on `padding-right`. Without it the collision
    // only surfaces after canonicalization, where each side resolves it in a
    // different order and the gate reports a false "failed".
    const before: { [string]: $FlowFixMe } = {};
    const inputCompiled = compileGate(inputSource, { filename: inputPath });
    if (inputCompiled.ok) {
      const preExisting = canonicalizeNetCss(
        netCssFromStylexMetadata(inputCompiled.metadata),
      );
      for (const coordinate of Object.keys(preExisting)) {
        before[coordinate] = preExisting[coordinate];
      }
    }
    for (const site of sites) {
      const net = canonicalizeNetCss(
        netCssFromSerializedCss(serializeStyles([site.cssObject]).styles),
      );
      for (const coordinate of Object.keys(net)) {
        if (
          before[coordinate] != null &&
          before[coordinate].value !== net[coordinate].value
        ) {
          return {
            status: 'unverifiable',
            reason: `two sites set '${net[coordinate].property}' to different values; the union gate can't verify these per-site`,
          };
        }
        before[coordinate] = net[coordinate];
      }
    }
    const diff = semanticDiffGate(
      before,
      netCssFromStylexMetadata(compiled.metadata),
    );
    if (!diff.ok) {
      failures.push(
        `semantic-diff: ${diff.diffs
          .map(
            (d) =>
              `${d.coordinate} (before=${String(d.beforeValue)} after=${String(d.afterValue)})`,
          )
          .join('; ')}`,
      );
    }

    const emotionFrames = keyframes
      .map((kf) => parseFrames(serializeStyles([kf.framesObject]).styles))
      .map(canonicalJson)
      .sort();
    const stylexFrames = keyframesFromStylexMetadata(compiled.metadata)
      .map(canonicalJson)
      .sort();
    if (canonicalJson(emotionFrames) !== canonicalJson(stylexFrames)) {
      failures.push(
        'keyframes: frame contents differ from the Emotion original',
      );
    }
  } catch (error) {
    return {
      status: 'unverifiable',
      reason: `could not compare CSS: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return failures.length === 0
    ? { status: 'ok' }
    : { status: 'failed', failures };
}

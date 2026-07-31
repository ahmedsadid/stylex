/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * The fixture harness — the executable spec. Every input/expected pair
 * under `__fixtures__/emotion/` must satisfy two checks:
 *
 *   1. transform(input) matches expected byte-exactly (after Prettier) — the
 *      regression pin / human-readable answer key.
 *   2. the converted output passes the shared taste-test `verifyConvertedFile`
 *      (compile + lint + semantic-diff + keyframe contents) — where
 *      correctness is *derived* from the input and output, not the answer key.
 *      Skip-fixtures (expected === input) instead assert the transform refused.
 *
 * The same `verifyConvertedFile` runs on real, answer-key-less code in the M9
 * corpus runner — this is what makes that trustworthy.
 *
 * Set UPDATE_STYLEX_CODEMOD_FIXTURES=1 to regenerate expected files when a
 * change is intentional.
 */

import * as fs from 'fs';
import { transformEmotionFile } from '../src/adapters/emotion/transform';
import { verifyConvertedFile } from '../src/testing/verifyConversion';
import { loadFixtures, formatWithPrettier } from './utils/harness';

const UPDATE = process.env.UPDATE_STYLEX_CODEMOD_FIXTURES === '1';

const fixtures = loadFixtures('emotion');

test('there is at least one fixture pair', () => {
  expect(fixtures.length).toBeGreaterThan(0);
});

test('prettier normalization is available and idempotent', () => {
  const [fixture] = fixtures;
  const once = formatWithPrettier(fixture.expected, fixture.expectedPath);
  expect(formatWithPrettier(once, fixture.expectedPath)).toEqual(once);
});

describe.each(fixtures.map((f) => [f.name, f]))(
  'fixture: %s',
  (_name, fixture) => {
    const result = transformEmotionFile(fixture.input, fixture.inputPath);
    const output = result.status === 'converted' ? result.code : fixture.input;

    // Check 1 — byte-exact against expected, formatting-insensitive.
    test('transform(input) matches expected byte-exactly', () => {
      const actual = formatWithPrettier(output, fixture.expectedPath);
      if (UPDATE) {
        fs.writeFileSync(fixture.expectedPath, actual);
      }
      expect(actual).toEqual(
        formatWithPrettier(fixture.expected, fixture.expectedPath),
      );
    });

    // Check 2 — the shared taste-test: compile + lint + semantic-diff + keyframe
    // contents. No answer key involved (that is check 1); correctness is derived
    // from the input and output themselves. Skip-fixtures instead assert refusal.
    test('converted output passes compile + lint + semantic-diff', () => {
      if (result.status !== 'converted') {
        // A skip-fixture: the transform must have refused (loudly, with
        // reasons) and left the file byte-identical.
        expect(fixture.expected).toEqual(fixture.input);
        if (result.status === 'skipped') {
          expect(result.reasons.length).toBeGreaterThan(0);
        }
        return;
      }
      const verdict = verifyConvertedFile({
        inputSource: fixture.input,
        inputPath: fixture.inputPath,
        outputCode: output,
        outputPath: fixture.expectedPath,
        sites: result.sites,
        keyframes: result.keyframes,
        themeTokens: result.themeTokens,
      });
      if (verdict.status !== 'ok') {
        throw new Error(
          verdict.status === 'failed'
            ? verdict.failures.join('\n')
            : `unverifiable: ${verdict.reason}`,
        );
      }
      expect(verdict.status).toBe('ok');
    });
  },
);

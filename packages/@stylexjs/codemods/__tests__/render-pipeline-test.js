/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * The render gate on real conversions (M14b): build each side of a fixture the
 * way its library actually runs (Emotion input via the `@emotion/react` runtime;
 * StyleX output via the real babel plugin + `@stylexjs/stylex` runtime), render
 * both in a browser, and diff computed styles.
 *
 *   - FAITHFULNESS: on curated static fixtures the two renders MATCH — the
 *     render gate agrees with the semantic-diff gate where that gate is
 *     authoritative, so it can be trusted as a stricter check elsewhere. These
 *     also exercise things worth confirming in a real browser: the emotion
 *     `label`, and the physical→logical property rewrite (identical computed
 *     result in LTR).
 *   - DISCRIMINATION: a value-divergent "conversion" MISMATCHES on the exact
 *     property — proof the gate is live, not vacuously green.
 *
 * Opt-in / heavyweight (esbuild + a browser). An `unavailable` verdict is
 * treated as a skip, so a browserless CI stays green.
 */

import { renderStyleDiff } from '../src/testing/renderGate';
import type { RenderVerdict } from '../src/testing/renderGate';
import {
  emotionRenderDoc,
  stylexRenderDoc,
} from '../src/testing/renderPipeline';
import { loadFixtures } from './utils/harness';

// Curated single-element, default-export fixtures that render in the default
// state (no interaction): flat color, values + emotion `label`, physical→logical
// properties, and a pseudo-class base state.
const RENDER_TESTABLE: Set<string> = new Set([
  'static-flat-color',
  'static-values',
  'logical-properties',
  'hover-pseudo',
  'type-only-import-passthrough',
]);

// esbuild bundle (React) + browser launch per case.
const CASE_TIMEOUT = 60000;

// The Emotion side bundles `@emotion/react` (a devDep of this package). Where it
// is not installed, skip rather than error — same philosophy as the browser
// requirement, so an under-provisioned CI stays green.
function emotionAvailable(): boolean {
  try {
    require.resolve('@emotion/react');
    return true;
  } catch (_error) {
    return false;
  }
}

function skipped(verdict: RenderVerdict): boolean {
  if (verdict.status === 'unavailable') {
    // eslint-disable-next-line no-console
    console.warn(`[render-gate] skipped: ${verdict.reason}`);
    return true;
  }
  return false;
}

const fixtures = loadFixtures('emotion').filter((f) =>
  RENDER_TESTABLE.has(f.name),
);

describe.each(fixtures.map((f) => [f.name, f]))(
  'render-gate faithfulness: %s',
  (_name, fixture) => {
    test(
      'Emotion input and StyleX output render identically',
      async () => {
        if (!emotionAvailable()) {
          // eslint-disable-next-line no-console
          console.warn('[render-gate] skipped: @emotion/react not installed');
          return;
        }
        const before = await emotionRenderDoc(fixture.input, {
          filename: fixture.inputPath,
        });
        const after = await stylexRenderDoc(fixture.expected, {
          filename: fixture.expectedPath,
        });
        const verdict = await renderStyleDiff(before, after);
        if (skipped(verdict)) {
          return;
        }
        if (verdict.status === 'mismatch') {
          // eslint-disable-next-line no-console
          console.error(`[${fixture.name}] diffs:`, verdict.diffs.slice(0, 6));
        }
        expect(verdict.status).toBe('match');
      },
      CASE_TIMEOUT,
    );
  },
);

test(
  'the render gate catches a value-divergent conversion',
  async () => {
    if (!emotionAvailable()) {
      // eslint-disable-next-line no-console
      console.warn('[render-gate] skipped: @emotion/react not installed');
      return;
    }
    const before = await emotionRenderDoc(
      '/** @jsxImportSource @emotion/react */\n' +
        "export default function A() { return <div css={{ color: 'red' }} />; }\n",
    );
    // A wrong "conversion": blue instead of red.
    const after = await stylexRenderDoc(
      "import * as stylex from '@stylexjs/stylex';\n" +
        "const styles = stylex.create({ x: { color: 'blue' } });\n" +
        'export default function A() { return <div {...stylex.props(styles.x)} />; }\n',
    );
    const verdict = await renderStyleDiff(before, after);
    if (skipped(verdict)) {
      return;
    }
    expect(verdict.status).toBe('mismatch');
    if (verdict.status === 'mismatch') {
      expect(verdict.diffs.some((d) => d.property === 'color')).toBe(true);
    }
  },
  CASE_TIMEOUT,
);

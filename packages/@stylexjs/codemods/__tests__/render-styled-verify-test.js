/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * M14c — the render gate as a component VERIFIER for `styled()`, proving it
 * catches the ADR-0003 risks that the static gates cannot see. This is the
 * capability the eventual `styled()` transform will lean on; here we verify a
 * hand-written conversion (the transform that GENERATES it is a later
 * milestone).
 *
 *   - a `styled.button` → StyleX forwardRef wrapper (supports `as`, merges
 *     className/style, forwards props) renders IDENTICALLY to Emotion's
 *     `styled` across standard prop-cases (default, a DOM prop, an `as` swap);
 *   - a wrapper that hardcodes the tag is CAUGHT on `as` (a `(structure)`
 *     finding — risk #2);
 *   - a wrapper that forwards a non-DOM prop Emotion would filter is CAUGHT via
 *     the new attribute diff (an `@<attr>` finding — risk #1, prop-filtering),
 *     which computed-style diffing alone misses. This is exactly the fidelity
 *     the transform must close with `@emotion/is-prop-valid`.
 *
 * Opt-in / heavyweight. Skips when no browser, or when the Emotion runtime
 * (`@emotion/react` + `@emotion/styled`) is not installed.
 */

import { verifyRender } from '../src/testing/renderPipeline';
import type { VerifyRenderResult } from '../src/testing/renderPipeline';

// esbuild bundle + browser launch per prop-case; a few cases each.
const CASE_TIMEOUT = 120000;

function renderDepsAvailable(): boolean {
  try {
    require.resolve('@emotion/react');
    require.resolve('@emotion/styled');
    return true;
  } catch (_error) {
    return false;
  }
}

function skipped(result: VerifyRenderResult): boolean {
  if (result.status === 'unavailable') {
    // eslint-disable-next-line no-console
    console.warn(`[render-gate] skipped: ${result.reason}`);
    return true;
  }
  return false;
}

function guard(): boolean {
  if (!renderDepsAvailable()) {
    // eslint-disable-next-line no-console
    console.warn(
      '[render-gate] skipped: @emotion/react + @emotion/styled needed',
    );
    return false;
  }
  return true;
}

const EMOTION_STYLED =
  "import styled from '@emotion/styled';\n" +
  'const Button = styled.button`\n  color: red;\n`;\n' +
  'export default function App(props) {\n' +
  '  return <Button {...props}>hi</Button>;\n' +
  '}\n';

// Supports `as`, merges className/style, forwards the rest, forwards ref — the
// faithful shape, minus prop-filtering (that gap is the third test).
const CORRECT_WRAPPER =
  "import * as React from 'react';\n" +
  "import * as stylex from '@stylexjs/stylex';\n" +
  'const styles = stylex.create({ button: { color: "red" } });\n' +
  'const Button = React.forwardRef(function Button(props, ref) {\n' +
  '  const { as: As = "button", className, style, ...rest } = props;\n' +
  '  const sx = stylex.props(styles.button);\n' +
  '  return React.createElement(As, {\n' +
  '    ref,\n' +
  '    ...rest,\n' +
  '    className: [sx.className, className].filter(Boolean).join(" "),\n' +
  '    style: { ...sx.style, ...style },\n' +
  '  });\n' +
  '});\n' +
  'export default function App(props) {\n' +
  '  return <Button {...props}>hi</Button>;\n' +
  '}\n';

// Ignores the `as` prop by hardcoding the element — the risk-#2 failure mode.
const HARDCODED_TAG_WRAPPER =
  "import * as React from 'react';\n" +
  "import * as stylex from '@stylexjs/stylex';\n" +
  'const styles = stylex.create({ button: { color: "red" } });\n' +
  'const Button = React.forwardRef(function Button(props, ref) {\n' +
  '  const { className, style, ...rest } = props;\n' +
  '  const sx = stylex.props(styles.button);\n' +
  '  return React.createElement("button", {\n' +
  '    ref,\n' +
  '    ...rest,\n' +
  '    className: [sx.className, className].filter(Boolean).join(" "),\n' +
  '    style: { ...sx.style, ...style },\n' +
  '  });\n' +
  '});\n' +
  'export default function App(props) {\n' +
  '  return <Button {...props}>hi</Button>;\n' +
  '}\n';

test(
  'a correct styled→wrapper renders identically across standard prop-cases',
  async () => {
    if (!guard()) {
      return;
    }
    const result = await verifyRender(EMOTION_STYLED, CORRECT_WRAPPER, {
      cases: [{}, { type: 'submit' }, { as: 'a', href: '#' }],
    });
    if (skipped(result)) {
      return;
    }
    if (result.status !== 'match') {
      // eslint-disable-next-line no-console
      console.error('unexpected diffs:', result);
    }
    expect(result.status).toBe('match');
  },
  CASE_TIMEOUT,
);

test(
  'the gate catches an `as`-ignoring wrapper as a structure finding',
  async () => {
    if (!guard()) {
      return;
    }
    const result = await verifyRender(EMOTION_STYLED, HARDCODED_TAG_WRAPPER, {
      cases: [{ as: 'a', href: '#' }],
    });
    if (skipped(result)) {
      return;
    }
    expect(result.status).toBe('mismatch');
    if (result.status === 'mismatch') {
      expect(result.diffs.some((d) => d.property === '(structure)')).toBe(true);
    }
  },
  CASE_TIMEOUT,
);

test(
  'the gate catches a leaked non-DOM prop via the attribute diff',
  async () => {
    if (!guard()) {
      return;
    }
    // CORRECT_WRAPPER forwards every prop; Emotion filters non-DOM props, so the
    // leaked attribute is the divergence — invisible to computed-style diffing.
    const result = await verifyRender(EMOTION_STYLED, CORRECT_WRAPPER, {
      cases: [{ custommark: 'x' }],
    });
    if (skipped(result)) {
      return;
    }
    expect(result.status).toBe('mismatch');
    if (result.status === 'mismatch') {
      expect(result.diffs.some((d) => d.property === '@custommark')).toBe(true);
    }
  },
  CASE_TIMEOUT,
);

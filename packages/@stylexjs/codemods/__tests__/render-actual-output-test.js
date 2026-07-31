/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * The closed loop: render-verify the codemod's ACTUAL output. For each
 * renderable fixture, run `transformEmotionFile(input)` and render-diff the
 * Emotion input against the codemod's real output (not the hand-maintained
 * `expected.js`). Plus one real OSS conversion (react-select `RequiredInput`,
 * MIT). Exercises the whole breadth — static, values, logical, pseudo,
 * keyframes, shorthands, template-literals, type-only, styled-flagged, and the
 * DYNAMIC (CSS-var function-form) fixtures — so it guards the render gate's
 * dynamic-var / animation normalization and the classic-`@jsx`-pragma handling.
 *
 * Opt-in / heavyweight; skips when no browser or the Emotion runtime is absent.
 */

import * as fs from 'fs';
import * as path from 'path';
import { transformEmotionFile } from '../src/adapters/emotion/transform';
import {
  emotionRenderDoc,
  stylexRenderDoc,
} from '../src/testing/renderPipeline';
import { renderStyleDiff } from '../src/testing/renderGate';

const DIR = path.join(__dirname, '..', '__fixtures__', 'emotion');

// fixture -> props to render with (dynamic fixtures need real prop values).
const FIXTURES: { [string]: { +[string]: mixed } } = {
  'static-flat-color': {},
  'static-values': {},
  'logical-properties': {},
  'hover-pseudo': {},
  'focus-media': {},
  'pseudo-element': {},
  'keyframes-spin': {},
  'shorthand-margin': {},
  'shorthand-padding': {},
  'css-call-form': {},
  'const-ref-object': {},
  'const-ref-template': {},
  'template-literal-static': {},
  'type-only-import-passthrough': {},
  'type-only-inline': {},
  'styled-with-css-prop': {},
  'styled-static-template': {},
  'styled-static-object': {},
  'styled-dynamic-template': { color: 'rgb(10, 20, 30)' },
  'styled-dynamic-destructured': { color: 'rgb(10, 20, 30)' },
  'dynamic-value': { color: 'rgb(10, 20, 30)' },
  'dynamic-two-params': { bg: 'rgb(1, 2, 3)', fg: 'rgb(200, 100, 50)' },
  'dynamic-ternary': { active: true },
  'dynamic-condition': { hoverColor: 'rgb(0, 0, 128)' },
  'dynamic-media': { largeSize: '40px' },
  'template-literal-interpolation': {
    color: 'rgb(9, 8, 7)',
    hover: 'rgb(1, 1, 1)',
  },
  'template-interp-partial': { gap: 12 },
  'styled-partial-interp': { size: 24 },
  'css-merge-style': {},
};

// react-select internal/RequiredInput.tsx (MIT), TS types stripped to Flow;
// classic `@jsx` pragma + the exact css object preserved.
const REQUIRED_INPUT =
  '/** @jsx jsx */\n' +
  "import { jsx } from '@emotion/react';\n" +
  'const RequiredInput = ({ name, onFocus }) => (\n' +
  '  <input required name={name} tabIndex={-1} aria-hidden="true" onFocus={onFocus}\n' +
  "    css={{ label: 'requiredInput', opacity: 0, pointerEvents: 'none', position: 'absolute', bottom: 0, left: 0, right: 0, width: '100%' }}\n" +
  '    value="" onChange={() => {}} />\n' +
  ');\n' +
  'export default RequiredInput;\n';

function emotionAvailable(): boolean {
  try {
    require.resolve('@emotion/react');
    return true;
  } catch (_error) {
    return false;
  }
}

async function verifyActualOutput(
  input: string,
  filename: string,
  props: { +[string]: mixed },
): Promise<'match' | 'unavailable' | string> {
  const result = transformEmotionFile(input, filename);
  if (result.status !== 'converted') {
    return `codemod status=${result.status}`;
  }
  const before = await emotionRenderDoc(input, { props, filename });
  const after = await stylexRenderDoc(result.code, { props, filename });
  const verdict = await renderStyleDiff(before, after);
  if (verdict.status === 'unavailable') {
    return 'unavailable';
  }
  if (verdict.status === 'match') {
    return 'match';
  }
  return verdict.diffs
    .slice(0, 5)
    .map((d) => `${d.property}[${d.before}!=${d.after}]`)
    .join('; ');
}

test("codemod's actual output renders identically across every renderable fixture", async () => {
  if (!emotionAvailable()) {
    return;
  }
  const mismatches: Array<string> = [];
  for (const name of Object.keys(FIXTURES)) {
    const input = fs.readFileSync(path.join(DIR, name, 'input.js'), 'utf8');
    const outcome = await verifyActualOutput(
      input,
      path.join(DIR, name, 'input.js'),
      FIXTURES[name],
    );
    if (outcome !== 'match' && outcome !== 'unavailable') {
      mismatches.push(`${name}: ${outcome}`);
    }
  }
  expect(mismatches).toEqual([]);
}, 300000);

test('a real OSS conversion (react-select RequiredInput) renders identically', async () => {
  if (!emotionAvailable()) {
    return;
  }
  const outcome = await verifyActualOutput(
    REQUIRED_INPUT,
    'RequiredInput.js',
    {},
  );
  if (outcome === 'unavailable') {
    return;
  }
  expect(outcome).toBe('match');
}, 60000);

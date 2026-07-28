/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Proves the render-gate ENGINE (M14a) on hand-authored render pairs, decoupled
 * from the source→render pipeline (that is M14b):
 *
 *   - two visually-equivalent renders that differ only in className/CSS shape
 *     (Emotion's hashed class vs StyleX's atomic class) MATCH — this is what
 *     makes the gate usable at all;
 *   - a render that drops a property MISMATCHES, pinpointing the property —
 *     the value divergence the gate exists to catch;
 *   - a render that changes the element (a `styled` `as`-style swap) MISMATCHES
 *     as a STRUCTURE finding — a change no net-CSS gate can see.
 *
 * Opt-in / heavyweight: needs a real Chromium. Each case treats an
 * `unavailable` verdict as a skip, so a browserless CI stays green.
 */

import { renderStyleDiff } from '../src/testing/renderGate';
import type { RenderVerdict } from '../src/testing/renderGate';

// Browser launch + two renders per case; give each case room.
const CASE_TIMEOUT = 30000;

function skippedIfUnavailable(verdict: RenderVerdict): boolean {
  if (verdict.status === 'unavailable') {
    // eslint-disable-next-line no-console
    console.warn(`[render-gate] skipped: ${verdict.reason}`);
    return true;
  }
  return false;
}

test(
  'visually-equivalent renders (different class/CSS) MATCH',
  async () => {
    const verdict = await renderStyleDiff(
      {
        html: '<div class="e">hi</div>',
        css: '.e{color:rgb(1,2,3);padding:4px}',
      },
      {
        html: '<div class="x1">hi</div>',
        css: '.x1{color:rgb(1,2,3);padding:4px}',
      },
    );
    if (skippedIfUnavailable(verdict)) {
      return;
    }
    expect(verdict.status).toBe('match');
  },
  CASE_TIMEOUT,
);

test(
  'a dropped property MISMATCHES and pinpoints it',
  async () => {
    const verdict = await renderStyleDiff(
      {
        html: '<div class="e">hi</div>',
        css: '.e{color:rgb(1,2,3);padding:4px}',
      },
      { html: '<div class="x1">hi</div>', css: '.x1{color:rgb(1,2,3)}' },
    );
    if (skippedIfUnavailable(verdict)) {
      return;
    }
    expect(verdict.status).toBe('mismatch');
    if (verdict.status !== 'mismatch') {
      return;
    }
    const padding = verdict.diffs.find((d) => d.property === 'padding-top');
    expect(padding).toBeDefined();
    expect(padding?.before).toBe('4px');
    expect(padding?.after).toBe('0px');
  },
  CASE_TIMEOUT,
);

test(
  'a changed element (as-prop swap) MISMATCHES as a structure finding',
  async () => {
    const verdict = await renderStyleDiff(
      { html: '<div class="e">hi</div>', css: '.e{color:rgb(1,2,3)}' },
      { html: '<span class="x1">hi</span>', css: '.x1{color:rgb(1,2,3)}' },
    );
    if (skippedIfUnavailable(verdict)) {
      return;
    }
    expect(verdict.status).toBe('mismatch');
    if (verdict.status !== 'mismatch') {
      return;
    }
    const structure = verdict.diffs.find((d) => d.property === '(structure)');
    expect(structure).toBeDefined();
    expect(structure?.before).toBe('div');
    expect(structure?.after).toBe('span');
  },
  CASE_TIMEOUT,
);

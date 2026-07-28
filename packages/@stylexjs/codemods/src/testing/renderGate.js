/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * The render gate (M14) — the verifier the static gates can't be.
 *
 * The compile/lint/semantic-diff gates read *source*: they prove the emitted
 * CSS is net-equivalent to Emotion's. But a whole class of real conversions is
 * invisible to them — the correctness lives in what the browser *renders*, not
 * in the source: a runtime className's landing spot (`css` + spread), a
 * `styled()` component's prop-filtering / `as` / ref / className precedence,
 * and a theme token's resolved value. For those, the only ground truth is the
 * rendered DOM.
 *
 * This gate renders two documents in a real browser and diffs the **computed
 * styles** of their rendered subtrees, element by element, in lockstep. Because
 * both documents render the same element structure with the same content, every
 * property the CSS does *not* touch falls back to the identical browser default
 * on both sides and cancels — so a full-property comparison surfaces exactly
 * (and only) what the conversion changed, including a changed element (`as`) or
 * a dropped/added node (a wrapper) as a structural finding.
 *
 * Heavyweight and opt-in: it needs a real Chromium. `isRenderGateAvailable()`
 * probes for one; callers (tests) skip when it returns false, so a browserless
 * CI stays green. Chrome is resolved via Playwright's `channel: 'chrome'`, with
 * a `STYLEX_CODEMOD_CHROME` executable-path override.
 *
 * This module renders *already-built* documents (`RenderDoc`). Turning a
 * before/after component **source** into those documents (esbuild + the emotion
 * runtime for before; the StyleX babel plugin's CSS for after) is M14b.
 */

import { chromium } from 'playwright';

/** A document to render: the markup for the compared subtree, plus optional
 * `<style>` CSS (e.g. StyleX's compiled atomic rules) injected into `<head>`. */
export type RenderDoc = {
  +html: string,
  +css?: string,
};

/** One place the two renders disagree. `property` is `'(structure)'` for a
 * shape mismatch (different tag, or a missing/extra node) at `path`. */
export type StyleDiff = {
  +path: string,
  +property: string,
  +before: string,
  +after: string,
};

export type RenderVerdict =
  | { +status: 'match' }
  | { +status: 'mismatch', +diffs: $ReadOnlyArray<StyleDiff> }
  | { +status: 'unavailable', +reason: string };

// Computed properties that carry environment noise rather than anything the
// conversion controls — kept empty until a proven-equivalent render shows real
// spurious noise, so the gate stays maximally strict by default.
const IGNORED_PROPERTIES: Set<string> = new Set([]);

// Cap the reported diffs so a wholesale mismatch stays readable.
const MAX_DIFFS = 50;

const DEFAULT_VIEWPORT = { width: 1024, height: 768 };

/** A serialized element: tag, its full computed style, and its children. */
type StyleNode = {
  tag: string,
  styles: { [string]: string },
  children: Array<StyleNode>,
};

type LaunchOpt = { +channel?: string, +executablePath?: string };

function launchOptions(): $ReadOnlyArray<LaunchOpt> {
  const override = process.env.STYLEX_CODEMOD_CHROME;
  const attempts: Array<LaunchOpt> = [{ channel: 'chrome' }];
  if (override != null && override !== '') {
    attempts.push({ executablePath: override });
  }
  return attempts;
}

async function launchBrowser(): Promise<$FlowFixMe | null> {
  // Escape hatch: force the gate off (e.g. to keep a CI job browser-free even
  // where Chrome happens to be installed).
  if (process.env.STYLEX_CODEMOD_RENDER_GATE === '0') {
    return null;
  }
  for (const opts of launchOptions()) {
    try {
      return await chromium.launch({ ...opts, headless: true });
    } catch (_error) {
      // try the next resolution strategy
    }
  }
  return null;
}

/** Whether a real Chromium can be launched here (so tests can skip cleanly). */
export async function isRenderGateAvailable(): Promise<boolean> {
  const browser = await launchBrowser();
  if (browser == null) {
    return false;
  }
  await browser.close();
  return true;
}

const DOC = (doc: RenderDoc): string =>
  '<!doctype html><html><head><meta charset="utf-8">' +
  `<style>${doc.css ?? ''}</style></head>` +
  `<body><div id="render-root">${doc.html}</div></body></html>`;

// Runs in the browser: walk #render-root and serialize each element with its
// full computed style. Defined as a string so Flow/eslint don't parse the
// browser globals in this Node module.
const COLLECT_FN = `() => {
  const walk = (el) => {
    const cs = getComputedStyle(el);
    const styles = {};
    for (let i = 0; i < cs.length; i++) {
      const prop = cs[i];
      styles[prop] = cs.getPropertyValue(prop);
    }
    const children = [];
    for (const child of el.children) children.push(walk(child));
    return { tag: el.tagName.toLowerCase(), styles, children };
  };
  const root = document.getElementById('render-root');
  const out = [];
  for (const child of root.children) out.push(walk(child));
  return out;
}`;

async function collect(
  page: $FlowFixMe,
  doc: RenderDoc,
): Promise<Array<StyleNode>> {
  await page.setContent(DOC(doc), { waitUntil: 'load' });
  // COLLECT_FN is a string (so this Node module never parses browser globals);
  // wrap it as an invoked IIFE so `evaluate` returns the call's result, not the
  // function value.
  return page.evaluate(`(${COLLECT_FN})()`);
}

function diffStyles(
  path: string,
  a: StyleNode,
  b: StyleNode,
  diffs: Array<StyleDiff>,
): void {
  const props = new Set([...Object.keys(a.styles), ...Object.keys(b.styles)]);
  for (const prop of props) {
    if (IGNORED_PROPERTIES.has(prop)) {
      continue;
    }
    const before = a.styles[prop] ?? '';
    const after = b.styles[prop] ?? '';
    if (before !== after) {
      diffs.push({ path, property: prop, before, after });
    }
  }
}

function diffNodes(
  path: string,
  a: Array<StyleNode>,
  b: Array<StyleNode>,
  diffs: Array<StyleDiff>,
): void {
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (diffs.length >= MAX_DIFFS) {
      return;
    }
    const na = a[i];
    const nb = b[i];
    const here = `${path} > [${i}]`;
    if (na == null || nb == null) {
      diffs.push({
        path: here,
        property: '(structure)',
        before: na == null ? '(missing)' : na.tag,
        after: nb == null ? '(missing)' : nb.tag,
      });
      continue;
    }
    if (na.tag !== nb.tag) {
      diffs.push({
        path: here,
        property: '(structure)',
        before: na.tag,
        after: nb.tag,
      });
      continue;
    }
    diffStyles(`${here} ${na.tag}`, na, nb, diffs);
    diffNodes(here, na.children, nb.children, diffs);
  }
}

/**
 * Render `before` and `after` and diff their rendered subtrees' computed
 * styles. Returns `unavailable` (never throws) when no browser can be launched.
 */
export async function renderStyleDiff(
  before: RenderDoc,
  after: RenderDoc,
): Promise<RenderVerdict> {
  const browser = await launchBrowser();
  if (browser == null) {
    return {
      status: 'unavailable',
      reason:
        'no Chrome could be launched (set STYLEX_CODEMOD_CHROME to an ' +
        'executable path, or install Google Chrome)',
    };
  }
  try {
    const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT });
    const beforeTree = await collect(page, before);
    const afterTree = await collect(page, after);
    const diffs: Array<StyleDiff> = [];
    diffNodes('root', beforeTree, afterTree, diffs);
    return diffs.length === 0
      ? { status: 'match' }
      : { status: 'mismatch', diffs };
  } finally {
    await browser.close();
  }
}

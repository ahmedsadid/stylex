/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * M5 per-site flagging: convert what is safe, leave a `// TODO` marker on the
 * rest, and never silently drop or re-flag.
 */

import { transformEmotionFile } from '../src/adapters/emotion/transform';

const HEADER =
  '/** @jsxImportSource @emotion/react */\n' +
  "import * as React from 'react';\n";

test('a flag marker is not duplicated on a second run (re-run guard)', () => {
  const input =
    HEADER +
    'export default function C() {\n' +
    '  return (\n' +
    '    <div>\n' +
    "      <button css={{ color: 'blue', '& > li': { color: 'red' } }}>x</button>\n" +
    '    </div>\n' +
    '  );\n' +
    '}\n';
  const first = transformEmotionFile(input, 'in.js');
  expect(first.status).toBe('converted');
  if (first.status !== 'converted') {
    return;
  }
  expect(first.flags.length).toBe(1);
  const markerCount = (s: string) =>
    (s.match(/TODO\(stylex-migration\)/g) ?? []).length;
  expect(markerCount(first.code)).toBe(1);

  // Running again on the already-flagged output must not add a second marker.
  const second = transformEmotionFile(first.code, 'in.js');
  if (second.status === 'converted') {
    expect(markerCount(second.code)).toBe(1);
  } else {
    // 'unchanged' is also acceptable (nothing left to do).
    expect(second.status).toBe('unchanged');
  }
});

test('a whole-file structural issue still refuses (does not flag)', () => {
  // Non-namespace stylex import can't be merged into — whole-file refusal.
  const input = [
    '/** @jsxImportSource @emotion/react */',
    "import * as React from 'react';",
    "import { create } from '@stylexjs/stylex';",
    "const s = create({ a: { color: 'red' } });",
    'export default function C() {',
    "  return <span css={{ color: 'gray' }}>{s ? 'x' : 'y'}</span>;",
    '}',
    '',
  ].join('\n');
  const result = transformEmotionFile(input, 'in.js');
  expect(result.status).toBe('skipped');
  if (result.status === 'skipped') {
    expect(result.reasons.join('\n')).toMatch(/namespace/);
  }
});

test('a fully-convertible file reports no flags', () => {
  const input =
    HEADER +
    'export default function C() {\n' +
    "  return <span css={{ color: 'gray' }}>x</span>;\n" +
    '}\n';
  const result = transformEmotionFile(input, 'in.js');
  expect(result.status).toBe('converted');
  if (result.status === 'converted') {
    expect(result.flags).toEqual([]);
  }
});

// --- Per-candidate scopedFix isolation ---------------------------------------
// A rule StyleX's valid-styles rejects (`zIndex: '10'`, a numeric string) used
// to refuse the WHOLE file via the batched scopedFix. Isolation drops just that
// rule and flags its candidate, so the file's other sites still convert.

test('a StyleX-invalid site is isolated: the good site converts, the bad flags', () => {
  const input =
    HEADER +
    'export default function C() {\n' +
    '  return (\n' +
    '    <div>\n' +
    "      <span css={{ color: 'red', padding: 8 }}>ok</span>\n" +
    "      <span css={{ zIndex: '10' }}>bad</span>\n" +
    '    </div>\n' +
    '  );\n' +
    '}\n';
  const result = transformEmotionFile(input, 'in.js');
  expect(result.status).toBe('converted');
  if (result.status !== 'converted') {
    return;
  }
  // Good site converted; its create key is present and its css site rewritten.
  expect(result.code).toContain('stylex.create');
  expect(result.code).toContain("color: 'red'");
  // Bad site kept its Emotion css and got a concrete TODO reason.
  expect(result.code).toContain("css={{ zIndex: '10' }}");
  expect(result.code).toMatch(/TODO\(stylex-migration\).*zIndex/);
  expect(result.flags.length).toBe(1);
  // Only the surviving site is reported for verification (the dropped rule is
  // not in the create, so verify never looks for a missing key).
  expect(result.sites.length).toBe(1);
  // The create block itself has only the good rule (the flagged zIndex stays in
  // its retained Emotion css, but is not emitted into `stylex.create`).
  const createBlock = result.code.slice(
    result.code.indexOf('stylex.create'),
    result.code.indexOf('export default'),
  );
  expect(createBlock).not.toContain('zIndex');
});

test('a lone StyleX-invalid site is flagged per-site, not whole-file refused', () => {
  // A valid-styles residual is a per-site issue, so even the only site flags in
  // place (converted + TODO) rather than refusing the whole file — the same
  // in-file, loud treatment a mixed file gets.
  const input =
    HEADER +
    'export default function C() {\n' +
    "  return <span css={{ zIndex: '10' }}>x</span>;\n" +
    '}\n';
  const result = transformEmotionFile(input, 'in.js');
  expect(result.status).toBe('converted');
  if (result.status !== 'converted') {
    return;
  }
  expect(result.flags.length).toBe(1);
  expect(result.sites).toEqual([]);
  // Nothing convertible survived, so no dangling empty registry or stylex import.
  expect(result.code).not.toContain('stylex.create');
  expect(result.code).not.toContain("from '@stylexjs/stylex'");
  // The Emotion css stays with a concrete TODO.
  expect(result.code).toContain("css={{ zIndex: '10' }}");
  expect(result.code).toMatch(/TODO\(stylex-migration\).*zIndex/);
});

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Auto-derived render cases from co-located Storybook stories. Bounded + safe:
 * literal args only, co-located only, never throws.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deriveRenderCases } from '../src/cli/deriveRenderCases';

function withStories(stories: string): { dir: string, component: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stylex-drc-'));
  fs.writeFileSync(path.join(dir, 'Button.stories.tsx'), stories);
  return { dir, component: path.join(dir, 'Button.tsx') };
}

test('derives CSF3 named-story args + meta args (deduped)', () => {
  const { component } = withStories(
    'export default { component: Button, args: { variant: "primary" } };\n' +
      'export const Large = { args: { size: "large", count: 3 } };\n' +
      'export const Small = { args: { size: "small" } };\n' +
      'export const Dup = { args: { size: "small" } };\n',
  );
  expect(deriveRenderCases(component)).toEqual([
    { variant: 'primary' },
    { size: 'large', count: 3 },
    { size: 'small' }, // Dup deduped
  ]);
});

test('keeps literal args, skips non-literal ones (JSX / function)', () => {
  const { component } = withStories(
    'export const A = { args: { label: "hi", icon: <Icon/>, onClick: () => {} } };\n',
  );
  expect(deriveRenderCases(component)).toEqual([{ label: 'hi' }]);
});

test('handles the CSF2 `X.args = {…}` form', () => {
  const { component } = withStories(
    'export const A = Template.bind({});\n' +
      'A.args = { disabled: true, level: 2 };\n',
  );
  expect(deriveRenderCases(component)).toEqual([{ disabled: true, level: 2 }]);
});

test('nested literal objects/arrays are kept; a story with no usable args is dropped', () => {
  const { component } = withStories(
    'export const A = { args: { style: { pad: 4 }, tags: ["a", "b"] } };\n' +
      'export const B = { args: { render: someFn } };\n',
  );
  expect(deriveRenderCases(component)).toEqual([
    { style: { pad: 4 }, tags: ['a', 'b'] },
  ]);
});

test('no co-located stories file → [] (safe fallback to [{}])', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stylex-drc-'));
  expect(deriveRenderCases(path.join(dir, 'Button.tsx'))).toEqual([]);
});

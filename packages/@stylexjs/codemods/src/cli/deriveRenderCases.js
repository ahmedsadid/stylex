/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Auto-derives render-check props from a component's co-located Storybook file
 * (`Button.tsx` → `Button.stories.tsx`), so dynamic components are exercised
 * under real prop variations without hand-listing them in `renderCases`.
 *
 * Bounded and safe by design:
 *   - **Co-located only** — same directory, same basename, `.stories.` infix. No
 *     import-graph / cross-file analysis (that's a separate, deferred feature).
 *   - **Literal args only** — a story arg that's a string / number / boolean /
 *     null / array / plain object of those is taken; anything else (a JSX node,
 *     a function, an identifier) is skipped, because render props must be
 *     JSON-serializable. A story with no literal args contributes nothing.
 *   - **Never throws / never guesses** — no stories file, a parse error, or no
 *     usable args → `[]`, and the caller falls back to `[{}]`.
 *
 * Handles CSF3 (`export const X = { args: {…} }`), meta args (the default
 * export's `args`), and CSF2 (`X.args = {…}`).
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseSource, parserForFile } from '../core/rewriter';

const STORY_EXTS: $ReadOnlyArray<string> = ['.tsx', '.ts', '.jsx', '.js'];

/** The co-located `<base>.stories.<ext>` for a component path, or null. */
function storiesFileFor(componentPath: string): string | null {
  const dir = path.dirname(componentPath);
  const base = path.basename(componentPath).replace(/\.[jt]sx?$/, '');
  for (const ext of STORY_EXTS) {
    const candidate = path.join(dir, `${base}.stories${ext}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** A JSON-serializable literal value from an AST node, or `undefined` to skip. */
function literalValue(node: $FlowFixMe): mixed {
  if (node == null) {
    return undefined;
  }
  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return node.value;
    case 'Literal':
      // hermes/estree: strings, numbers, booleans, null all arrive as Literal.
      return node.value;
    case 'NullLiteral':
      return null;
    case 'UnaryExpression': {
      if (node.operator === '-') {
        const inner = literalValue(node.argument);
        return typeof inner === 'number' ? -inner : undefined;
      }
      return undefined;
    }
    case 'ArrayExpression': {
      const out: Array<mixed> = [];
      for (const el of node.elements) {
        const v = literalValue(el);
        if (v === undefined) {
          return undefined; // a non-literal element → not serializable
        }
        out.push(v);
      }
      return out;
    }
    case 'ObjectExpression':
      return objectLiteralToProps(node);
    default:
      return undefined;
  }
}

/** An ObjectExpression → a plain object of its LITERAL properties (skips the
 * rest); `undefined` if it isn't a usable literal object. */
function objectLiteralToProps(node: $FlowFixMe): { [string]: mixed } | void {
  if (node == null || node.type !== 'ObjectExpression') {
    return undefined;
  }
  const props: { [string]: mixed } = {};
  for (const prop of node.properties) {
    if (
      (prop.type !== 'Property' && prop.type !== 'ObjectProperty') ||
      prop.computed
    ) {
      continue; // spread / computed / method → skip
    }
    const key =
      prop.key?.type === 'Identifier'
        ? prop.key.name
        : prop.key?.type === 'Literal' || prop.key?.type === 'StringLiteral'
          ? String(prop.key.value)
          : null;
    if (key == null) {
      continue;
    }
    const value = literalValue(prop.value);
    if (value !== undefined) {
      props[key] = value;
    }
  }
  return props;
}

/** The `args` object of a story/meta ObjectExpression, as props, or undefined. */
function argsOf(objExpr: $FlowFixMe): { [string]: mixed } | void {
  if (objExpr == null || objExpr.type !== 'ObjectExpression') {
    return undefined;
  }
  for (const prop of objExpr.properties) {
    if (
      (prop.type === 'Property' || prop.type === 'ObjectProperty') &&
      !prop.computed &&
      prop.key?.type === 'Identifier' &&
      prop.key.name === 'args'
    ) {
      return objectLiteralToProps(prop.value);
    }
  }
  return undefined;
}

/**
 * Render-case prop objects derived from a component's co-located stories, or
 * `[]` (no stories / none usable). Deduped; each is JSON-serializable.
 */
export function deriveRenderCases(
  componentPath: string,
): Array<{ +[string]: mixed }> {
  const storiesPath = storiesFileFor(componentPath);
  if (storiesPath == null) {
    return [];
  }
  let source: string;
  try {
    source = fs.readFileSync(storiesPath, 'utf8');
  } catch {
    return [];
  }
  let j, root;
  try {
    ({ j, root } = parseSource(source, {
      parser: parserForFile(storiesPath),
    }));
  } catch {
    return [];
  }

  const collected: Array<{ [string]: mixed }> = [];
  const add = (props: { [string]: mixed } | void) => {
    if (props != null && Object.keys(props).length > 0) {
      collected.push(props);
    }
  };

  // Default export (CSF meta) args.
  root.find(j.ExportDefaultDeclaration).forEach((p: $FlowFixMe) => {
    add(argsOf(p.node.declaration));
  });
  // Named `export const X = { args: {…} }` (CSF3).
  root.find(j.ExportNamedDeclaration).forEach((p: $FlowFixMe) => {
    const decl = p.node.declaration;
    if (decl != null && decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        add(argsOf(d.init));
      }
    }
  });
  // `X.args = {…}` (CSF2).
  root.find(j.AssignmentExpression).forEach((p: $FlowFixMe) => {
    const { left, right } = p.node;
    if (
      left.type === 'MemberExpression' &&
      !left.computed &&
      left.property?.type === 'Identifier' &&
      left.property.name === 'args'
    ) {
      add(objectLiteralToProps(right));
    }
  });

  // Dedupe by shape.
  const seen: Set<string> = new Set();
  const unique: Array<{ [string]: mixed }> = [];
  for (const props of collected) {
    const key = JSON.stringify(props);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(props);
    }
  }
  return unique;
}

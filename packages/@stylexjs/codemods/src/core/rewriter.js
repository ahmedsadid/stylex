/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * The single place in the codebase that knows which AST toolkit we use.
 * Everything else (core and adapters alike) goes through this wrapper, so
 * jscodeshift/recast stays swappable (hermes-parser, ts-morph, plain
 * babel+recast) without touching any other module — a maintainer question
 * we have deliberately kept open.
 *
 * jscodeshift is the default: format-preserving printing via recast, and
 * parses the Flow/TS/JSX found in user code. Adapters receive `j` and
 * `root` from here and never import the toolkit themselves (enforced by
 * seam-test); `core/` outside this file never sees an AST node at all.
 */

import jscodeshift from 'jscodeshift';
import type { EmittedRule, EmittedStyle, EmittedValue } from './emit';

// 'flow' also covers plain JS + JSX; 'tsx' also covers plain TS.
export type ParserChoice = 'flow' | 'tsx';

export type Rewriter = {
  +j: $FlowFixMe,
  +root: $FlowFixMe,
};

/** Picks a parser from the file extension (TS/TSX vs Flow/JS). */
export function parserForFile(filename: string): ParserChoice {
  return /\.(ts|tsx|mts|cts)$/.test(filename) ? 'tsx' : 'flow';
}

/** Parses source into a rewriter handle (a jscodeshift Collection). */
export function parseSource(
  source: string,
  options?: { +parser?: ParserChoice },
): Rewriter {
  const j = jscodeshift.withParser(options?.parser ?? 'flow');
  return { j, root: j(source) };
}

/** Prints a rewriter handle back to source, format-preserving. */
export function printSource(rewriter: Rewriter): string {
  return rewriter.root.toSource({ quote: 'single' });
}

/**
 * Builds a JSX comment container node — the braced comment form that is valid
 * as a JSX child, unlike a bare block comment which would render as visible
 * text. Parses a real one so recast reprints it correctly.
 */
export function jsxComment(j: $FlowFixMe, text: string): $FlowFixMe {
  let container = null;
  j(`<x>{/*${text}*/}</x>`)
    .find(j.JSXExpressionContainer)
    .forEach((path: $FlowFixMe) => {
      container = path.node;
    });
  return container;
}

/**
 * Renders emitted style data (plain values, fallback arrays, or nested
 * condition objects) as an ObjectExpression — the bridge that lets
 * `core/emit.js` stay AST-free.
 */
export function styleToObjectAst(
  j: $FlowFixMe,
  style: EmittedStyle,
): $FlowFixMe {
  return objectAst(j, style);
}

const IDENTIFIER_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A property/condition key: bare identifier where legal, else a string
 * literal (`':hover'`, `'@media (min-width: 600px)'`). */
function keyAst(j: $FlowFixMe, key: string): $FlowFixMe {
  return IDENTIFIER_KEY.test(key) ? j.identifier(key) : j.literal(key);
}

function valueAst(j: $FlowFixMe, value: EmittedValue): $FlowFixMe {
  if (Array.isArray(value)) {
    return j.arrayExpression(value.map((v) => j.literal(v)));
  }
  if (value != null && typeof value === 'object') {
    // A reference sentinel renders as a bare identifier (e.g. `animationName:
    // spin`), not a string literal.
    if (typeof value.$$ref === 'string') {
      return j.identifier(value.$$ref);
    }
    // A dynamic sentinel renders as the bare parameter identifier used inside
    // the create function body (e.g. `color: color`).
    if (typeof value.$$dyn === 'string') {
      return j.identifier(value.$$dyn);
    }
    // A token sentinel renders as a member expression on a defineVars import
    // (e.g. `padding: vars.spaceMd`).
    const token: $FlowFixMe = (value as $FlowFixMe).$$token;
    if (token != null) {
      return j.memberExpression(
        j.identifier(token.object),
        j.identifier(token.property),
      );
    }
    return objectAst(j, value);
  }
  return j.literal(value);
}

/**
 * Builds the `stylex.create({...})` argument object from emitted rules,
 * wrapping any dynamic rule as a function-form entry `key: (…params) => ({…})`
 * (the object body is parenthesized so it is a return value, not a block).
 */
export function createObjectAst(
  j: $FlowFixMe,
  rules: $ReadOnlyArray<EmittedRule>,
): $FlowFixMe {
  return j.objectExpression(
    rules.map((rule) => {
      const body = objectAst(j, rule.style);
      const value =
        rule.params.length === 0
          ? body
          : j.arrowFunctionExpression(
              rule.params.map((p) => j.identifier(p)),
              body,
            );
      return j.property('init', keyAst(j, rule.key), value);
    }),
  );
}

function objectAst(
  j: $FlowFixMe,
  object: { +[string]: EmittedValue },
): $FlowFixMe {
  return j.objectExpression(
    Object.keys(object).map((key) =>
      j.property('init', keyAst(j, key), valueAst(j, object[key])),
    ),
  );
}

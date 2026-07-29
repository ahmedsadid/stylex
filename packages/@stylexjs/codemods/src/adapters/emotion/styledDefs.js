/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Detects module-level `styled()` definitions and classifies the ones M15a can
 * convert: a STATIC HOST target — `styled.tag` / `styled('tag')` with either a
 * static `` `…` `` template (no interpolation) or an object literal with no
 * dynamic (function) values. Everything else — `styled(Component)` composition,
 * prop/theme interpolation, `.attrs` / `.withComponent` / `shouldForwardProp` —
 * is left for its own later slice and keeps M11a's per-site flag.
 *
 * A convertible def yields the css `objectNode` (the template lowered via the
 * M10 text→object path, or the object arg as-is) so the rest of the pipeline
 * reads it exactly like a css-prop object.
 */

import { cssTemplateToObjectAst } from './cssText';

export type StyledDef = {
  +path: $FlowFixMe, // the VariableDeclaration path
  +componentName: string,
  +baseTag: string,
  +objectNode: $FlowFixMe, // css ObjectExpression
};

// HTML/SVG host tags are lowercase identifiers; a capitalized name is a
// component (composition), which we don't convert here.
const HOST_TAG = /^[a-z][a-zA-Z0-9-]*$/;

// `styled.tag` or `styled('tag')` → the host tag name, else null (component).
function hostTagOf(
  j: $FlowFixMe,
  node: $FlowFixMe,
  styled: string,
): string | null {
  // styled.tag
  if (
    node.type === 'MemberExpression' &&
    node.object.type === 'Identifier' &&
    node.object.name === styled &&
    !node.computed &&
    node.property.type === 'Identifier'
  ) {
    return HOST_TAG.test(node.property.name) ? node.property.name : null;
  }
  // styled('tag') — the string literal is `Literal` (flow/hermes) or
  // `StringLiteral` (TS/babel), so accept both.
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === styled &&
    node.arguments.length === 1 &&
    (node.arguments[0].type === 'Literal' ||
      node.arguments[0].type === 'StringLiteral') &&
    typeof node.arguments[0].value === 'string'
  ) {
    const tag = String(node.arguments[0].value);
    return HOST_TAG.test(tag) ? tag : null;
  }
  return null;
}

function objectHasDynamic(node: $FlowFixMe): boolean {
  if (node == null || node.type !== 'ObjectExpression') {
    return true; // not a plain object literal → treat as non-static
  }
  for (const property of node.properties) {
    if (property.type !== 'Property' && property.type !== 'ObjectProperty') {
      return true; // spread
    }
    const value = property.value;
    if (
      value.type === 'ArrowFunctionExpression' ||
      value.type === 'FunctionExpression'
    ) {
      return true; // `prop: (p) => …` dynamic
    }
    if (value.type === 'ObjectExpression' && objectHasDynamic(value)) {
      return true;
    }
  }
  return false;
}

/** The css object for a convertible static host styled def, or null. */
function convertibleCss(
  j: $FlowFixMe,
  init: $FlowFixMe,
  styled: string,
): { +baseTag: string, +objectNode: $FlowFixMe } | null {
  // styled.tag`…` / styled('tag')`…`  (static template only)
  if (init.type === 'TaggedTemplateExpression') {
    const baseTag = hostTagOf(j, init.tag, styled);
    if (baseTag == null || init.quasi.expressions.length > 0) {
      return null;
    }
    const objectNode = cssTemplateToObjectAst(j, init.quasi);
    return objectNode == null ? null : { baseTag, objectNode };
  }
  // styled.tag({…}) / styled('tag')({…})  (static object only)
  if (init.type === 'CallExpression') {
    const baseTag = hostTagOf(j, init.callee, styled);
    const arg = init.arguments[0];
    if (baseTag == null || arg == null || objectHasDynamic(arg)) {
      return null;
    }
    return { baseTag, objectNode: arg };
  }
  return null;
}

/** All convertible static host styled defs in the file. */
export function detectStyledDefs(
  j: $FlowFixMe,
  root: $FlowFixMe,
  styledLocalName: string,
): Array<StyledDef> {
  const defs: Array<StyledDef> = [];
  root.find(j.VariableDeclaration).forEach((path: $FlowFixMe) => {
    // Top-level: `const X = …` (parent Program) or `export const X = …`
    // (parent ExportNamedDeclaration whose parent is Program). Replacing the
    // inner VariableDeclaration keeps any `export` wrapper intact.
    const parentType = path.parent.node.type;
    const isTopLevel =
      parentType === 'Program' ||
      (parentType === 'ExportNamedDeclaration' &&
        path.parent.parent?.node?.type === 'Program');
    if (!isTopLevel || path.node.declarations.length !== 1) {
      return;
    }
    const decl = path.node.declarations[0];
    if (
      decl.id.type !== 'Identifier' ||
      decl.init == null ||
      path.node.kind !== 'const'
    ) {
      return;
    }
    const css = convertibleCss(j, decl.init, styledLocalName);
    if (css == null) {
      return;
    }
    defs.push({
      path,
      componentName: decl.id.name,
      baseTag: css.baseTag,
      objectNode: css.objectNode,
    });
  });
  return defs;
}

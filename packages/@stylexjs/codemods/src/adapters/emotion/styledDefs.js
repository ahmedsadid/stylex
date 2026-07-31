/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Detects module-level `styled()` definitions and classifies the convertible
 * ones — a HOST target `styled.tag` / `styled('tag')` whose styles are:
 *   - a static template or object (M15a), or
 *   - a template with prop-arrow interpolations `${p => p.color}` /
 *     `${({size}) => size}` (M15b), rewritten so the arrow's prop reads become
 *     the wrapper's `props`.
 * Everything else keeps M11a's per-site flag and its own later slice:
 * `styled(Component)` composition, `.theme` reads (→ M13), object-form dynamics
 * (Emotion doesn't apply per-value functions like a template does), partial
 * interpolations (`${x}px`), `.attrs` / `.withComponent` / `shouldForwardProp`.
 *
 * A convertible def yields the css `objectNode` (the template lowered via the
 * M10 text→object path, or the object arg as-is) so the rest of the pipeline
 * reads it exactly like a css-prop object; a prop-arrow value becomes an M8
 * dynamic value.
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

// Positions where an identifier is a name, not a value reference — so a param
// rename must skip them (`p.theme` → the `theme` member name stays; `{p: 1}`
// key stays).
function isNameOnlyPosition(parent: $FlowFixMe, node: $FlowFixMe): boolean {
  if (parent == null) {
    return false;
  }
  if (
    parent.type === 'MemberExpression' &&
    parent.property === node &&
    !parent.computed
  ) {
    return true;
  }
  if (
    (parent.type === 'Property' || parent.type === 'ObjectProperty') &&
    parent.key === node &&
    !parent.computed
  ) {
    return true;
  }
  return false;
}

/** Prints an expression node to source (throwaway wrapper), so we can reparse
 * it into a clean, cycle-free clone rather than hand-walking the live AST
 * (recast nodes have cyclic back-references that overflow a naive recursion). */
function printExpr(j: $FlowFixMe, node: $FlowFixMe): string {
  return j(j.expressionStatement(node))
    .toSource({ quote: 'single' })
    .replace(/;\s*$/, '');
}

// `${(p) => <expr>}` / `${({size}) => <expr>}` → the expression rewritten so the
// param's prop reads become the wrapper's `props`, or null when the arrow isn't
// one we can convert (block body, multiple params, an unusual param pattern, a
// `.theme` read, or not an arrow at all). Works by print+reparse (a clean clone)
// then jscodeshift traversal — never hand-walk the cyclic live AST.
function propArrowToExpr(j: $FlowFixMe, expr: $FlowFixMe): $FlowFixMe | null {
  if (
    expr.type !== 'ArrowFunctionExpression' ||
    expr.params.length !== 1 ||
    expr.body.type === 'BlockStatement'
  ) {
    return null;
  }
  const param = expr.params[0];
  if (param.type !== 'Identifier' && param.type !== 'ObjectPattern') {
    return null;
  }
  const reparsed = j(`(${printExpr(j, expr.body)});`);

  // Refuse any `.theme` read — an Emotion ThemeProvider value, not a StyleX
  // prop; converting it would reference a non-existent `props.theme` (M13).
  const readsTheme =
    reparsed
      .find(j.MemberExpression)
      .filter(
        (path: $FlowFixMe) =>
          !path.node.computed &&
          path.node.property.type === 'Identifier' &&
          path.node.property.name === 'theme',
      )
      .size() > 0;
  if (readsTheme) {
    return null;
  }

  if (param.type === 'Identifier') {
    // `(p) => …p…` → rename `p` to `props`.
    reparsed
      .find(j.Identifier, { name: param.name })
      .filter(
        (path: $FlowFixMe) => !isNameOnlyPosition(path.parent.node, path.node),
      )
      .forEach((path: $FlowFixMe) => {
        path.node.name = 'props';
      });
  } else {
    // `({size, color: c}) => …` → each local name → `props.<propName>`. Refuse
    // anything but plain shorthand/renamed properties (rest, defaults, nesting,
    // computed keys) — those aren't simple prop reads.
    const bindings: Array<[string, string]> = [];
    for (const prop of param.properties) {
      if (
        (prop.type !== 'Property' && prop.type !== 'ObjectProperty') ||
        prop.computed ||
        prop.key.type !== 'Identifier' ||
        prop.value.type !== 'Identifier'
      ) {
        return null;
      }
      bindings.push([prop.value.name, prop.key.name]);
    }
    for (const [localName, propName] of bindings) {
      reparsed
        .find(j.Identifier, { name: localName })
        .filter(
          (path: $FlowFixMe) =>
            !isNameOnlyPosition(path.parent.node, path.node),
        )
        .replaceWith(() =>
          j.memberExpression(j.identifier('props'), j.identifier(propName)),
        );
    }
  }
  return reparsed.find(j.ExpressionStatement).paths()[0].node.expression;
}

// Replaces each template interpolation with its props-expression; null if any
// interpolation isn't a convertible prop-arrow.
function substituteInterpolations(
  j: $FlowFixMe,
  quasi: $FlowFixMe,
): $FlowFixMe | null {
  const expressions = [];
  for (const expr of quasi.expressions) {
    const substituted = propArrowToExpr(j, expr);
    if (substituted == null) {
      return null;
    }
    expressions.push(substituted);
  }
  return { ...quasi, expressions };
}

/** The css object for a convertible host styled def, or null. */
function convertibleCss(
  j: $FlowFixMe,
  init: $FlowFixMe,
  styled: string,
): { +baseTag: string, +objectNode: $FlowFixMe } | null {
  // styled.tag`…` / styled('tag')`…`  — static, or with prop-arrow
  // interpolations (`${p => p.color}`, M15b) substituted to props-expressions.
  if (init.type === 'TaggedTemplateExpression') {
    const baseTag = hostTagOf(j, init.tag, styled);
    if (baseTag == null) {
      return null;
    }
    const quasi =
      init.quasi.expressions.length === 0
        ? init.quasi
        : substituteInterpolations(j, init.quasi);
    if (quasi == null) {
      return null;
    }
    const objectNode = cssTemplateToObjectAst(j, quasi);
    return objectNode == null ? null : { baseTag, objectNode };
  }
  // styled.tag({…}) / styled('tag')({…})  (static object only). Object-form
  // *dynamics* stay flagged: Emotion's object form doesn't apply per-value
  // functions the way template interpolation does (render-gate confirmed), so
  // converting them would change behavior.
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

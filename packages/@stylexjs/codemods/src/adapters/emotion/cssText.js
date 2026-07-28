/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Lowers a `` css`…` `` template literal into the same ObjectExpression the
 * object-syntax reader already understands — so the whole downstream pipeline
 * (read → flip → referee → normalize → emit → gates) is reused unchanged. A
 * real CSS parser (postcss) parses the text; we only map its nodes onto object
 * properties.
 *
 * Interpolations (M10b): each `${expr}` is replaced by a unique placeholder
 * before parsing. When a placeholder is the WHOLE value of a declaration, the
 * original expression node is placed as that property's value — and the
 * reader's own dynamic-value path (M8) takes it from there (a prop/variable
 * becomes a function-form param; a literal stays static). Any interpolation
 * that is NOT a whole declaration value (embedded in a value like `${x}px`, or
 * in a selector / property name / on its own) makes us bail loudly: return
 * `null`, and the caller flags the site rather than guessing.
 *
 * Also bails on `!important`, an unknown node, or a parse error.
 */

// $FlowFixMe[cannot-resolve-module] - postcss has no flow libdef here
import postcss from 'postcss';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PLACEHOLDER_EXACT = /^__STYLEX_INTERP_(\d+)__$/;
const PLACEHOLDER_ANY = /__STYLEX_INTERP_\d+__/;

function placeholderFor(index: number): string {
  return `__STYLEX_INTERP_${index}__`;
}

/** `background-color` -> `backgroundColor`; custom properties (`--x`) and
 * already-camel names pass through. */
function camelProp(prop: string): string {
  if (prop.startsWith('--')) {
    return prop;
  }
  return prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function keyAst(j: $FlowFixMe, key: string): $FlowFixMe {
  return IDENTIFIER.test(key) ? j.identifier(key) : j.literal(key);
}

function quasiText(quasi: $FlowFixMe): string {
  return quasi?.value?.cooked ?? quasi?.value?.raw ?? '';
}

/** Rebuilds the CSS text from a template's quasis, inserting a placeholder for
 * each interpolation. */
function reconstruct(quasis: $ReadOnlyArray<$FlowFixMe>): string {
  let text = quasiText(quasis[0]);
  for (let i = 1; i < quasis.length; i++) {
    text += placeholderFor(i - 1) + quasiText(quasis[i]);
  }
  return text;
}

/** Builds an ObjectExpression from a list of postcss nodes, or null if any
 * node can't be safely represented. Whole-value placeholders resolve back to
 * their original expression node (recorded in `consumed`). */
function nodesToObject(
  j: $FlowFixMe,
  nodes: $ReadOnlyArray<$FlowFixMe>,
  expressions: $ReadOnlyArray<$FlowFixMe>,
  consumed: Set<number>,
): $FlowFixMe | null {
  const properties: Array<$FlowFixMe> = [];
  for (const node of nodes) {
    if (node.type === 'comment') {
      continue;
    }
    if (node.type === 'decl') {
      // `!important`, or a placeholder in the property name, is not convertible.
      if (node.important === true || PLACEHOLDER_ANY.test(node.prop)) {
        return null;
      }
      const value = String(node.value).trim();
      const match = PLACEHOLDER_EXACT.exec(value);
      let valueAst;
      if (match != null) {
        // A whole-value interpolation → the original expression node; the
        // reader's M8 path decides dynamic-vs-static from there.
        const index = Number(match[1]);
        consumed.add(index);
        valueAst = expressions[index];
      } else if (PLACEHOLDER_ANY.test(value)) {
        // Interpolation embedded in a larger value (`${x}px`, `calc(${x})`) —
        // deferred.
        return null;
      } else {
        valueAst = j.literal(node.value);
      }
      properties.push(
        j.property('init', keyAst(j, camelProp(node.prop)), valueAst),
      );
    } else if (node.type === 'rule') {
      if (PLACEHOLDER_ANY.test(node.selector)) {
        return null;
      }
      const nested = nodesToObject(j, node.nodes ?? [], expressions, consumed);
      if (nested == null) {
        return null;
      }
      properties.push(j.property('init', j.literal(node.selector), nested));
    } else if (node.type === 'atrule') {
      if (PLACEHOLDER_ANY.test(`${node.name}${String(node.params)}`)) {
        return null;
      }
      const nested = nodesToObject(j, node.nodes ?? [], expressions, consumed);
      if (nested == null) {
        return null;
      }
      const rule = `@${node.name} ${String(node.params)}`.trim();
      properties.push(j.property('init', j.literal(rule), nested));
    } else {
      return null;
    }
  }
  return j.objectExpression(properties);
}

/**
 * Parses a `` css`…` `` template literal's `quasi` (a TemplateLiteral node)
 * into an ObjectExpression AST, or returns null when it can't be parsed or
 * mapped (→ the caller flags the site). Every interpolation must land as a
 * whole declaration value; otherwise we bail.
 */
export function cssTemplateToObjectAst(
  j: $FlowFixMe,
  quasi: $FlowFixMe,
): $FlowFixMe | null {
  const expressions: $ReadOnlyArray<$FlowFixMe> = quasi.expressions ?? [];
  let root;
  try {
    root = postcss.parse(reconstruct(quasi.quasis ?? []));
  } catch {
    return null;
  }
  const consumed = new Set<number>();
  const object = nodesToObject(j, root.nodes ?? [], expressions, consumed);
  if (object == null || object.properties.length === 0) {
    return null;
  }
  // Every interpolation must have been consumed as a whole declaration value.
  // A leftover means a part-value / selector / statement interpolation we defer.
  if (consumed.size !== expressions.length) {
    return null;
  }
  return object;
}

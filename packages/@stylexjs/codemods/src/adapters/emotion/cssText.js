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
 * original expression node is placed as that property's value. When one is
 * EMBEDDED in a value (`${x}px`, `calc(${a} + ${b})`), the value is rebuilt as
 * a template literal splicing the original expression nodes back in. Either way
 * the reader's dynamic-value path (M8) takes it from there — the expression is
 * lifted to a function-form `create` param and moved to the call site verbatim,
 * preserving Emotion's exact runtime value. A placeholder in a selector /
 * property name / at-rule / on its own still bails loudly (return `null`, the
 * caller flags the site) — those aren't values we can lift.
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

/** Rebuilds a declaration value that embeds interpolation placeholders (`${x}px`
 * → the value string `__STYLEX_INTERP_0__px`) into a template literal that
 * splices the original expression nodes back in (`` `${expr0}px` ``). Each
 * placeholder's index is recorded in `consumed`. The result is a single
 * expression the reader lifts as one dynamic value. */
function valueToTemplateAst(
  j: $FlowFixMe,
  value: string,
  expressions: $ReadOnlyArray<$FlowFixMe>,
  consumed: Set<number>,
): $FlowFixMe {
  const quasiStrs: Array<string> = [];
  const exprs: Array<$FlowFixMe> = [];
  const re = /__STYLEX_INTERP_(\d+)__/g;
  let last = 0;
  let m: $FlowFixMe = re.exec(value);
  while (m != null) {
    quasiStrs.push(value.slice(last, m.index));
    const index = Number(m[1]);
    consumed.add(index);
    exprs.push(expressions[index]);
    last = m.index + m[0].length;
    m = re.exec(value);
  }
  quasiStrs.push(value.slice(last));
  const quasis = quasiStrs.map((s, i) =>
    j.templateElement({ raw: s, cooked: s }, i === quasiStrs.length - 1),
  );
  return j.templateLiteral(quasis, exprs);
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
        // Interpolation(s) embedded in a larger value (`${x}px`, `calc(${a} +
        // ${b})`) → rebuild the value as a template literal that splices the
        // original expression nodes back in; the reader lifts it as a dynamic
        // value (a template literal is a permitted dynamic type), preserving the
        // exact runtime string Emotion would produce.
        valueAst = valueToTemplateAst(j, value, expressions, consumed);
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

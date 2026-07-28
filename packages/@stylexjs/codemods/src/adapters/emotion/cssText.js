/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Lowers the CSS *text* inside a static `` css`…` `` template literal into the
 * same ObjectExpression the object-syntax reader already understands — so the
 * whole downstream pipeline (read → flip → referee → emit → gates) is reused
 * unchanged. A real CSS parser (postcss) does the parsing; we only map its
 * nodes onto object properties.
 *
 * Bail loudly: anything we can't map cleanly (an `!important`, an unknown node,
 * a parse error) returns `null`, and the caller flags the site rather than
 * guessing. M10a handles static text only; interpolations are the caller's job.
 */

// $FlowFixMe[cannot-resolve-module] - postcss has no flow libdef here
import postcss from 'postcss';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

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

/** Builds an ObjectExpression from a list of postcss nodes, or null if any
 * node can't be safely represented. */
function nodesToObject(
  j: $FlowFixMe,
  nodes: $ReadOnlyArray<$FlowFixMe>,
): $FlowFixMe | null {
  const properties: Array<$FlowFixMe> = [];
  for (const node of nodes) {
    if (node.type === 'comment') {
      continue;
    }
    if (node.type === 'decl') {
      // `!important` is flagged, not converted. (Multi-word values such as
      // `margin: 8px 16px` are fine — the downstream normalizer expands them.)
      if (node.important === true) {
        return null;
      }
      properties.push(
        j.property(
          'init',
          keyAst(j, camelProp(node.prop)),
          j.literal(node.value),
        ),
      );
    } else if (node.type === 'rule') {
      const nested = nodesToObject(j, node.nodes ?? []);
      if (nested == null) {
        return null;
      }
      // Keep the selector verbatim (e.g. `&:hover`, `::before`); the reader
      // strips the leading `&` and validates it as a self-targeting condition.
      properties.push(j.property('init', j.literal(node.selector), nested));
    } else if (node.type === 'atrule') {
      const nested = nodesToObject(j, node.nodes ?? []);
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
 * Parses static CSS text into an ObjectExpression AST, or returns null when it
 * can't be parsed or mapped (→ the caller flags the site).
 */
export function cssTextToObjectAst(
  j: $FlowFixMe,
  cssText: string,
): $FlowFixMe | null {
  let root;
  try {
    root = postcss.parse(cssText);
  } catch {
    return null;
  }
  const object = nodesToObject(j, root.nodes ?? []);
  if (object == null || object.properties.length === 0) {
    return null;
  }
  return object;
}

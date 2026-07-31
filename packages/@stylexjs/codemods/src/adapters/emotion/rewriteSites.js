/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * L8 — Rewrite. Consumes the binding map (the second seam hand-off) and
 * swaps each Emotion css prop for `{...stylex.props(styles.key)}` in that
 * site's place. For a dynamic (function-form) rule, the style reference is
 * called with the captured source expressions: `{...stylex.props(styles.key(
 * expr1, expr2))}`.
 *
 * When the element also carries an explicit `className`/`style` (no spread —
 * that stays flagged), those attributes are removed and merged into EXPLICIT
 * `className`/`style` (NOT a spread — StyleX's `no-conflicting-props` rule
 * forbids mixing `{...stylex.props()}` with a `className`/`style` sibling):
 * `className={[stylex.props(styles.key).className, <existing>].filter(Boolean)
 * .join(' ')}` and `style={{ ...stylex.props(styles.key).style, ...<existing> }}`
 * — the same merge shape the M15a styled wrapper uses, render-gate verified. A
 * `style` is emitted only when the rule is dynamic (it can carry CSS-var inline
 * styles) or the element already had one; a static site produces only a class.
 */

import type { StyleSite } from './detect';

/** Prints an expression node to a source string (throwaway wrapper). */
function printNode(j: $FlowFixMe, node: $FlowFixMe): string {
  return j(j.expressionStatement(node))
    .toSource({ quote: 'single' })
    .replace(/;\s*$/, '');
}

/** Parses `<x ATTRS />` and returns its JSX attribute nodes (fresh, cycle-free
 * nodes safe to splice into the real opening element). */
function parseJsxAttrs(j: $FlowFixMe, attrsSrc: string): Array<$FlowFixMe> {
  const parsed = j(`const __ = <x ${attrsSrc} />;`);
  const opening = parsed.find(j.JSXOpeningElement).paths()[0].node;
  return opening.attributes ?? [];
}

export function rewriteSite(
  j: $FlowFixMe,
  site: StyleSite,
  stylesLocalName: string,
  key: string,
  args?: $ReadOnlyArray<$FlowFixMe>,
): void {
  const member = j.memberExpression(
    j.identifier(stylesLocalName),
    j.identifier(key),
  );
  const styleRef =
    args != null && args.length > 0
      ? j.callExpression(member, [...args])
      : member;

  const merge = site.kind === 'convertible' ? (site.merge ?? null) : null;
  if (merge != null) {
    const isDynamic = args != null && args.length > 0;
    const styleRefSrc = printNode(j, styleRef);
    const cn = `stylex.props(${styleRefSrc}).className`;
    // className is always explicit (it applies the StyleX class); merge with the
    // existing one when present.
    const classNameSrc =
      merge.classNameValue != null
        ? `className={[${cn}, ${printNode(j, merge.classNameValue)}]` +
          '.filter(Boolean).join(\' \')}'
        : `className={${cn}}`;
    const parts: Array<string> = [classNameSrc];
    // style is needed only when the rule is dynamic (CSS-var inline styles) or
    // the element already had a `style`; a static rule emits only a class.
    if (isDynamic || merge.styleValue != null) {
      const sxStyle = `stylex.props(${styleRefSrc}).style`;
      let userStyle = '';
      if (merge.styleValue != null) {
        if (merge.styleValue.type === 'ObjectExpression') {
          // Inline an object literal's properties (`style={{ ...sx, k: v }}`)
          // rather than spreading it (`...{ k: v }`). printNode wraps an object
          // expression in parens (`({ … })`), so peel those before the braces.
          let s = printNode(j, merge.styleValue).trim();
          if (s.startsWith('(') && s.endsWith(')')) {
            s = s.slice(1, -1).trim();
          }
          const inner = s.replace(/^\{/, '').replace(/\}$/, '').trim();
          userStyle = inner !== '' ? `, ${inner}` : '';
        } else {
          userStyle = `, ...${printNode(j, merge.styleValue)}`;
        }
      }
      parts.push(`style={{ ...${sxStyle}${userStyle} }}`);
    }
    const newAttrs = parseJsxAttrs(j, parts.join(' '));

    // Splice into the opening element: replace the css attr with the merged
    // attrs, and drop the now-folded className/style attributes.
    const opening = site.attrPath.parent.node;
    const cssAttr = site.attrPath.node;
    const dropped: Set<$FlowFixMe> = new Set(merge.removeAttrs);
    const rebuilt: Array<$FlowFixMe> = [];
    for (const attr of opening.attributes ?? []) {
      if (attr === cssAttr) {
        rebuilt.push(...newAttrs);
      } else if (!dropped.has(attr)) {
        rebuilt.push(attr);
      }
    }
    opening.attributes = rebuilt;
    return;
  }

  const spread = j.jsxSpreadAttribute(
    j.callExpression(
      j.memberExpression(j.identifier('stylex'), j.identifier('props')),
      [styleRef],
    ),
  );
  j(site.attrPath).replaceWith(spread);
}

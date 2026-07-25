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
 */

import type { StyleSite } from './detect';

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
  const spread = j.jsxSpreadAttribute(
    j.callExpression(
      j.memberExpression(j.identifier('stylex'), j.identifier('props')),
      [styleRef],
    ),
  );
  j(site.attrPath).replaceWith(spread);
}

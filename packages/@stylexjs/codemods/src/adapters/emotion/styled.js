/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * M11a — `styled()` per-site flagging. Rather than refusing a whole file just
 * because it imports `@emotion/styled`, we flag each `styled()` definition in
 * place with a `// TODO(stylex-migration): styled() component` marker, so the
 * file's convertible css props / `` css`…` `` still migrate. Converting the
 * `styled()` component itself is a later slice.
 */

import { formatTodo, isTodoMarker, REASONS } from '../../core/todos';

/**
 * Flags every top-level statement that references the `styled` import with a
 * leading TODO marker (deduped per statement, with a re-run guard). Returns one
 * reason string per newly-flagged statement.
 */
export function flagStyledUsages(
  j: $FlowFixMe,
  root: $FlowFixMe,
  styledLocalName: string,
): Array<string> {
  const reasons: Array<string> = [];
  const flagged: Set<$FlowFixMe> = new Set();

  root
    .find(j.Identifier, { name: styledLocalName })
    .forEach((path: $FlowFixMe) => {
      const parentType = path.parent?.node?.type;
      // Skip the import specifier itself.
      if (
        parentType === 'ImportDefaultSpecifier' ||
        parentType === 'ImportSpecifier'
      ) {
        return;
      }
      // Walk up to the top-level (Program child) statement.
      let stmtPath = path;
      while (
        stmtPath.parent != null &&
        stmtPath.parent.node.type !== 'Program'
      ) {
        stmtPath = stmtPath.parent;
      }
      const stmt = stmtPath.node;
      if (stmt == null || flagged.has(stmt)) {
        return;
      }
      flagged.add(stmt);
      // Re-run guard: an already-flagged statement is left alone.
      if (
        (stmt.comments ?? []).some((c: $FlowFixMe) => isTodoMarker(c.value))
      ) {
        return;
      }
      stmt.comments = [
        ...(stmt.comments ?? []),
        {
          type: 'CommentBlock',
          value: formatTodo(REASONS.styledComponent),
          leading: true,
          trailing: false,
        },
      ];
      reasons.push(REASONS.styledComponent);
    });

  return reasons;
}

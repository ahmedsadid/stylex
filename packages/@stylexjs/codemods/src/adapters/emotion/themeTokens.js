/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * M13 theme → `defineVars` tokens (config-driven, ADR-0005). Emotion reads a
 * runtime theme (`const theme = useTheme(); … theme.space.md`); StyleX references
 * a compile-time `defineVars` token (`vars.spaceMd`). This module:
 *
 *   - finds the theme binding(s) `const theme = useTheme()`,
 *   - builds a resolver that turns a `theme.<path>` member expression into a
 *     `{ object: <varsName>, property: <token> }` reference,
 *   - names tokens by a camelCase-flatten convention (`theme.tokens.content` →
 *     `tokensContent`),
 *   - and emits a NAME-ONLY skeleton `defineVars` module (values are the human's
 *     job — the codemod never guesses a runtime value).
 *
 * The token value is external, so it is a TRUSTED substitution: omitted from the
 * semantic-diff, verified structurally + by the render gate (ADR-0001/0005).
 */

export type ThemeToken = { +object: string, +property: string };

/** `['tokens','content','primary']` → `'tokensContentPrimary'`. */
export function tokenName(pathParts: $ReadOnlyArray<string>): string {
  return pathParts
    .map((part, i) =>
      i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join('');
}

/** Binding names introduced by `const <x> = useTheme()`. */
export function detectThemeBindings(
  j: $FlowFixMe,
  root: $FlowFixMe,
  useThemeLocalName: string,
): Set<string> {
  const names: Set<string> = new Set();
  root.find(j.VariableDeclarator).forEach((path: $FlowFixMe) => {
    const { id, init } = path.node;
    if (
      id.type === 'Identifier' &&
      init != null &&
      init.type === 'CallExpression' &&
      init.callee.type === 'Identifier' &&
      init.callee.name === useThemeLocalName &&
      init.arguments.length === 0
    ) {
      names.add(id.name);
    }
  });
  return names;
}

/**
 * A resolver for `read.js`: a `theme.<path>` member expression rooted at a theme
 * binding → its token reference; anything else → null (left to flag / other
 * handling).
 */
export function makeThemeResolver(
  bindings: Set<string>,
  varsName: string,
): (node: $FlowFixMe) => ThemeToken | null {
  return (node: $FlowFixMe): ThemeToken | null => {
    const pathParts: Array<string> = [];
    let cur: $FlowFixMe = node;
    while (
      cur != null &&
      cur.type === 'MemberExpression' &&
      !cur.computed &&
      cur.property.type === 'Identifier'
    ) {
      pathParts.unshift(cur.property.name);
      cur = cur.object;
    }
    if (
      cur == null ||
      cur.type !== 'Identifier' ||
      !bindings.has(cur.name) ||
      pathParts.length === 0
    ) {
      return null;
    }
    return { object: varsName, property: tokenName(pathParts) };
  };
}

/**
 * The styled counterpart (M13b): after M15b renames an interpolation arrow's
 * param to the wrapper's `props`, a theme read becomes `props.theme.<path>`.
 * This resolves that to a token, so it's emitted as a static `vars.<token>` in
 * the create rather than a (non-existent) `props.theme` runtime read.
 */
export function makeStyledThemeResolver(
  varsName: string,
): (node: $FlowFixMe) => ThemeToken | null {
  return (node: $FlowFixMe): ThemeToken | null => {
    const parts: Array<string> = [];
    let cur: $FlowFixMe = node;
    while (
      cur != null &&
      cur.type === 'MemberExpression' &&
      !cur.computed &&
      cur.property.type === 'Identifier'
    ) {
      parts.unshift(cur.property.name);
      cur = cur.object;
    }
    // `props.theme.<path>`: root Identifier `props`, first part `theme`, ≥1 more.
    if (
      cur == null ||
      cur.type !== 'Identifier' ||
      cur.name !== 'props' ||
      parts[0] !== 'theme' ||
      parts.length < 2
    ) {
      return null;
    }
    return { object: varsName, property: tokenName(parts.slice(1)) };
  };
}

/**
 * After theme reads convert, drops a now-unused `const <x> = useTheme()` and the
 * `useTheme` import when nothing references them anymore (conservative: keeps
 * either if still referenced — e.g. an unconverted theme read).
 */
export function dropUnusedThemeBindings(
  j: $FlowFixMe,
  root: $FlowFixMe,
  useThemeLocalName: string,
): void {
  const stillReferenced = (name: string): boolean =>
    root
      .find(j.Identifier, { name })
      .filter((path: $FlowFixMe) => {
        const parent = path.parent.node;
        // Not its own binding id, import specifier, or a member-access property.
        if (parent.type === 'VariableDeclarator' && parent.id === path.node) {
          return false;
        }
        if (
          parent.type === 'ImportSpecifier' ||
          parent.type === 'ImportDefaultSpecifier'
        ) {
          return false;
        }
        if (
          parent.type === 'MemberExpression' &&
          parent.property === path.node &&
          !parent.computed
        ) {
          return false;
        }
        return true;
      })
      .size() > 0;

  root.find(j.VariableDeclaration).forEach((path: $FlowFixMe) => {
    if (path.node.declarations.length !== 1) {
      return;
    }
    const decl = path.node.declarations[0];
    if (
      decl.id.type === 'Identifier' &&
      decl.init != null &&
      decl.init.type === 'CallExpression' &&
      decl.init.callee.type === 'Identifier' &&
      decl.init.callee.name === useThemeLocalName &&
      !stillReferenced(decl.id.name)
    ) {
      j(path).remove();
    }
  });

  if (!stillReferenced(useThemeLocalName)) {
    root.find(j.ImportDeclaration).forEach((path: $FlowFixMe) => {
      if (String(path.node.source.value) !== '@emotion/react') {
        return;
      }
      const remaining = (path.node.specifiers ?? []).filter(
        (s: $FlowFixMe) =>
          !(
            s.type === 'ImportSpecifier' &&
            s.imported.name === useThemeLocalName
          ),
      );
      if (remaining.length > 0) {
        path.node.specifiers = remaining;
      } else {
        j(path).remove();
      }
    });
  }
}

/**
 * The skeleton `defineVars` module: the token NAMES the codemod saw, with `TODO`
 * placeholder values (compilable `initial`, so the output and the gates
 * resolve) for the migration team to fill in — including light/dark.
 */
export function buildSkeleton(
  varsName: string,
  tokens: $ReadOnlyArray<string>,
): string {
  const unique = [...new Set(tokens)].sort();
  const body = unique
    .map(
      (token) => `  // TODO: real value (light/dark)\n  ${token}: 'initial',`,
    )
    .join('\n');
  return (
    "import * as stylex from '@stylexjs/stylex';\n\n" +
    '// GENERATED SKELETON (stylex-migration, M13). These are the theme tokens\n' +
    '// the codemod referenced; fill in each real value (and light/dark via\n' +
    '// stylex.createTheme) before shipping. The codemod never guesses values.\n' +
    `export const ${varsName} = stylex.defineVars({\n${body}\n});\n`
  );
}

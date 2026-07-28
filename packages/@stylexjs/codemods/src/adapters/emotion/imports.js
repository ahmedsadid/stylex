/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Emotion wiring: how a file opts into the css prop. Recognizes both the
 * modern `@jsxImportSource @emotion/react` pragma (with a named `css` import)
 * and the classic `@jsx jsx` runtime (`import { jsx } from '@emotion/react'`).
 * Any other *runtime* `@emotion/*` surface (class-based `@emotion/css`, Global,
 * ThemeProvider) is still a blocker: we skip the whole file rather than
 * half-migrate it. Two exceptions are non-blocking and left in place:
 * `@emotion/styled` (flagged per-site, M11a) and *type-only* `@emotion/react`
 * imports (`import type { Theme }`, M12) — pure TS annotations emit no CSS. The
 * classic pragma and `jsx` import are LEFT IN PLACE on conversion (see
 * `EmotionWiring.hasClassicJsx`).
 */

const PRAGMA_PATTERN = /@jsxImportSource\s+@emotion\/react/;
// Classic css-prop runtime: `@jsx <factory>`. The required space after `@jsx`
// keeps it from matching `@jsxImportSource` / `@jsxRuntime`.
const CLASSIC_JSX_PRAGMA = /@jsx\s+([A-Za-z_$][\w$]*)/;

export type EmotionWiring = {
  +hasPragma: boolean,
  // Classic `/** @jsx jsx */` + `import { jsx } from '@emotion/react'`. Left in
  // place on conversion: removing the classic pragma reverts JSX to the
  // project's default runtime (often `React.createElement`, needing a React
  // import we can't guarantee is present). Emotion's jsx factory handles plain
  // JSX identically, so the file keeps working with only a thin residual.
  +hasClassicJsx: boolean,
  +cssLocalName: string | null,
  +keyframesLocalName: string | null,
  // Local name of the default `@emotion/styled` import, if any. NOT a
  // whole-file blocker (M11a): its `styled()` definitions are flagged per-site
  // so co-located css props still convert.
  +styledLocalName: string | null,
  +blockers: Array<string>,
};

// Named @emotion/react imports the adapter knows how to convert.
const CONVERTIBLE_IMPORTS = new Set(['css', 'keyframes']);

export function analyzeEmotionWiring(
  j: $FlowFixMe,
  root: $FlowFixMe,
): EmotionWiring {
  let cssLocalName: string | null = null;
  let keyframesLocalName: string | null = null;
  let jsxLocalName: string | null = null;
  let styledLocalName: string | null = null;
  const blockers: Array<string> = [];

  root.find(j.ImportDeclaration).forEach((path: $FlowFixMe) => {
    const source = String(path.node.source.value);
    if (!source.startsWith('@emotion/')) {
      return;
    }
    if (source === '@emotion/styled') {
      // M11a: NOT a whole-file blocker. Capture the default import so the
      // `styled()` definitions can be flagged per-site while the file's css
      // props still convert.
      const def = (path.node.specifiers ?? []).find(
        (s: $FlowFixMe) => s.type === 'ImportDefaultSpecifier',
      );
      if (def != null) {
        styledLocalName = def.local.name;
      }
      return;
    }
    if (source !== '@emotion/react') {
      blockers.push(`import from '${source}' is not convertible yet`);
      return;
    }
    for (const specifier of path.node.specifiers ?? []) {
      // Type-only imports (`import type { Theme }` or an inline `type Theme`
      // specifier) are pure TypeScript annotations — they emit no runtime CSS,
      // so they never block conversion (M12). Left in place, untouched.
      if (path.node.importKind === 'type' || specifier.importKind === 'type') {
        continue;
      }
      const imported =
        specifier.type === 'ImportSpecifier' ? specifier.imported.name : null;
      if (imported === 'css') {
        cssLocalName = specifier.local.name;
      } else if (imported === 'keyframes') {
        keyframesLocalName = specifier.local.name;
      } else if (imported === 'jsx') {
        // The classic css-prop runtime factory: captured (not a blocker) and
        // left in place; the `@jsx` pragma below confirms the file uses it.
        jsxLocalName = specifier.local.name;
      } else {
        blockers.push(
          `'@emotion/react' import of '${
            imported ?? specifier.local?.name ?? '?'
          }' is not convertible yet`,
        );
      }
    }
  });

  const comments = allCommentValues(j, root);
  const hasClassicJsx =
    jsxLocalName != null &&
    comments.some((value) => {
      const match = CLASSIC_JSX_PRAGMA.exec(value);
      return match != null && match[1] === jsxLocalName;
    });

  return {
    hasPragma: comments.some((value) => PRAGMA_PATTERN.test(value)),
    hasClassicJsx,
    cssLocalName,
    keyframesLocalName,
    styledLocalName,
    blockers,
  };
}

// The pragma can attach to the program or to whichever top-level statement
// leads the file — and that statement's index shifts once we insert the stylex
// import. Scanning every top-level statement finds it regardless of position.
function allCommentSlots(j: $FlowFixMe, root: $FlowFixMe): Array<$FlowFixMe> {
  const program = root.get().node.program;
  return [program, ...program.body];
}

/** Every comment value attached to the program or a top-level statement. */
function allCommentValues(j: $FlowFixMe, root: $FlowFixMe): Array<string> {
  const values: Array<string> = [];
  for (const slot of allCommentSlots(j, root)) {
    for (const comment of slot.comments ?? []) {
      values.push(comment.value);
    }
  }
  return values;
}

/**
 * Removes the `@jsxImportSource @emotion/react` pragma — but only when no
 * `css` prop remains (a flagged, still-Emotion site needs the pragma).
 */
export function removePragma(j: $FlowFixMe, root: $FlowFixMe): void {
  if (root.find(j.JSXAttribute, { name: { name: 'css' } }).size() > 0) {
    return;
  }
  for (const slot of allCommentSlots(j, root)) {
    if (slot.comments != null) {
      slot.comments = slot.comments.filter(
        (comment: $FlowFixMe) => !PRAGMA_PATTERN.test(comment.value),
      );
    }
  }
}

/**
 * Whether an identifier name is still referenced AS A VALUE — not as its own
 * import specifier, a member-access property (`stylex.keyframes`), or an
 * object key. Without those exclusions the newly-emitted `stylex.keyframes`
 * property would be mistaken for a use of the Emotion `keyframes` import.
 */
function isStillReferenced(
  j: $FlowFixMe,
  root: $FlowFixMe,
  name: string,
): boolean {
  return (
    root
      .find(j.Identifier, { name })
      .filter((path: $FlowFixMe) => {
        const parent = path.parent.node;
        if (parent.type === 'ImportSpecifier') {
          return false;
        }
        if (
          parent.type === 'MemberExpression' &&
          parent.property === path.node &&
          !parent.computed
        ) {
          return false;
        }
        if (
          (parent.type === 'Property' || parent.type === 'ObjectProperty') &&
          parent.key === path.node &&
          !parent.computed
        ) {
          return false;
        }
        return true;
      })
      .size() > 0
  );
}

/**
 * Removes the converted specifiers (`css`, `keyframes`) from the
 * `@emotion/react` import — but only those whose local name is no longer
 * referenced (a flagged tagged-template still using `css` keeps it). Drops the
 * whole declaration when nothing remains, transplanting any non-pragma
 * comments onto the next statement so file headers survive.
 */
export function removeCssImport(j: $FlowFixMe, root: $FlowFixMe): void {
  root.find(j.ImportDeclaration).forEach((path: $FlowFixMe) => {
    if (String(path.node.source.value) !== '@emotion/react') {
      return;
    }
    const remaining = (path.node.specifiers ?? []).filter(
      (specifier: $FlowFixMe) =>
        !(
          specifier.type === 'ImportSpecifier' &&
          CONVERTIBLE_IMPORTS.has(specifier.imported.name) &&
          !isStillReferenced(j, root, specifier.local.name)
        ),
    );
    if (remaining.length > 0) {
      path.node.specifiers = remaining;
      return;
    }
    const comments = (path.node.comments ?? []).filter(
      (comment: $FlowFixMe) =>
        comment.leading === true && !PRAGMA_PATTERN.test(comment.value),
    );
    const next = path.parent.node.body[path.name + 1];
    if (comments.length > 0 && next != null) {
      next.comments = [...comments, ...(next.comments ?? [])];
    }
    j(path).remove();
  });
}

/**
 * Removes a module-level `const X = css({...})` / `const X = css`...`` whose
 * binding is no longer referenced (its `css={X}` sites were rewritten to
 * `stylex.props`). Conservative: keeps the const if `X` still appears anywhere
 * outside its own declaration (e.g. a flagged site, or any non-css use).
 */
export function removeUnusedCssConsts(
  j: $FlowFixMe,
  root: $FlowFixMe,
  cssLocalName: string | null,
): void {
  if (cssLocalName == null) {
    return;
  }
  root.find(j.VariableDeclaration).forEach((path: $FlowFixMe) => {
    if (
      path.parent.node.type !== 'Program' ||
      path.node.declarations.length !== 1
    ) {
      return;
    }
    const decl = path.node.declarations[0];
    if (decl.id.type !== 'Identifier') {
      return;
    }
    const init = decl.init;
    const isCssInit =
      init != null &&
      ((init.type === 'CallExpression' &&
        init.callee?.type === 'Identifier' &&
        init.callee.name === cssLocalName) ||
        (init.type === 'TaggedTemplateExpression' &&
          init.tag?.type === 'Identifier' &&
          init.tag.name === cssLocalName));
    if (!isCssInit) {
      return;
    }
    // Count real value-uses of the binding: exclude its own declaration id, a
    // member-access property (`styles.box`, since the emitted key may share the
    // name), and an object key — mirroring `isStillReferenced`.
    const stillUsed = root
      .find(j.Identifier, { name: decl.id.name })
      .filter((p: $FlowFixMe) => {
        if (p.node === decl.id) {
          return false;
        }
        const parent = p.parent.node;
        if (
          parent.type === 'MemberExpression' &&
          parent.property === p.node &&
          !parent.computed
        ) {
          return false;
        }
        if (
          (parent.type === 'Property' || parent.type === 'ObjectProperty') &&
          parent.key === p.node &&
          !parent.computed
        ) {
          return false;
        }
        return true;
      })
      .size();
    if (stillUsed === 0) {
      j(path).remove();
    }
  });
}

/**
 * Inserts `import * as stylex from '@stylexjs/stylex';` after the last
 * import. Detection of a pre-existing StyleX import is a blocker upstream
 * (registry merge lands in M4), so this never duplicates.
 */
export function insertStylexImport(j: $FlowFixMe, root: $FlowFixMe): void {
  const declaration = j.importDeclaration(
    [j.importNamespaceSpecifier(j.identifier('stylex'))],
    j.literal('@stylexjs/stylex'),
  );
  const imports = root.find(j.ImportDeclaration);
  if (imports.size() > 0) {
    j(imports.paths()[imports.size() - 1]).insertAfter(declaration);
  } else {
    root.get().node.program.body.unshift(declaration);
  }
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * L2 — Detect. Finds every Emotion style site in the file and everything
 * that makes the file unconvertible. M1 policy (user-ratified): a file is
 * converted only if EVERY style site is convertible; a single blocker
 * skips the whole file untouched.
 *
 * Convertible site forms:
 *   <div css={{ ... }} />          — object literal
 *   <div css={css({ ... })} />     — inline `css()` call around an object
 *   <div css={css`...`} />         — template literal (M10; interpolations →
 *                                    dynamic values, else flagged)
 * on host (lowercase) elements with no `className`/`style`/spread props.
 */

import { REASONS } from '../../core/todos';
import { cssTemplateToObjectAst } from './cssText';

/** A css site that also carries an explicit `className` and/or `style` sibling
 * (but NO spread — spread ordering isn't statically verifiable). The rewriter
 * removes those attributes and merges them with `stylex.props(...)`. */
export type MergeInfo = {
  +classNameValue: $FlowFixMe | null, // expression for existing className, or null
  +styleValue: $FlowFixMe | null, // expression for existing style, or null
  +removeAttrs: $ReadOnlyArray<$FlowFixMe>, // JSXAttribute nodes to drop
};

export type ConvertibleSite = {
  +kind: 'convertible',
  +attrPath: $FlowFixMe, // JSXAttribute path
  +objectNode: $FlowFixMe, // the style ObjectExpression
  +tagName: string,
  +merge?: MergeInfo | null,
};
export type FlaggedSite = {
  +kind: 'flagged',
  +attrPath: $FlowFixMe,
  +tagName: string,
  +reason: string,
};
export type StyleSite = ConvertibleSite | FlaggedSite;

export type Detection = {
  +sites: Array<StyleSite>,
  +blockers: Array<string>,
};

/**
 * Resolves `css={x}` to a module-level `const x = css({...})` or
 * `const x = css`...`` initializer, returning the style ObjectExpression (or a
 * synthesized one for the template form), or null. Only resolves when exactly
 * ONE declarator in the file has that name — so a shadowing local can't be
 * mistaken for the module const.
 */
function resolveCssConst(
  j: $FlowFixMe,
  root: $FlowFixMe,
  name: string,
  cssLocalName: string,
): $FlowFixMe | null {
  const declarators = root.find(j.VariableDeclarator, {
    id: { type: 'Identifier', name },
  });
  if (declarators.size() !== 1) {
    return null; // absent, or shadowed — don't guess
  }
  const declaratorPath = declarators.paths()[0];
  // module-level only: VariableDeclarator -> VariableDeclaration -> Program
  if (declaratorPath.parent?.parent?.node?.type !== 'Program') {
    return null;
  }
  const init = declaratorPath.node.init;
  if (init == null) {
    return null;
  }
  if (
    init.type === 'CallExpression' &&
    init.callee.type === 'Identifier' &&
    init.callee.name === cssLocalName &&
    init.arguments.length === 1 &&
    init.arguments[0].type === 'ObjectExpression'
  ) {
    return init.arguments[0];
  }
  if (
    init.type === 'TaggedTemplateExpression' &&
    init.tag.type === 'Identifier' &&
    init.tag.name === cssLocalName
  ) {
    return cssTemplateToObjectAst(j, init.quasi);
  }
  return null;
}

/** The value expression of a JSX attribute (`className={x}` → `x`,
 * `className="a"` → the string literal), or null when absent/empty. */
function attrValueExpr(attr: $FlowFixMe): $FlowFixMe | null {
  if (attr == null || attr.value == null) {
    return null;
  }
  if (attr.value.type === 'JSXExpressionContainer') {
    return attr.value.expression?.type === 'JSXEmptyExpression'
      ? null
      : attr.value.expression;
  }
  return attr.value; // StringLiteral / Literal
}

/**
 * Classifies every `css` prop as convertible (a static object) or flagged
 * (with a reason). M5: a flagged site no longer skips the file — it gets a
 * `// TODO(stylex-migration): …` marker while the rest of the file converts.
 */
export function detectSites(
  j: $FlowFixMe,
  root: $FlowFixMe,
  cssLocalName: string | null,
): Detection {
  const sites: Array<StyleSite> = [];
  const blockers: Array<string> = [];

  root
    .find(j.JSXAttribute, { name: { name: 'css' } })
    .forEach((path: $FlowFixMe) => {
      const opening = path.parent.node;
      const nameNode = opening.name;
      const tagName = String(nameNode.name ?? '?');
      const flag = (reason: string) =>
        sites.push({ kind: 'flagged', attrPath: path, tagName, reason });

      if (nameNode.type !== 'JSXIdentifier' || !/^[a-z]/.test(tagName)) {
        flag(REASONS.componentElement);
        return;
      }
      const attrs = opening.attributes ?? [];
      // A spread mixed with css can't be merged safely — its position decides
      // whether it overrides `className`/`style`, and that's not statically
      // verifiable. Flag it. An explicit `className`/`style` (no spread) IS
      // mergeable: the rewriter drops those attributes and folds them into
      // `stylex.props(...)`.
      if (attrs.some((a: $FlowFixMe) => a.type === 'JSXSpreadAttribute')) {
        flag(REASONS.propConflict);
        return;
      }
      const classNameAttr = attrs.find(
        (a: $FlowFixMe) =>
          a.type === 'JSXAttribute' && a.name?.name === 'className',
      );
      const styleAttr = attrs.find(
        (a: $FlowFixMe) =>
          a.type === 'JSXAttribute' && a.name?.name === 'style',
      );
      const classNameValue = attrValueExpr(classNameAttr);
      const styleValue = attrValueExpr(styleAttr);
      // A valueless `className`/`style` (`<div className … />`) is malformed for
      // our purposes — flag rather than guess.
      if (
        (classNameAttr != null && classNameValue == null) ||
        (styleAttr != null && styleValue == null)
      ) {
        flag(REASONS.propConflict);
        return;
      }
      const merge: MergeInfo | null =
        classNameAttr != null || styleAttr != null
          ? {
              classNameValue,
              styleValue,
              removeAttrs: [classNameAttr, styleAttr].filter(Boolean),
            }
          : null;
      const convertible = (objectNode: $FlowFixMe) =>
        sites.push({
          kind: 'convertible',
          attrPath: path,
          objectNode,
          tagName,
          merge,
        });

      const container = path.node.value;
      if (container?.type !== 'JSXExpressionContainer') {
        flag('css prop is not an expression');
        return;
      }
      const expression = container.expression;
      if (expression.type === 'ObjectExpression') {
        convertible(expression);
        return;
      }
      if (
        expression.type === 'CallExpression' &&
        expression.callee.type === 'Identifier' &&
        cssLocalName != null &&
        expression.callee.name === cssLocalName &&
        expression.arguments.length === 1 &&
        expression.arguments[0].type === 'ObjectExpression'
      ) {
        convertible(expression.arguments[0]);
        return;
      }
      // `css`…`` — lower the template into the same object shape (M10). A
      // whole-value interpolation becomes a dynamic value; anything the parser
      // can't map cleanly returns null and falls through to the flag below.
      if (
        expression.type === 'TaggedTemplateExpression' &&
        expression.tag.type === 'Identifier' &&
        cssLocalName != null &&
        expression.tag.name === cssLocalName
      ) {
        const objectNode = cssTemplateToObjectAst(j, expression.quasi);
        if (objectNode != null) {
          convertible(objectNode);
          return;
        }
      }
      // `css={x}` where `x` is a module-level `const x = css({...})` or
      // `const x = css`...`` — resolve the referenced style (M10c). The now-
      // unused const is pruned after the sites are rewritten.
      if (expression.type === 'Identifier' && cssLocalName != null) {
        const objectNode = resolveCssConst(
          j,
          root,
          expression.name,
          cssLocalName,
        );
        if (objectNode != null) {
          convertible(objectNode);
          return;
        }
      }
      flag(
        expression.type === 'TaggedTemplateExpression'
          ? REASONS.templateLiteral
          : REASONS.dynamicValue,
      );
    });

  return { sites, blockers };
}

export type ExistingRegistry = {
  +objectNode: $FlowFixMe, // the ObjectExpression passed to stylex.create
  +varName: string, // the `const <varName> = stylex.create(...)` binding
  +keys: $ReadOnlySet<string>, // existing style-name keys
};

export type RegistryDetection = {
  +registry: ExistingRegistry | null,
  +stylexImported: boolean,
  +blockers: Array<string>,
};

/**
 * Finds a pre-existing `import * as stylex` + `const X = stylex.create({...})`
 * so new styles can be MERGED into it (M4) rather than the file being refused.
 * Anything non-standard (stylex imported by a name other than a namespace,
 * ≥2 creates, a non-object/non-const create) is a blocker.
 */
export function detectExistingRegistry(
  j: $FlowFixMe,
  root: $FlowFixMe,
): RegistryDetection {
  const blockers: Array<string> = [];

  const stylexImport = root
    .find(j.ImportDeclaration)
    .filter(
      (path: $FlowFixMe) =>
        String(path.node.source.value) === '@stylexjs/stylex',
    );
  if (stylexImport.size() === 0) {
    return { registry: null, stylexImported: false, blockers };
  }

  const specifiers = stylexImport.paths()[0].node.specifiers ?? [];
  const namespace = specifiers.find(
    (s: $FlowFixMe) => s.type === 'ImportNamespaceSpecifier',
  );
  if (specifiers.length !== 1 || namespace == null) {
    blockers.push(
      'file imports @stylexjs/stylex in a non-namespace form (merge needs `import * as stylex`)',
    );
    return { registry: null, stylexImported: true, blockers };
  }
  const stylexLocal = namespace.local.name;

  const registries: Array<ExistingRegistry> = [];
  root
    .find(j.CallExpression)
    .filter(
      (path: $FlowFixMe) =>
        path.node.callee.type === 'MemberExpression' &&
        path.node.callee.object.type === 'Identifier' &&
        path.node.callee.object.name === stylexLocal &&
        path.node.callee.property.name === 'create',
    )
    .forEach((path: $FlowFixMe) => {
      const declarator = path.parent.node;
      const arg = path.node.arguments[0];
      if (
        declarator.type !== 'VariableDeclarator' ||
        declarator.id.type !== 'Identifier' ||
        arg?.type !== 'ObjectExpression'
      ) {
        blockers.push(
          'pre-existing stylex.create is not a simple const object',
        );
        return;
      }
      const keys = new Set<string>();
      for (const prop of arg.properties) {
        if (prop.key?.type === 'Identifier') {
          keys.add(prop.key.name);
        } else if (
          prop.key?.type === 'Literal' ||
          prop.key?.type === 'StringLiteral'
        ) {
          keys.add(String(prop.key.value));
        }
      }
      registries.push({ objectNode: arg, varName: declarator.id.name, keys });
    });

  if (registries.length > 1) {
    blockers.push('file has ≥2 stylex.create registries (merge targets one)');
    return { registry: null, stylexImported: true, blockers };
  }

  return {
    registry: registries[0] ?? null,
    stylexImported: true,
    blockers,
  };
}

export type KeyframesSite = {
  +callPath: $FlowFixMe, // CallExpression path (keyframes({...}))
  +objectNode: $FlowFixMe, // the frames ObjectExpression
  +varName: string, // the `const <varName> = keyframes(...)` binding
};

export type KeyframesDetection = {
  +sites: Array<KeyframesSite>,
  +names: Set<string>,
  +blockers: Array<string>,
};

/**
 * Finds `const NAME = keyframes({ ... })` declarations. Only the object form
 * bound to a simple `const` is convertible; anything else (tagged template,
 * inline, reassignment) is a blocker.
 */
export function detectKeyframes(
  j: $FlowFixMe,
  root: $FlowFixMe,
  keyframesLocalName: string | null,
): KeyframesDetection {
  const sites: Array<KeyframesSite> = [];
  const names: Set<string> = new Set();
  const blockers: Array<string> = [];
  if (keyframesLocalName == null) {
    return { sites, names, blockers };
  }

  const siteCallees = new Set<$FlowFixMe>();
  root
    .find(j.CallExpression)
    .filter(
      (path: $FlowFixMe) =>
        path.node.callee.type === 'Identifier' &&
        path.node.callee.name === keyframesLocalName,
    )
    .forEach((path: $FlowFixMe) => {
      const declarator = path.parent.node;
      const isSimpleConstBinding =
        declarator.type === 'VariableDeclarator' &&
        declarator.init === path.node &&
        declarator.id.type === 'Identifier';
      const arg = path.node.arguments[0];
      if (
        !isSimpleConstBinding ||
        path.node.arguments.length !== 1 ||
        arg.type !== 'ObjectExpression'
      ) {
        blockers.push(
          'keyframes() must be an object bound to a const to convert ' +
            '(tagged-template or inline keyframes land later)',
        );
        return;
      }
      siteCallees.add(path.node.callee);
      names.add(declarator.id.name);
      sites.push({
        callPath: path,
        objectNode: arg,
        varName: declarator.id.name,
      });
    });

  // Any other use of the keyframes identifier (not a convertible call, not
  // the import) means we cannot fully remove it — refuse.
  root
    .find(j.Identifier, { name: keyframesLocalName })
    .forEach((path: $FlowFixMe) => {
      const parentNode = path.parent.node;
      if (
        parentNode.type === 'ImportSpecifier' ||
        siteCallees.has(path.node) ||
        (parentNode.type === 'Property' && parentNode.key === path.node)
      ) {
        return;
      }
      blockers.push(
        `'${keyframesLocalName}' is used in an unsupported position`,
      );
    });

  return { sites, names, blockers };
}

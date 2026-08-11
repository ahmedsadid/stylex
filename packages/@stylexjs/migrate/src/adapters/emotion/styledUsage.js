/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { createFact } from '../../inventory/model';
import type { Fact } from '../../inventory/model';

type Path = {
  +node: $FlowFixMe,
  +parent: $FlowFixMe,
  +key: string | null,
  +insideTemplate: boolean,
};

const SKIPPED_KEYS = new Set([
  'loc',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'comments',
  'tokens',
  'extra',
]);

function walkPaths(ast: $FlowFixMe, visit: (path: Path) => void): void {
  const stack = [{ node: ast, parent: null, key: null, insideTemplate: false }];
  while (stack.length > 0) {
    const path = stack.pop();
    if (path == null) continue;
    const { node } = path;
    if (node == null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index--) {
        stack.push({
          node: node[index],
          parent: path.parent,
          key: path.key,
          insideTemplate: path.insideTemplate,
        });
      }
      continue;
    }
    const nodeType: string = String(node.type ?? '');
    if (nodeType !== '') visit(path);
    const insideTemplate =
      path.insideTemplate || nodeType === 'TaggedTemplateExpression';
    const keys = Object.keys(node);
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index];
      if (SKIPPED_KEYS.has(key)) continue;
      stack.push({
        node: node[key],
        parent: node,
        key,
        insideTemplate,
      });
    }
  }
}

function patternIdentifiers(pattern: $FlowFixMe): $ReadOnlyArray<$FlowFixMe> {
  if (pattern == null) return [];
  if (pattern.type === 'Identifier') return [pattern];
  if (pattern.type === 'RestElement') {
    return patternIdentifiers(pattern.argument);
  }
  if (pattern.type === 'AssignmentPattern') {
    return patternIdentifiers(pattern.left);
  }
  if (pattern.type === 'ObjectPattern') {
    return (pattern.properties ?? []).flatMap((item) =>
      item?.type === 'ObjectProperty'
        ? patternIdentifiers(item.value)
        : patternIdentifiers(item),
    );
  }
  if (pattern.type === 'ArrayPattern') {
    return (pattern.elements ?? []).flatMap(patternIdentifiers);
  }
  return [];
}

function bindingIdentifiers(node: $FlowFixMe): $ReadOnlyArray<$FlowFixMe> {
  if (node.type === 'VariableDeclarator') return patternIdentifiers(node.id);
  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'ObjectMethod' ||
    node.type === 'ClassMethod'
  ) {
    return [
      ...(node.id?.type === 'Identifier' ? [node.id] : []),
      ...(node.params ?? []).flatMap(patternIdentifiers),
    ];
  }
  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    return node.id?.type === 'Identifier' ? [node.id] : [];
  }
  if (node.type === 'CatchClause') return patternIdentifiers(node.param);
  if (
    node.type === 'ImportSpecifier' ||
    node.type === 'ImportDefaultSpecifier' ||
    node.type === 'ImportNamespaceSpecifier'
  ) {
    return node.local?.type === 'Identifier' ? [node.local] : [];
  }
  return [];
}

function isTopLevelDefinition(
  ast: $FlowFixMe,
  name: string,
  initStart: number,
): boolean {
  for (const statement of ast.program?.body ?? []) {
    const declaration =
      statement.type === 'ExportNamedDeclaration'
        ? statement.declaration
        : statement;
    if (declaration?.type !== 'VariableDeclaration') continue;
    for (const item of declaration.declarations ?? []) {
      if (
        item.id?.type === 'Identifier' &&
        item.id.name === name &&
        item.init?.start === initStart
      ) {
        return true;
      }
    }
  }
  return false;
}

function directJsxConsumer(
  node: $FlowFixMe,
  parent: $FlowFixMe,
  name: string,
): $FlowFixMe | null {
  if (
    node.type !== 'JSXOpeningElement' ||
    node.name?.type !== 'JSXIdentifier' ||
    node.name.name !== name
  ) {
    return null;
  }
  const attributeNames = [];
  let spread = false;
  for (const attribute of node.attributes ?? []) {
    if (attribute.type === 'JSXSpreadAttribute') {
      spread = true;
      continue;
    }
    if (attribute.name?.type === 'JSXIdentifier') {
      attributeNames.push(String(attribute.name.name));
    } else {
      attributeNames.push('(namespaced)');
    }
  }
  const closing =
    parent?.type === 'JSXElement' &&
    parent.closingElement?.name?.type === 'JSXIdentifier' &&
    parent.closingElement.name.name === name
      ? parent.closingElement.name
      : null;
  return Object.freeze({
    span: Object.freeze({ start: node.start, end: node.end }),
    openingName: Object.freeze({
      start: node.name.start,
      end: node.name.end,
    }),
    closingName:
      closing == null
        ? null
        : Object.freeze({ start: closing.start, end: closing.end }),
    attributes: Object.freeze([...new Set(attributeNames)].sort()),
    spread,
  });
}

function jsxMemberRoot(node: $FlowFixMe): $FlowFixMe {
  let current = node;
  while (current?.type === 'JSXMemberExpression') current = current.object;
  return current;
}

function nonReferenceIdentifier(path: Path): boolean {
  const { parent, key } = path;
  if (parent == null) return false;
  if (
    (parent.type === 'MemberExpression' ||
      parent.type === 'OptionalMemberExpression') &&
    key === 'property' &&
    parent.computed !== true
  ) {
    return true;
  }
  if (
    (parent.type === 'ObjectProperty' ||
      parent.type === 'ObjectMethod' ||
      parent.type === 'ClassMethod' ||
      parent.type === 'ClassProperty' ||
      parent.type === 'TSPropertySignature') &&
    key === 'key' &&
    parent.computed !== true &&
    parent.shorthand !== true
  ) {
    return true;
  }
  if (
    (parent.type === 'LabeledStatement' ||
      parent.type === 'BreakStatement' ||
      parent.type === 'ContinueStatement') &&
    key === 'label'
  ) {
    return true;
  }
  if (parent.type === 'ExportSpecifier' && key === 'exported') return true;
  return false;
}

function escapeKind(path: Path): string {
  const { parent, key, insideTemplate } = path;
  if (parent?.type === 'ExportSpecifier' && key === 'local') return 'export';
  if (
    (parent?.type === 'MemberExpression' ||
      parent?.type === 'OptionalMemberExpression') &&
    key === 'object'
  ) {
    return 'static-member';
  }
  if (insideTemplate) return 'template-reference';
  if (String(parent?.type ?? '').startsWith('TS')) return 'type-reference';
  if (parent?.type === 'TypeofTypeAnnotation') return 'type-reference';
  return 'value-escape';
}

function blockedReasons(
  definition: $FlowFixMe,
  topLevel: boolean,
  shadowed: boolean,
  consumers: $ReadOnlyArray<$FlowFixMe>,
  escapes: $ReadOnlyArray<$FlowFixMe>,
): $ReadOnlyArray<string> {
  const reasons = [];
  if (!topLevel) reasons.push('definition-not-top-level');
  if (definition.exported === true) reasons.push('exported-definition');
  if (definition.targetKind !== 'intrinsic') {
    reasons.push('non-intrinsic-target');
  }
  if (
    definition.syntax !== 'tagged-template' ||
    definition.templateExpressions !== 0
  ) {
    reasons.push('open-or-unsupported-style-form');
  }
  if (
    definition.callback === true ||
    definition.themeDependent === true ||
    definition.propDependent === true
  ) {
    reasons.push('runtime-style-input');
  }
  if (definition.hasOptions === true) reasons.push('styled-options');
  if (shadowed) reasons.push('shadowed-binding');
  if (consumers.length === 0) reasons.push('no-direct-jsx-consumers');
  if (escapes.length > 0) reasons.push('binding-escapes');
  if (consumers.some((consumer) => consumer.spread === true)) {
    reasons.push('jsx-spread');
  }
  const riskyAttributes = new Set(['as', 'className', 'css', 'style']);
  if (
    consumers.some((consumer) =>
      consumer.attributes.some((name) => riskyAttributes.has(name)),
    )
  ) {
    reasons.push('jsx-style-or-polymorphic-prop');
  }
  return Object.freeze([...new Set(reasons)].sort());
}

/**
 * Build same-file component-boundary facts for every styled definition.
 *
 * These facts still authorize no edit. They establish the minimum complete
 * graph needed before M10B may promote a closed intrinsic definition into an
 * atomic definition-plus-consumer migration site.
 */
export function discoverStyledUsageFacts({
  ast,
  file,
  readinessFacts,
}: {
  +ast: $FlowFixMe,
  +file: string,
  +readinessFacts: $ReadOnlyArray<Fact>,
}): $ReadOnlyArray<Fact> {
  const definitions = readinessFacts.filter(
    (fact) => fact.kind === 'emotion-styled-readiness',
  );
  if (definitions.length === 0) return Object.freeze([]);

  const names = new Set(
    definitions.map((fact) => {
      const value: $FlowFixMe = fact.value;
      return String(value.name);
    }),
  );
  const bindingSpans = new Map<string, Array<string>>();
  walkPaths(ast, ({ node }) => {
    for (const identifier of bindingIdentifiers(node)) {
      const name = String(identifier.name);
      if (!names.has(name)) continue;
      const spans = bindingSpans.get(name) ?? [];
      spans.push(`${identifier.start}:${identifier.end}`);
      bindingSpans.set(name, spans);
    }
  });

  return Object.freeze(
    definitions
      .map((readinessFact) => {
        const definition: $FlowFixMe = readinessFact.value;
        const name = String(definition.name);
        const consumers = [];
        const escapes: Array<{
          +kind: string,
          +span: { +start: number, +end: number },
        }> = [];
        const bindingSpanSet = new Set(bindingSpans.get(name) ?? []);
        walkPaths(ast, (path) => {
          const consumer = directJsxConsumer(path.node, path.parent, name);
          if (consumer != null) consumers.push(consumer);
          if (
            path.node.type === 'JSXOpeningElement' &&
            path.node.name?.type === 'JSXMemberExpression'
          ) {
            const root = jsxMemberRoot(path.node.name);
            if (root?.type === 'JSXIdentifier' && root.name === name) {
              escapes.push(
                Object.freeze({
                  kind: 'jsx-member',
                  span: Object.freeze({ start: root.start, end: root.end }),
                }),
              );
            }
          }
          if (
            path.node.type !== 'Identifier' ||
            path.node.name !== name ||
            bindingSpanSet.has(`${path.node.start}:${path.node.end}`) ||
            nonReferenceIdentifier(path)
          ) {
            return;
          }
          escapes.push(
            Object.freeze({
              kind: escapeKind(path),
              span: Object.freeze({
                start: path.node.start,
                end: path.node.end,
              }),
            }),
          );
        });
        const uniqueEscapes = [
          ...new Map(
            escapes.map((escape) => [
              `${escape.kind}:${escape.span.start}:${escape.span.end}`,
              escape,
            ]),
          ).values(),
        ];
        const topLevel = isTopLevelDefinition(
          ast,
          name,
          Number(definition.span?.start),
        );
        const shadowed = (bindingSpans.get(name) ?? []).length !== 1;
        const reasons = blockedReasons(
          definition,
          topLevel,
          shadowed,
          consumers,
          uniqueEscapes,
        );
        return createFact({
          kind: 'emotion-styled-usage',
          status: 'known',
          value: {
            definitionFactId: readinessFact.id,
            name,
            targetKind: definition.targetKind,
            targetName: definition.targetName,
            definitionSpan: definition.span,
            topLevel,
            shadowed,
            consumers,
            escapes: uniqueEscapes,
            firstSliceEligible: reasons.length === 0,
            blockedReasons: reasons,
          },
          provenance: [
            {
              kind: 'source',
              file,
              detail: `complete same-file usage and escape graph for ${name}`,
            },
          ],
          inputFiles: [file],
        });
      })
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

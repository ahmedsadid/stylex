/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { createFact } from '../../inventory/model';
import { walk } from '../../static/walk';
import type { Fact } from '../../inventory/model';

type DefinitionShape = {
  +name: string,
  +exported: boolean,
  +targetKind: 'intrinsic' | 'component' | 'unknown',
  +targetName: string | null,
  +syntax: 'call' | 'tagged-template',
  +styleForms: $ReadOnlyArray<string>,
  +templateExpressions: number | null,
  +callback: boolean,
  +themeDependent: boolean,
  +propDependent: boolean,
  +hasOptions: boolean,
  +hasShouldForwardProp: boolean,
  +span: { +start: number, +end: number },
};

type TargetShape = {
  +kind: 'intrinsic' | 'component' | 'unknown',
  +name: string | null,
};

const CAST_NODES = new Set([
  'TSAsExpression',
  'TSTypeAssertion',
  'TypeCastExpression',
  'TSNonNullExpression',
]);

function unwrap(node: $FlowFixMe): $FlowFixMe {
  let current = node;
  while (current != null && CAST_NODES.has(current.type)) {
    current = current.expression;
  }
  return current;
}

function patternNames(pattern: $FlowFixMe): $ReadOnlyArray<string> {
  if (pattern == null) return [];
  if (pattern.type === 'Identifier') return [String(pattern.name)];
  if (pattern.type === 'RestElement') return patternNames(pattern.argument);
  if (pattern.type === 'AssignmentPattern') return patternNames(pattern.left);
  if (pattern.type === 'ObjectPattern' || pattern.type === 'ArrayPattern') {
    return (pattern.properties ?? pattern.elements ?? []).flatMap((item) =>
      item?.type === 'ObjectProperty'
        ? patternNames(item.value)
        : patternNames(item),
    );
  }
  return [];
}

function importedStyledBindings(ast: $FlowFixMe): $ReadOnlySet<string> {
  const imported = new Set<string>();
  for (const statement of ast.program?.body ?? []) {
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.importKind === 'type' ||
      statement.source?.value !== '@emotion/styled'
    ) {
      continue;
    }
    for (const specifier of statement.specifiers ?? []) {
      if (
        (specifier.type === 'ImportDefaultSpecifier' ||
          specifier.type === 'ImportNamespaceSpecifier') &&
        specifier.importKind !== 'type' &&
        typeof specifier.local?.name === 'string'
      ) {
        imported.add(String(specifier.local.name));
      }
    }
  }
  if (imported.size === 0) return imported;

  // Scope resolution is intentionally conservative for readiness facts. If a
  // file shadows the import name anywhere, omit it rather than count a call
  // that might refer to the inner binding.
  const shadowed = new Set<string>();
  walk(ast, (node) => {
    let names: $ReadOnlyArray<string> = [];
    if (node.type === 'VariableDeclarator') names = patternNames(node.id);
    else if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'ObjectMethod' ||
      node.type === 'ClassMethod'
    ) {
      names = (node.params ?? []).flatMap(patternNames);
    } else if (node.type === 'CatchClause') names = patternNames(node.param);
    for (const name of names) {
      if (imported.has(name)) shadowed.add(name);
    }
  });
  return new Set([...imported].filter((name) => !shadowed.has(name)));
}

function propertyName(member: $FlowFixMe): string | null {
  if (member?.type !== 'MemberExpression') return null;
  if (member.computed === false && member.property?.type === 'Identifier') {
    return String(member.property.name);
  }
  if (member.computed === true && member.property?.type === 'StringLiteral') {
    return String(member.property.value);
  }
  return null;
}

function targetShape(node: $FlowFixMe): TargetShape {
  const target = unwrap(node);
  if (target?.type === 'StringLiteral') {
    return { kind: 'intrinsic', name: String(target.value) };
  }
  if (target?.type === 'Identifier') {
    return { kind: 'component', name: String(target.name) };
  }
  if (target?.type === 'MemberExpression') {
    const property = propertyName(target);
    return { kind: 'component', name: property };
  }
  return { kind: 'unknown', name: null };
}

function styleForm(node: $FlowFixMe): string {
  const value = unwrap(node);
  if (value?.type === 'ObjectExpression') return 'object';
  if (
    value?.type === 'ArrowFunctionExpression' ||
    value?.type === 'FunctionExpression'
  ) {
    return 'callback';
  }
  if (value?.type === 'TemplateLiteral') return 'template';
  if (value?.type === 'Identifier') return 'identifier';
  return String(value?.type ?? 'unknown');
}

type CallbackSignals = {
  +callback: boolean,
  +themeDependent: boolean,
  +propDependent: boolean,
};

function callbackSignalsForRoot(root: $FlowFixMe): CallbackSignals {
  let callback = false;
  let themeDependent = false;
  let propDependent = false;
  walk(root, (node) => {
    if (
      node.type !== 'ArrowFunctionExpression' &&
      node.type !== 'FunctionExpression'
    ) {
      return;
    }
    callback = true;
    for (const parameter of node.params ?? []) {
      const value =
        parameter.type === 'AssignmentPattern' ? parameter.left : parameter;
      if (value?.type === 'ObjectPattern') {
        const names = patternNames(value);
        if (names.includes('theme')) themeDependent = true;
        if (names.some((name) => name !== 'theme')) propDependent = true;
        continue;
      }
      if (value?.type !== 'Identifier') {
        propDependent = true;
        continue;
      }
      const parameterName = String(value.name);
      let sawTheme = false;
      let sawOther = false;
      walk(node.body, (child) => {
        if (
          child.type !== 'MemberExpression' ||
          child.object?.type !== 'Identifier' ||
          child.object.name !== parameterName
        ) {
          return;
        }
        if (propertyName(child) === 'theme') sawTheme = true;
        else sawOther = true;
      });
      if (parameterName === 'theme' || sawTheme) themeDependent = true;
      if (parameterName !== 'theme' && (sawOther || !sawTheme)) {
        propDependent = true;
      }
    }
  });
  return Object.freeze({ callback, themeDependent, propDependent });
}

function callbackSignals(nodes: $ReadOnlyArray<$FlowFixMe>): CallbackSignals {
  let callback = false;
  let themeDependent = false;
  let propDependent = false;
  for (const root of nodes) {
    const signals = callbackSignalsForRoot(root);
    callback = callback || signals.callback;
    themeDependent = themeDependent || signals.themeDependent;
    propDependent = propDependent || signals.propDependent;
  }
  return Object.freeze({ callback, themeDependent, propDependent });
}

function hasShouldForwardProp(node: $FlowFixMe): boolean {
  let found = false;
  walk(node, (child) => {
    if (
      (child.type === 'ObjectProperty' || child.type === 'ObjectMethod') &&
      ((child.computed === false &&
        child.key?.type === 'Identifier' &&
        child.key.name === 'shouldForwardProp') ||
        (child.key?.type === 'StringLiteral' &&
          child.key.value === 'shouldForwardProp'))
    ) {
      found = true;
    }
  });
  return found;
}

function exportedNames(ast: $FlowFixMe): $ReadOnlySet<string> {
  const output = new Set<string>();
  for (const statement of ast.program?.body ?? []) {
    if (statement.type !== 'ExportNamedDeclaration') continue;
    const declaration = statement.declaration;
    if (declaration?.type === 'VariableDeclaration') {
      for (const item of declaration.declarations ?? []) {
        patternNames(item.id).forEach((name) => output.add(name));
      }
    }
    for (const specifier of statement.specifiers ?? []) {
      if (typeof specifier.local?.name === 'string') {
        output.add(String(specifier.local.name));
      }
    }
  }
  return output;
}

function definitionShape(
  init: $FlowFixMe,
  bindings: $ReadOnlySet<string>,
): Omit<DefinitionShape, 'name' | 'exported' | 'span'> | null {
  const expression = unwrap(init);
  const syntax =
    expression?.type === 'TaggedTemplateExpression'
      ? 'tagged-template'
      : expression?.type === 'CallExpression'
        ? 'call'
        : null;
  if (syntax == null) return null;

  const tagOrCallee =
    syntax === 'tagged-template' ? expression.tag : expression.callee;
  let target: TargetShape | null = null;
  let optionsNode = null;
  if (
    tagOrCallee?.type === 'MemberExpression' &&
    tagOrCallee.object?.type === 'Identifier' &&
    bindings.has(String(tagOrCallee.object.name))
  ) {
    const intrinsic = propertyName(tagOrCallee);
    target = {
      kind: intrinsic == null ? 'unknown' : 'intrinsic',
      name: intrinsic,
    };
  } else if (
    tagOrCallee?.type === 'CallExpression' &&
    tagOrCallee.callee?.type === 'Identifier' &&
    bindings.has(String(tagOrCallee.callee.name))
  ) {
    target = targetShape((tagOrCallee.arguments ?? [])[0]);
    optionsNode = (tagOrCallee.arguments ?? [])[1] ?? null;
  }
  if (target == null) return null;

  const styleNodes =
    syntax === 'tagged-template'
      ? [expression.quasi]
      : [...(expression.arguments ?? [])];
  const signals = callbackSignals(styleNodes);
  return Object.freeze({
    targetKind: target.kind,
    targetName: target.name,
    syntax,
    styleForms:
      syntax === 'tagged-template'
        ? Object.freeze(['tagged-template'])
        : Object.freeze(styleNodes.map(styleForm)),
    templateExpressions:
      syntax === 'tagged-template'
        ? (expression.quasi?.expressions ?? []).length
        : null,
    ...signals,
    hasOptions: optionsNode != null,
    hasShouldForwardProp:
      optionsNode != null && hasShouldForwardProp(optionsNode),
  });
}

export function discoverStyledReadinessFacts({
  ast,
  file,
}: {
  +ast: $FlowFixMe,
  +file: string,
}): $ReadOnlyArray<Fact> {
  const bindings = importedStyledBindings(ast);
  if (bindings.size === 0) return Object.freeze([]);
  const exports = exportedNames(ast);
  const definitions: Array<DefinitionShape> = [];
  walk(ast, (node) => {
    if (
      node.type !== 'VariableDeclarator' ||
      node.id?.type !== 'Identifier' ||
      typeof node.init?.start !== 'number' ||
      typeof node.init?.end !== 'number'
    ) {
      return;
    }
    const shape = definitionShape(node.init, bindings);
    if (shape == null) return;
    const name = String(node.id.name);
    definitions.push(
      Object.freeze({
        name,
        exported: exports.has(name),
        ...shape,
        span: Object.freeze({ start: node.init.start, end: node.init.end }),
      }),
    );
  });
  return Object.freeze(
    definitions
      .map((definition) =>
        createFact({
          kind: 'emotion-styled-readiness',
          status: 'known',
          value: definition as $FlowFixMe,
          provenance: [
            {
              kind: 'source',
              file,
              detail: `binding-backed @emotion/styled definition ${definition.name}`,
            },
          ],
          inputFiles: [file],
        }),
      )
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

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

export const STYLED_DYNAMIC_VALUE_MODEL = 'emotion-styled-dynamic-value-v1';

const SKIPPED_KEYS = new Set([
  'loc',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'comments',
  'tokens',
  'extra',
]);

function children(node: $FlowFixMe): $ReadOnlyArray<$FlowFixMe> {
  if (node == null || typeof node !== 'object') return [];
  const output = [];
  for (const key of Object.keys(node)) {
    if (SKIPPED_KEYS.has(key) || key === 'type') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null && typeof item === 'object') output.push(item);
      }
    } else if (value != null && typeof value === 'object') {
      output.push(value);
    }
  }
  return output;
}

function walkWithParent(
  root: $FlowFixMe,
  visit: (node: $FlowFixMe, parent: $FlowFixMe) => void,
): void {
  const pending = [{ node: root, parent: null }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current == null) continue;
    visit(current.node, current.parent);
    const nested = children(current.node);
    for (let index = nested.length - 1; index >= 0; index--) {
      pending.push({ node: nested[index], parent: current.node });
    }
  }
}

function outerCallbacks(root: $FlowFixMe): $ReadOnlyArray<$FlowFixMe> {
  const output = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node == null) continue;
    if (
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'FunctionExpression'
    ) {
      output.push(node);
      continue;
    }
    pending.push(...children(node));
  }
  return output.sort((left, right) => left.start - right.start);
}

function styleCallbacks(root: $FlowFixMe): $ReadOnlyArray<$FlowFixMe> {
  const styleRoots =
    root?.type === 'TaggedTemplateExpression'
      ? (root.quasi?.expressions ?? [])
      : root?.type === 'CallExpression'
        ? (root.arguments ?? [])
        : [];
  return styleRoots
    .flatMap(outerCallbacks)
    .sort((left, right) => left.start - right.start);
}

function propertyName(member: $FlowFixMe): string | null {
  if (member?.computed === false && member.property?.type === 'Identifier') {
    return String(member.property.name);
  }
  if (
    member?.computed === true &&
    (member.property?.type === 'StringLiteral' ||
      member.property?.type === 'NumericLiteral')
  ) {
    return String(member.property.value);
  }
  return null;
}

function destructuredBindings(
  pattern: $FlowFixMe,
): Map<string, $ReadOnlyArray<string>> {
  const bindings: Map<string, $ReadOnlyArray<string>> = new Map();
  if (pattern?.type !== 'ObjectPattern') return bindings;
  for (const property of pattern.properties ?? []) {
    if (property?.type !== 'ObjectProperty') continue;
    const source =
      property.key?.type === 'Identifier' ||
      property.key?.type === 'StringLiteral'
        ? String(property.key.name ?? property.key.value)
        : null;
    const value =
      property.value?.type === 'AssignmentPattern'
        ? property.value.left
        : property.value;
    if (source != null && value?.type === 'Identifier') {
      bindings.set(String(value.name), Object.freeze([source]));
    }
  }
  return bindings;
}

function memberPath(
  node: $FlowFixMe,
  rootName: string,
): $ReadOnlyArray<string> | null {
  const parts: Array<string> = [];
  let current = node;
  while (
    current?.type === 'MemberExpression' ||
    current?.type === 'OptionalMemberExpression'
  ) {
    const property = propertyName(current);
    if (property == null) return null;
    parts.unshift(property);
    current = current.object;
  }
  return current?.type === 'Identifier' && current.name === rootName
    ? Object.freeze(parts)
    : null;
}

function staticBranch(node: $FlowFixMe): boolean {
  if (node == null) return false;
  if (
    node.type === 'StringLiteral' ||
    node.type === 'NumericLiteral' ||
    node.type === 'BooleanLiteral' ||
    node.type === 'NullLiteral'
  ) {
    return true;
  }
  if (node.type === 'UnaryExpression' && node.operator === '-') {
    return node.argument?.type === 'NumericLiteral';
  }
  return false;
}

function callbackObservation(callback: $FlowFixMe): $FlowFixMe {
  const parameter = (callback.params ?? [])[0] ?? null;
  const identifierRoot =
    parameter?.type === 'Identifier' ? String(parameter.name) : null;
  const destructured = destructuredBindings(parameter);
  const propPaths = new Set<string>();
  const themePaths = new Set<string>();
  let computedAccesses = 0;
  let calls = 0;
  let constructions = 0;
  let assignments = 0;
  let updates = 0;
  let awaits = 0;
  let yields = 0;
  let conditionals = 0;
  let finiteLiteralConditionals = 0;
  let nestedFunctions = 0;

  walkWithParent(callback.body, (node, parent) => {
    if (
      (node.type === 'ArrowFunctionExpression' ||
        node.type === 'FunctionExpression') &&
      node !== callback
    ) {
      nestedFunctions++;
    }
    if (node.type === 'CallExpression') calls++;
    else if (node.type === 'NewExpression') constructions++;
    else if (node.type === 'AssignmentExpression') assignments++;
    else if (node.type === 'UpdateExpression') updates++;
    else if (node.type === 'AwaitExpression') awaits++;
    else if (node.type === 'YieldExpression') yields++;
    else if (node.type === 'ConditionalExpression') {
      conditionals++;
      if (staticBranch(node.consequent) && staticBranch(node.alternate)) {
        finiteLiteralConditionals++;
      }
    }

    if (
      node.type !== 'MemberExpression' &&
      node.type !== 'OptionalMemberExpression'
    ) {
      return;
    }
    if (
      parent != null &&
      (parent.type === 'MemberExpression' ||
        parent.type === 'OptionalMemberExpression') &&
      parent.object === node
    ) {
      return;
    }
    if (node.computed === true && propertyName(node) == null) {
      computedAccesses++;
    }
    if (identifierRoot != null) {
      const path = memberPath(node, identifierRoot);
      if (path == null || path.length === 0) return;
      if (path[0] === 'theme') themePaths.add(path.slice(1).join('.'));
      else propPaths.add(path.join('.'));
      return;
    }
    if (node.object?.type !== 'Identifier') return;
    const prefix = destructured.get(String(node.object.name));
    if (prefix == null) return;
    const suffix = memberPath(node, String(node.object.name));
    if (suffix == null) return;
    const path = [...prefix, ...suffix];
    if (path[0] === 'theme') themePaths.add(path.slice(1).join('.'));
    else propPaths.add(path.join('.'));
  });

  for (const [binding, path] of destructured) {
    if (path[0] === 'theme') continue;
    let referenced = false;
    walkWithParent(callback.body, (node) => {
      if (node.type === 'Identifier' && node.name === binding) {
        referenced = true;
      }
    });
    if (referenced) propPaths.add(path.join('.'));
  }

  return Object.freeze({
    span: Object.freeze({ start: callback.start, end: callback.end }),
    async: callback.async === true,
    parameterShape:
      parameter == null
        ? 'none'
        : parameter.type === 'Identifier'
          ? 'identifier'
          : parameter.type === 'ObjectPattern'
            ? 'object-pattern'
            : 'other',
    propPaths: Object.freeze([...propPaths].filter(Boolean).sort()),
    themePaths: Object.freeze([...themePaths].filter(Boolean).sort()),
    computedAccesses,
    calls,
    constructions,
    assignments,
    updates,
    awaits,
    yields,
    nestedFunctions,
    conditionals,
    finiteLiteralConditionals,
  });
}

function declarators(ast: $FlowFixMe): Map<string, $FlowFixMe> {
  const output: Map<string, $FlowFixMe> = new Map();
  walkWithParent(ast, (node) => {
    if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier' &&
      typeof node.init?.start === 'number'
    ) {
      output.set(
        `${String(node.id.name)}:${String(node.init.start)}`,
        node.init,
      );
    }
  });
  return output;
}

/** Record syntax observations needed before choosing a dynamic-value strategy. */
export function discoverStyledDynamicFacts({
  ast,
  file,
  readinessFacts,
  usageFacts,
}: {
  +ast: $FlowFixMe,
  +file: string,
  +readinessFacts: $ReadOnlyArray<Fact>,
  +usageFacts: $ReadOnlyArray<Fact>,
}): $ReadOnlyArray<Fact> {
  const definitions = declarators(ast);
  const usageByDefinition = new Map(
    usageFacts.map((fact) => {
      const value: $FlowFixMe = fact.value;
      return [String(value.definitionFactId), fact];
    }),
  );
  const output = [];
  for (const readinessFact of readinessFacts) {
    const definition: $FlowFixMe = readinessFact.value;
    if (definition.callback !== true || definition.propDependent !== true) {
      continue;
    }
    const root = definitions.get(
      `${String(definition.name)}:${String(definition.span?.start)}`,
    );
    if (root == null) continue;
    const usageFact = usageByDefinition.get(readinessFact.id) ?? null;
    const usage: $FlowFixMe = usageFact?.value;
    const consumers = usage?.consumers ?? [];
    output.push(
      createFact({
        kind: 'emotion-styled-dynamic-value',
        status: 'known',
        value: {
          model: STYLED_DYNAMIC_VALUE_MODEL,
          definitionFactId: readinessFact.id,
          usageFactId: usageFact?.id ?? null,
          name: definition.name,
          definitionSpan: definition.span,
          callbacks: styleCallbacks(root).map(callbackObservation),
          consumerMerge: {
            className: consumers.some((consumer) =>
              consumer.attributes.includes('className'),
            ),
            style: consumers.some((consumer) =>
              consumer.attributes.includes('style'),
            ),
            css: consumers.some((consumer) =>
              consumer.attributes.includes('css'),
            ),
            as: consumers.some((consumer) =>
              consumer.attributes.includes('as'),
            ),
            spread: consumers.some((consumer) => consumer.spread === true),
          },
          unknowns: [
            'runtime value domain beyond syntactically finite literal branches',
            'getter purity and effects behind property reads',
            'evaluation count and timing outside the observed styled callback boundary',
            'server/client and rendered merge behavior without repository evidence',
          ],
        },
        provenance: [
          {
            kind: 'source',
            file,
            detail: `dynamic styled callback syntax for ${String(definition.name)}`,
          },
        ],
        inputFiles: [file],
      }),
    );
  }
  return Object.freeze(
    output.sort((left, right) => left.id.localeCompare(right.id)),
  );
}

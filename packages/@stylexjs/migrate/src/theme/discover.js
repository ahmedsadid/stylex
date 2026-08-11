/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { createFact } from '../inventory/model';
import { discoverStyledReadinessFacts } from '../adapters/emotion/styledReadiness';
import { walk } from '../static/walk';
import type { Fact, FactStatus } from '../inventory/model';
import type { JsonValue } from '../state/json';

type ThemeBinding = {
  +name: string,
  +status: FactStatus,
  +source: 'use-theme' | 'css-callback',
  +sourcePath?: string,
};

type MemberPath = {
  +root: string,
  +segments: $ReadOnlyArray<string>,
  +cast: string | null,
  +start: number,
  +end: number,
};

type StyledThemeRead = {
  +binding: string,
  +sourcePath: string,
  +start: number,
  +end: number,
  +cast: string | null,
};

const CAST_NODES = new Set([
  'TSAsExpression',
  'TSTypeAssertion',
  'TypeCastExpression',
  'TSNonNullExpression',
]);

function propertyName(node: $FlowFixMe): string | null {
  if (node == null || typeof node !== 'object') return null;
  if (node.computed === false && node.property?.type === 'Identifier') {
    return String(node.property.name);
  }
  if (
    node.computed === true &&
    (node.property?.type === 'StringLiteral' ||
      node.property?.type === 'NumericLiteral')
  ) {
    return String(node.property.value);
  }
  return null;
}

function castName(node: $FlowFixMe): string {
  const annotation = node.typeAnnotation ?? node.typeParameters;
  if (annotation?.typeAnnotation?.type === 'GenericTypeAnnotation') {
    return String(annotation.typeAnnotation.id?.name ?? 'flow-cast');
  }
  if (annotation?.type === 'TSTypeReference') {
    return String(annotation.typeName?.name ?? 'ts-cast');
  }
  return String(annotation?.type ?? node.type);
}

function unwrap(node: $FlowFixMe): { +node: $FlowFixMe, +cast: string | null } {
  let current = node;
  let cast = null;
  while (current != null && CAST_NODES.has(current.type)) {
    cast = castName(current);
    current = current.expression;
  }
  return { node: current, cast };
}

function memberPath(input: $FlowFixMe): MemberPath | null {
  const outer = unwrap(input);
  let current = outer.node;
  const segments: Array<string> = [];
  while (
    current?.type === 'MemberExpression' ||
    current?.type === 'OptionalMemberExpression'
  ) {
    const property = propertyName(current);
    if (property == null) return null;
    segments.unshift(property);
    current = unwrap(current.object).node;
  }
  if (
    current?.type !== 'Identifier' ||
    segments.length === 0 ||
    typeof input.start !== 'number' ||
    typeof input.end !== 'number'
  ) {
    return null;
  }
  return Object.freeze({
    root: String(current.name),
    segments: Object.freeze(segments),
    cast: outer.cast,
    start: input.start,
    end: input.end,
  });
}

function styledThemeReads(
  ast: $FlowFixMe,
  file: string,
): $ReadOnlyArray<StyledThemeRead> {
  const starts = new Set(
    discoverStyledReadinessFacts({ ast, file })
      .map((item) => item.value)
      .filter(
        (value: $FlowFixMe) =>
          value.syntax === 'tagged-template' &&
          value.themeDependent === true &&
          typeof value.span?.start === 'number',
      )
      .map((value: $FlowFixMe) => Number(value.span.start)),
  );
  const output = [];
  walk(ast, (node) => {
    if (
      node.type !== 'TaggedTemplateExpression' ||
      !starts.has(Number(node.start))
    ) {
      return;
    }
    for (const expression of node.quasi?.expressions ?? []) {
      if (
        expression?.type !== 'ArrowFunctionExpression' ||
        expression.async === true ||
        expression.params?.length !== 1 ||
        expression.params[0]?.type !== 'Identifier'
      ) {
        continue;
      }
      const binding = String(expression.params[0].name);
      const candidates = [];
      walk(expression.body, (child) => {
        if (
          child.type !== 'MemberExpression' &&
          child.type !== 'OptionalMemberExpression' &&
          !CAST_NODES.has(child.type)
        ) {
          return;
        }
        const found = memberPath(child);
        if (
          found != null &&
          found.root === binding &&
          found.segments[0] === 'theme' &&
          found.segments.length > 1
        ) {
          candidates.push(found);
        }
      });
      for (const read of candidates.filter(
        (candidate) =>
          !candidates.some(
            (other) =>
              other !== candidate &&
              other.start === candidate.start &&
              other.end > candidate.end,
          ),
      )) {
        output.push(
          Object.freeze({
            binding,
            sourcePath: read.segments.slice(1).join('.'),
            start: read.start,
            end: read.end,
            cast: read.cast,
          }),
        );
      }
    }
  });
  return Object.freeze(output);
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

function importedBindings(ast: $FlowFixMe): {
  +useTheme: $ReadOnlySet<string>,
  +providers: $ReadOnlySet<string>,
} {
  const useTheme = new Set<string>();
  const providers = new Set<string>();
  for (const statement of ast.program?.body ?? []) {
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.importKind === 'type' ||
      (statement.source?.value !== '@emotion/react' &&
        statement.source?.value !== '@emotion/core')
    ) {
      continue;
    }
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported = String(
        specifier.imported?.name ?? specifier.imported?.value ?? '',
      );
      const local = String(specifier.local?.name ?? '');
      if (imported === 'useTheme') useTheme.add(local);
      if (imported === 'ThemeProvider') providers.add(local);
    }
  }
  return Object.freeze({ useTheme, providers });
}

function declarationCounts(ast: $FlowFixMe): Map<string, number> {
  const counts = new Map<string, number>();
  walk(ast, (node) => {
    let names: Array<string> = [];
    if (node.type === 'VariableDeclarator') names = [...patternNames(node.id)];
    else if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'ObjectMethod' ||
      node.type === 'ClassMethod'
    ) {
      names = [...(node.params ?? []).flatMap(patternNames)];
      if (node.id?.type === 'Identifier') names.push(String(node.id.name));
    }
    for (const name of names) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  });
  return counts;
}

function cssCallbackBindings(ast: $FlowFixMe): $ReadOnlyArray<ThemeBinding> {
  const bindings = [];
  walk(ast, (node) => {
    if (
      node.type !== 'JSXAttribute' ||
      node.name?.name !== 'css' ||
      node.value?.type !== 'JSXExpressionContainer'
    ) {
      return;
    }
    const expression = node.value.expression;
    if (
      expression?.type === 'ArrowFunctionExpression' &&
      expression.params?.[0]?.type === 'Identifier'
    ) {
      bindings.push(
        Object.freeze({
          name: String(expression.params[0].name),
          status: 'inferred',
          source: 'css-callback',
        }),
      );
    }
  });
  return Object.freeze(bindings);
}

function themeBindings(
  ast: $FlowFixMe,
  useThemeImports: $ReadOnlySet<string>,
): $ReadOnlyArray<ThemeBinding> {
  const counts = declarationCounts(ast);
  const bindings = [...cssCallbackBindings(ast)];
  walk(ast, (node) => {
    if (
      node.type !== 'VariableDeclarator' ||
      node.id?.type !== 'Identifier' ||
      node.init?.type !== 'CallExpression' ||
      node.init.callee?.type !== 'Identifier' ||
      !useThemeImports.has(String(node.init.callee.name)) ||
      (node.init.arguments ?? []).length !== 0
    ) {
      return;
    }
    const name = String(node.id.name);
    bindings.push(
      Object.freeze({
        name,
        status: counts.get(name) === 1 ? 'known' : 'inferred',
        source: 'use-theme',
      }),
    );
  });
  return Object.freeze(bindings);
}

function aliases(
  ast: $FlowFixMe,
  bindings: Map<string, ThemeBinding>,
): $ReadOnlyArray<{
  +name: string,
  +sourcePath: string,
  +status: FactStatus,
}> {
  const output: Array<{
    +name: string,
    +sourcePath: string,
    +status: FactStatus,
  }> = [];
  const declarators: Array<$FlowFixMe> = [];
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator') declarators.push(node);
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of declarators) {
      if (
        node.type !== 'VariableDeclarator' ||
        node.id?.type !== 'Identifier' ||
        bindings.has(String(node.id.name))
      ) {
        continue;
      }
      const found = memberPath(node.init);
      const root = found == null ? null : bindings.get(found.root);
      if (found == null || root == null) continue;
      const name = String(node.id.name);
      const sourcePath = [
        ...(root.sourcePath == null ? [] : root.sourcePath.split('.')),
        ...found.segments,
      ].join('.');
      const binding: $FlowFixMe = Object.freeze({
        name,
        status: root.status,
        source: root.source,
        sourcePath,
      });
      bindings.set(name, binding);
      output.push(Object.freeze({ name, sourcePath, status: binding.status }));
      changed = true;
    }
  }
  return Object.freeze(output);
}

function literalKey(property: $FlowFixMe): string | null {
  if (property?.type !== 'ObjectProperty' || property.computed === true) {
    return null;
  }
  if (property.key?.type === 'Identifier') return String(property.key.name);
  if (
    property.key?.type === 'StringLiteral' ||
    property.key?.type === 'NumericLiteral'
  ) {
    return String(property.key.value);
  }
  return null;
}

function flattenThemeObject(
  node: $FlowFixMe,
  prefix: $ReadOnlyArray<string>,
  values: { [string]: JsonValue },
  unresolved: Array<string>,
  cssVariables: Set<string>,
): void {
  if (node?.type !== 'ObjectExpression') {
    unresolved.push(prefix.join('.') || '(root)');
    return;
  }
  for (const property of node.properties ?? []) {
    const key = literalKey(property);
    if (key == null) {
      unresolved.push([...prefix, '(dynamic)'].join('.'));
      continue;
    }
    const next = [...prefix, key];
    const value = property.value;
    if (value?.type === 'ObjectExpression') {
      flattenThemeObject(value, next, values, unresolved, cssVariables);
    } else if (
      value?.type === 'StringLiteral' ||
      (value?.type === 'NumericLiteral' && Number.isFinite(value.value))
    ) {
      values[next.join('.')] = value.value;
      if (typeof value.value === 'string') {
        for (const match of value.value.matchAll(/var\((--[A-Za-z0-9_-]+)/g)) {
          cssVariables.add(match[1]);
        }
      }
    } else {
      unresolved.push(next.join('.'));
    }
  }
}

function topLevelObjects(ast: $FlowFixMe): $ReadOnlyArray<{
  +name: string,
  +node: $FlowFixMe,
  +exported: boolean,
}> {
  const output: Array<{
    +name: string,
    +node: $FlowFixMe,
    +exported: boolean,
  }> = [];
  for (const statement of ast.program?.body ?? []) {
    const exported = statement.type === 'ExportNamedDeclaration';
    const declaration = exported ? statement.declaration : statement;
    if (declaration?.type !== 'VariableDeclaration') continue;
    for (const item of declaration.declarations ?? []) {
      if (
        item.id?.type === 'Identifier' &&
        item.init?.type === 'ObjectExpression'
      ) {
        output.push(
          Object.freeze({
            name: String(item.id.name),
            node: item.init,
            exported,
          }),
        );
      }
    }
  }
  return Object.freeze(output);
}

function providerUses(
  ast: $FlowFixMe,
  providerBindings: $ReadOnlySet<string>,
): $ReadOnlyArray<{
  +providerBinding: string,
  +variant: string | null,
  +status: FactStatus,
  +start: number,
  +end: number,
}> {
  const output: Array<{
    +providerBinding: string,
    +variant: string | null,
    +status: FactStatus,
    +start: number,
    +end: number,
  }> = [];
  walk(ast, (node) => {
    if (
      node.type !== 'JSXOpeningElement' ||
      node.name?.type !== 'JSXIdentifier' ||
      !providerBindings.has(String(node.name.name))
    ) {
      return;
    }
    const theme = (node.attributes ?? []).find(
      (attribute) =>
        attribute.type === 'JSXAttribute' && attribute.name?.name === 'theme',
    );
    const expression = theme?.value?.expression;
    const variant =
      expression?.type === 'Identifier' ? String(expression.name) : null;
    const status: FactStatus = variant == null ? 'inferred' : 'known';
    output.push(
      Object.freeze({
        providerBinding: String(node.name.name),
        variant,
        status,
        start: Number(node.start ?? 0),
        end: Number(node.end ?? 0),
      }),
    );
  });
  return Object.freeze(output);
}

function fact(
  file: string,
  kind: string,
  status: FactStatus,
  value: JsonValue,
  detail: string,
): Fact {
  return createFact({
    kind,
    status,
    value,
    provenance: [{ kind: 'source', file, detail }],
    inputFiles: [file],
  });
}

export function discoverThemeFacts({
  ast,
  file,
}: {
  +ast: $FlowFixMe,
  +file: string,
}): $ReadOnlyArray<Fact> {
  const imports = importedBindings(ast);
  const foundBindings = themeBindings(ast, imports.useTheme);
  const bindingMap: Map<string, $FlowFixMe> = new Map(
    foundBindings.map((binding) => [binding.name, binding]),
  );
  const foundAliases = aliases(ast, bindingMap);
  const providers = providerUses(ast, imports.providers);
  const providerVariants = new Set(
    providers
      .map((provider) => provider.variant)
      .filter((name): name is string => name != null),
  );
  const facts = [];
  const styledReads = styledThemeReads(ast, file);

  for (const binding of foundBindings) {
    facts.push(
      fact(
        file,
        'theme-binding',
        binding.status,
        { name: binding.name, source: binding.source },
        `${binding.source} theme binding ${binding.name}`,
      ),
    );
  }
  for (const alias of foundAliases) {
    facts.push(
      fact(
        file,
        'theme-alias',
        alias.status,
        { name: alias.name, sourcePath: alias.sourcePath },
        `theme alias ${alias.name} resolves to ${alias.sourcePath}`,
      ),
    );
  }
  for (const provider of providers) {
    facts.push(
      fact(
        file,
        'theme-provider',
        provider.status,
        provider as $FlowFixMe,
        `Emotion ${provider.providerBinding} theme prop`,
      ),
    );
    if (provider.variant != null) {
      facts.push(
        fact(
          file,
          'theme-variant',
          provider.status,
          {
            name: provider.variant,
            providerSpan: { start: provider.start, end: provider.end },
          },
          `provider selects theme variant ${provider.variant}`,
        ),
      );
    }
  }

  const objects = topLevelObjects(ast);
  for (const object of objects) {
    if (!/theme/i.test(object.name) && !providerVariants.has(object.name)) {
      continue;
    }
    const values = {};
    const unresolved: Array<string> = [];
    const cssVariables = new Set<string>();
    flattenThemeObject(object.node, [], values, unresolved, cssVariables);
    const status: FactStatus = unresolved.length === 0 ? 'known' : 'inferred';
    facts.push(
      fact(
        file,
        'theme-definition',
        status,
        {
          name: object.name,
          exported: object.exported,
          values,
          unresolvedPaths: unresolved.sort(),
          existingCssVariables: [...cssVariables].sort(),
        },
        `theme-shaped object ${object.name}`,
      ),
    );
  }

  const candidates = [];
  walk(ast, (node) => {
    if (
      node.type !== 'MemberExpression' &&
      node.type !== 'OptionalMemberExpression' &&
      !CAST_NODES.has(node.type)
    ) {
      return;
    }
    const found = memberPath(node);
    if (found != null && bindingMap.has(found.root)) candidates.push(found);
  });
  const maximal = candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other !== candidate &&
          other.start === candidate.start &&
          other.end > candidate.end,
      ),
  );
  const seenReads = new Set<string>();
  for (const read of maximal.sort((a, b) => a.start - b.start)) {
    const binding: $FlowFixMe = bindingMap.get(read.root);
    const prefix =
      typeof binding.sourcePath === 'string'
        ? binding.sourcePath.split('.')
        : [];
    const sourcePath = [...prefix, ...read.segments].join('.');
    const key = `${read.start}:${read.end}:${sourcePath}`;
    if (seenReads.has(key)) continue;
    seenReads.add(key);
    facts.push(
      fact(
        file,
        'theme-read',
        binding.status,
        {
          binding: read.root,
          sourcePath,
          span: { start: read.start, end: read.end },
          cast: read.cast,
        },
        `theme read ${read.root}.${read.segments.join('.')}`,
      ),
    );
    if (read.cast != null) {
      facts.push(
        fact(
          file,
          'theme-cast',
          binding.status,
          {
            sourcePath,
            cast: read.cast,
            span: { start: read.start, end: read.end },
          },
          `theme read ${sourcePath} carries ${read.cast}`,
        ),
      );
    }
  }
  for (const read of [...styledReads].sort((a, b) => a.start - b.start)) {
    const key = `${read.start}:${read.end}:${read.sourcePath}`;
    if (seenReads.has(key)) continue;
    seenReads.add(key);
    facts.push(
      fact(
        file,
        'theme-read',
        'known',
        {
          binding: read.binding,
          sourcePath: read.sourcePath,
          span: { start: read.start, end: read.end },
          cast: read.cast,
          source: 'styled-callback',
        },
        `styled theme read ${read.binding}.theme.${read.sourcePath}`,
      ),
    );
    if (read.cast != null) {
      facts.push(
        fact(
          file,
          'theme-cast',
          'known',
          {
            sourcePath: read.sourcePath,
            cast: read.cast,
            span: { start: read.start, end: read.end },
          },
          `styled theme read ${read.sourcePath} carries ${read.cast}`,
        ),
      );
    }
  }
  return Object.freeze(facts.sort((a, b) => a.id.localeCompare(b.id)));
}

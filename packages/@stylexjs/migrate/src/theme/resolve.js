/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import fs from 'fs';
import path from 'path';
import { canonicalRoot } from '../kernel/snapshot';
import { canonicalJson } from '../state/json';
import { parseSource } from '../static/parse';
import type { ThemeValue } from './model';

const EXTENSIONS: $ReadOnlyArray<string> = [
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
];

type Known = {
  +status: 'known',
  +value: ThemeValue,
};

type Missing = { +status: 'missing' };

type Failed = {
  +status: 'resolution-failed',
  +reason: string,
};

type InternalResult = Known | Missing | Failed;

export type ThemeValueResolution =
  | {
      +status: 'known',
      +value: ThemeValue,
      +inputFiles: $ReadOnlyArray<string>,
    }
  | {
      +status: 'resolution-failed',
      +reason: string,
      +inputFiles: $ReadOnlyArray<string>,
    };

type ModuleRecord = {
  +file: string,
  +ast: $FlowFixMe,
  +bindings: Map<string, $FlowFixMe>,
  +functions: Map<string, $FlowFixMe>,
  +imports: Map<
    string,
    { +source: string, +imported: string, +namespace: boolean },
  >,
  +exports: Map<
    string,
    { +local: string, +source: string | null, +imported: string },
  >,
};

type PathMapping = {
  +pattern: string,
  +targets: $ReadOnlyArray<string>,
};

type ResolverContext = {
  +repositoryRoot: string,
  +baseUrl: string,
  +paths: $ReadOnlyArray<PathMapping>,
  +modules: Map<string, ModuleRecord | Failed>,
  +inputFiles: Set<string>,
  +active: Set<string>,
};

function object(value: mixed): boolean {
  return value != null && !Array.isArray(value) && typeof value === 'object';
}

const MISSING: Missing = Object.freeze({ status: 'missing' });

function failure(reason: string): Failed {
  return Object.freeze({ status: 'resolution-failed', reason });
}

function unwrap(node: $FlowFixMe): $FlowFixMe {
  let current = node;
  while (
    current != null &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'TypeCastExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'ParenthesizedExpression')
  ) {
    current = current.expression;
  }
  return current;
}

function jsonc(text: string): mixed {
  let output = '';
  let quoted = false;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const current = text[index];
    const next = text[index + 1];
    if (quoted) {
      output += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) quoted = false;
      continue;
    }
    if (current === '"' || current === "'") {
      quoted = true;
      quote = current;
      output += current;
      continue;
    }
    if (current === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      output += '\n';
      continue;
    }
    if (current === '/' && next === '*') {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === '*' && text[index + 1] === '/')
      ) {
        if (text[index] === '\n') output += '\n';
        index++;
      }
      index++;
      continue;
    }
    output += current;
  }
  return JSON.parse(output.replace(/,\s*([}\]])/g, '$1'));
}

function projectMappings(repositoryRoot: string): {
  +baseUrl: string,
  +paths: $ReadOnlyArray<PathMapping>,
} {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(repositoryRoot, name);
    try {
      const parsed: $FlowFixMe = jsonc(fs.readFileSync(file, 'utf8'));
      const options = parsed?.compilerOptions;
      const baseUrl = path.resolve(
        repositoryRoot,
        typeof options?.baseUrl === 'string' ? options.baseUrl : '.',
      );
      const mappings = [];
      if (options?.paths != null && typeof options.paths === 'object') {
        for (const [pattern, targets] of Object.entries(options.paths)) {
          if (
            typeof pattern === 'string' &&
            Array.isArray(targets) &&
            targets.every((target) => typeof target === 'string')
          ) {
            mappings.push(
              Object.freeze({
                pattern,
                targets: Object.freeze(targets.map(String)),
              }),
            );
          }
        }
      }
      return Object.freeze({
        baseUrl,
        paths: Object.freeze(mappings),
      });
    } catch (error) {
      if (
        error != null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        continue;
      }
      return Object.freeze({
        baseUrl: repositoryRoot,
        paths: Object.freeze([]),
      });
    }
  }
  return Object.freeze({ baseUrl: repositoryRoot, paths: Object.freeze([]) });
}

function fileCandidates(base: string): $ReadOnlyArray<string> {
  if (path.extname(base) !== '') return [base];
  return [
    ...EXTENSIONS.map((extension) => `${base}${extension}`),
    ...EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];
}

function existingFile(
  repositoryRoot: string,
  bases: $ReadOnlyArray<string>,
): string | null {
  for (const base of bases) {
    for (const candidate of fileCandidates(base)) {
      const relative = path.relative(repositoryRoot, candidate);
      if (
        path.isAbsolute(relative) ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`)
      ) {
        continue;
      }
      try {
        const stats = fs.lstatSync(candidate);
        if (stats.isFile() && !stats.isSymbolicLink()) {
          return relative.split(path.sep).join('/');
        }
      } catch (error) {
        if (
          error != null &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          continue;
        }
      }
    }
  }
  return null;
}

function wildcard(pattern: string, specifier: string): string | null {
  const index = pattern.indexOf('*');
  if (index === -1) return pattern === specifier ? '' : null;
  if (pattern.indexOf('*', index + 1) !== -1) return null;
  const prefix = pattern.slice(0, index);
  const suffix = pattern.slice(index + 1);
  return specifier.startsWith(prefix) && specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : null;
}

function resolveModule(
  context: ResolverContext,
  importer: string,
  specifier: string,
): string | null {
  if (specifier.startsWith('.')) {
    return existingFile(context.repositoryRoot, [
      path.resolve(context.repositoryRoot, path.dirname(importer), specifier),
    ]);
  }
  const bases = [];
  for (const mapping of context.paths) {
    const match = wildcard(mapping.pattern, specifier);
    if (match == null) continue;
    for (const target of mapping.targets) {
      bases.push(path.resolve(context.baseUrl, target.replace('*', match)));
    }
  }
  return existingFile(context.repositoryRoot, bases);
}

function localName(node: $FlowFixMe): string | null {
  return node?.type === 'Identifier' ? String(node.name) : null;
}

function moduleRecord(
  context: ResolverContext,
  file: string,
): ModuleRecord | Failed {
  const cached = context.modules.get(file);
  if (cached != null) return cached;
  context.inputFiles.add(file);
  let source;
  try {
    source = fs.readFileSync(path.join(context.repositoryRoot, file), 'utf8');
  } catch (error) {
    const result = failure(`could not read ${file}`);
    context.modules.set(file, result);
    return result;
  }
  const parsed = parseSource(source, file);
  if (!parsed.ok) {
    const result = failure(`${file}: ${parsed.reason}`);
    context.modules.set(file, result);
    return result;
  }
  const bindings: Map<string, $FlowFixMe> = new Map();
  const functions: Map<string, $FlowFixMe> = new Map();
  const imports: Map<
    string,
    { +source: string, +imported: string, +namespace: boolean },
  > = new Map();
  const exports: Map<
    string,
    { +local: string, +source: string | null, +imported: string },
  > = new Map();
  const record: ModuleRecord = {
    file,
    ast: parsed.ast,
    bindings,
    functions,
    imports,
    exports,
  };
  context.modules.set(file, record);

  for (const statement of parsed.ast.program?.body ?? []) {
    if (statement.type === 'ImportDeclaration') {
      if (statement.importKind === 'type') continue;
      const sourceName = String(statement.source?.value ?? '');
      for (const specifier of statement.specifiers ?? []) {
        const name = localName(specifier.local);
        if (name == null || specifier.importKind === 'type') continue;
        if (specifier.type === 'ImportNamespaceSpecifier') {
          imports.set(name, {
            source: sourceName,
            imported: '*',
            namespace: true,
          });
        } else if (specifier.type === 'ImportDefaultSpecifier') {
          imports.set(name, {
            source: sourceName,
            imported: 'default',
            namespace: false,
          });
        } else {
          imports.set(name, {
            source: sourceName,
            imported: String(
              specifier.imported?.name ?? specifier.imported?.value ?? '',
            ),
            namespace: false,
          });
        }
      }
      continue;
    }
    const exported = statement.type === 'ExportNamedDeclaration';
    const declaration = exported ? statement.declaration : statement;
    if (declaration?.type === 'VariableDeclaration') {
      for (const item of declaration.declarations ?? []) {
        const name = localName(item.id);
        if (name == null || item.init == null) continue;
        bindings.set(name, item.init);
        const init = unwrap(item.init);
        if (
          init?.type === 'ArrowFunctionExpression' ||
          init?.type === 'FunctionExpression'
        ) {
          functions.set(name, init);
        }
        if (exported) {
          exports.set(name, { local: name, source: null, imported: name });
        }
      }
    } else if (declaration?.type === 'FunctionDeclaration') {
      const name = localName(declaration.id);
      if (name != null) {
        functions.set(name, declaration);
        if (exported) {
          exports.set(name, { local: name, source: null, imported: name });
        }
      }
    }
    if (statement.type === 'ExportDefaultDeclaration') {
      const found = statement.declaration;
      if (found?.type === 'Identifier') {
        exports.set('default', {
          local: String(found.name),
          source: null,
          imported: String(found.name),
        });
      } else {
        bindings.set('__default__', found);
        exports.set('default', {
          local: '__default__',
          source: null,
          imported: '__default__',
        });
      }
    }
    if (statement.type === 'ExportNamedDeclaration') {
      const sourceName =
        typeof statement.source?.value === 'string'
          ? String(statement.source.value)
          : null;
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.exportKind === 'type') continue;
        const exportedName = String(
          specifier.exported?.name ?? specifier.exported?.value ?? '',
        );
        const imported = String(
          specifier.local?.name ?? specifier.local?.value ?? '',
        );
        exports.set(exportedName, {
          local: imported,
          source: sourceName,
          imported,
        });
      }
    }
  }
  return record;
}

function propertyName(property: $FlowFixMe): string | null {
  if (property?.computed === true) return null;
  if (property?.key?.type === 'Identifier') return String(property.key.name);
  if (
    property?.key?.type === 'StringLiteral' ||
    property?.key?.type === 'NumericLiteral'
  ) {
    return String(property.key.value);
  }
  return null;
}

function member(node: $FlowFixMe): {
  +root: $FlowFixMe,
  +segments: $ReadOnlyArray<string>,
} | null {
  let current = unwrap(node);
  const segments: Array<string> = [];
  while (
    current?.type === 'MemberExpression' ||
    current?.type === 'OptionalMemberExpression'
  ) {
    let name = null;
    if (!current.computed && current.property?.type === 'Identifier') {
      name = String(current.property.name);
    } else if (
      current.computed &&
      (current.property?.type === 'StringLiteral' ||
        current.property?.type === 'NumericLiteral')
    ) {
      name = String(current.property.value);
    }
    if (name == null || current.optional === true) return null;
    segments.unshift(name);
    current = unwrap(current.object);
  }
  return Object.freeze({ root: current, segments: Object.freeze(segments) });
}

function functionReturn(node: $FlowFixMe): $FlowFixMe | null {
  if (
    (node.params ?? []).length !== 0 ||
    node.async === true ||
    node.generator === true
  ) {
    return null;
  }
  if (node.body?.type !== 'BlockStatement') return node.body;
  const body = node.body.body ?? [];
  return body.length === 1 && body[0]?.type === 'ReturnStatement'
    ? body[0].argument
    : null;
}

function resolveExport(
  context: ResolverContext,
  file: string,
  exportName: string,
  segments: $ReadOnlyArray<string>,
): InternalResult {
  const record = moduleRecord(context, file);
  if ('status' in record) return record;
  const found = record.exports.get(exportName);
  if (found == null) return MISSING;
  if (found.source == null) {
    return resolveBinding(context, record, found.local, segments);
  }
  const source = found.source;
  const target = resolveModule(context, file, source);
  return target == null
    ? failure(`${file}: could not resolve ${source}`)
    : resolveExport(context, target, found.imported, segments);
}

function resolveBinding(
  context: ResolverContext,
  record: ModuleRecord,
  name: string,
  segments: $ReadOnlyArray<string>,
): InternalResult {
  const key = `${record.file}:${name}:${segments.join('.')}`;
  if (context.active.has(key)) return failure(`theme value cycle at ${key}`);
  context.active.add(key);
  try {
    const imported = record.imports.get(name);
    if (imported != null) {
      const target = resolveModule(context, record.file, imported.source);
      if (target == null) {
        return failure(`${record.file}: could not resolve ${imported.source}`);
      }
      if (imported.namespace) {
        if (segments.length === 0) return MISSING;
        return resolveExport(context, target, segments[0], segments.slice(1));
      }
      return resolveExport(context, target, imported.imported, segments);
    }
    const expression = record.bindings.get(name);
    return expression == null
      ? MISSING
      : resolveExpression(context, record, expression, segments);
  } finally {
    context.active.delete(key);
  }
}

function resolveObject(
  context: ResolverContext,
  record: ModuleRecord,
  object: $FlowFixMe,
  segments: $ReadOnlyArray<string>,
): InternalResult {
  if (segments.length === 0) return MISSING;
  const [head, ...tail] = segments;
  for (const property of [...(object.properties ?? [])].reverse()) {
    if (property.type === 'ObjectProperty') {
      const name = propertyName(property);
      if (name === head) {
        return resolveExpression(context, record, property.value, tail);
      }
      if (name == null) {
        return failure(
          `${record.file}: computed theme property may override ${head}`,
        );
      }
      continue;
    }
    if (property.type === 'SpreadElement') {
      const result = resolveExpression(
        context,
        record,
        property.argument,
        segments,
      );
      if (result.status !== 'missing') return result;
      continue;
    }
    return failure(
      `${record.file}: unsupported theme object member ${String(property.type)}`,
    );
  }
  return MISSING;
}

function resolveExpression(
  context: ResolverContext,
  record: ModuleRecord,
  input: $FlowFixMe,
  segments: $ReadOnlyArray<string>,
): InternalResult {
  const node = unwrap(input);
  if (node == null) return MISSING;
  if (node.type === 'ObjectExpression') {
    return resolveObject(context, record, node, segments);
  }
  if (node.type === 'Identifier') {
    return resolveBinding(context, record, String(node.name), segments);
  }
  if (
    node.type === 'MemberExpression' ||
    node.type === 'OptionalMemberExpression'
  ) {
    const found = member(node);
    if (found == null) {
      return failure(`${record.file}: dynamic or optional theme member`);
    }
    return resolveExpression(context, record, found.root, [
      ...found.segments,
      ...segments,
    ]);
  }
  if (node.type === 'CallExpression' && node.arguments?.length === 0) {
    const callee = unwrap(node.callee);
    if (callee?.type === 'Identifier') {
      const declared = record.functions.get(String(callee.name));
      const returned = declared == null ? null : functionReturn(declared);
      return returned == null
        ? failure(
            `${record.file}: unsupported theme helper ${String(callee.name)}`,
          )
        : resolveExpression(context, record, returned, segments);
    }
  }
  if (segments.length !== 0) return MISSING;
  if (node.type === 'StringLiteral') {
    return Object.freeze({ status: 'known', value: String(node.value) });
  }
  if (node.type === 'NumericLiteral' && Number.isFinite(node.value)) {
    return Object.freeze({ status: 'known', value: Number(node.value) });
  }
  if (
    node.type === 'TemplateLiteral' &&
    (node.expressions ?? []).length === 0 &&
    node.quasis?.length === 1
  ) {
    return Object.freeze({
      status: 'known',
      value: String(
        node.quasis[0].value?.cooked ?? node.quasis[0].value?.raw ?? '',
      ),
    });
  }
  if (
    node.type === 'UnaryExpression' &&
    (node.operator === '+' || node.operator === '-') &&
    node.argument?.type === 'NumericLiteral'
  ) {
    const value = Number(node.argument.value);
    return Object.freeze({
      status: 'known',
      value: node.operator === '-' ? -value : value,
    });
  }
  return failure(
    `${record.file}: ${String(node.type)} is not a static theme value`,
  );
}

export function resolveThemeValue({
  repositoryRoot,
  moduleFile,
  exportName,
  sourcePath,
}: {
  +repositoryRoot: string,
  +moduleFile: string,
  +exportName: string,
  +sourcePath: string,
}): ThemeValueResolution {
  const root = canonicalRoot(repositoryRoot);
  const mappings = projectMappings(root);
  const context: ResolverContext = {
    repositoryRoot: root,
    baseUrl: mappings.baseUrl,
    paths: mappings.paths,
    modules: new Map(),
    inputFiles: new Set(),
    active: new Set(),
  };
  const result = resolveExport(
    context,
    moduleFile,
    exportName,
    sourcePath.split('.'),
  );
  const inputFiles = Object.freeze([...context.inputFiles].sort());
  if (result.status === 'known') {
    return Object.freeze({
      status: 'known',
      value: result.value,
      inputFiles,
    });
  }
  return Object.freeze({
    status: 'resolution-failed',
    reason:
      result.status === 'missing'
        ? `${moduleFile}: ${exportName}.${sourcePath} is missing`
        : result.reason,
    inputFiles,
  });
}

/**
 * Fills a token-map definition from source instead of asking a user or agent to
 * transcribe values. `sourceFiles` initially names the module(s) exporting the
 * variants; the returned definition expands it to every module consulted by
 * the bounded resolver. The normal decision validator remains the authority on
 * the returned schema.
 */
export function resolveThemeDecisionDefinition({
  repositoryRoot,
  definition: input,
}: {
  +repositoryRoot: string,
  +definition: mixed,
}): mixed {
  const definition: $FlowFixMe = input;
  if (
    !object(definition) ||
    !Array.isArray(definition.variants) ||
    definition.variants.length === 0 ||
    !Array.isArray(definition.tokens) ||
    definition.tokens.length === 0 ||
    !Array.isArray(definition.sourceFiles) ||
    definition.sourceFiles.length === 0 ||
    !definition.sourceFiles.every((file) => typeof file === 'string')
  ) {
    throw new Error(
      'Theme resolution requires variants, tokens, and source files',
    );
  }
  const root = canonicalRoot(repositoryRoot);
  const mappings = projectMappings(root);
  const context: ResolverContext = {
    repositoryRoot: root,
    baseUrl: mappings.baseUrl,
    paths: mappings.paths,
    modules: new Map(),
    inputFiles: new Set(),
    active: new Set(),
  };
  const variantSources = new Map<string, string>();
  const tokens = definition.tokens.map((tokenInput) => {
    const token: $FlowFixMe = tokenInput;
    if (!object(token) || typeof token.sourcePath !== 'string') {
      throw new Error('Theme resolution requires a sourcePath for every token');
    }
    const values = {};
    for (const variantInput of definition.variants) {
      const variant: $FlowFixMe = variantInput;
      if (
        !object(variant) ||
        typeof variant.name !== 'string' ||
        typeof variant.exportName !== 'string'
      ) {
        throw new Error('Theme resolution requires named variant exports');
      }
      const matches = [];
      const failures = [];
      const candidateFiles =
        typeof variant.sourceFile === 'string'
          ? [variant.sourceFile]
          : definition.sourceFiles;
      for (const file of candidateFiles) {
        const result = resolveExport(
          context,
          file,
          variant.exportName,
          token.sourcePath.split('.'),
        );
        if (result.status === 'known') {
          matches.push({ file, value: result.value });
        } else if (result.status === 'resolution-failed') {
          failures.push(result.reason);
        }
      }
      if (matches.length !== 1) {
        const detail =
          matches.length > 1
            ? `resolved from multiple source files: ${matches
                .map((match) => match.file)
                .join(', ')}`
            : (failures[0] ?? 'export or path was not found');
        throw new Error(
          `Theme token ${token.sourcePath} variant ${variant.name} could not be resolved exactly once (${detail})`,
        );
      }
      const resolved = matches[0].value;
      const priorSource = variantSources.get(variant.name);
      if (priorSource != null && priorSource !== matches[0].file) {
        throw new Error(
          `Theme variant ${variant.name} resolves from inconsistent source modules`,
        );
      }
      variantSources.set(variant.name, matches[0].file);
      const supplied = token.values?.[variant.name];
      if (
        supplied != null &&
        canonicalJson(supplied) !== canonicalJson(resolved)
      ) {
        throw new Error(
          `Theme token ${token.sourcePath} variant ${variant.name} does not match source`,
        );
      }
      values[variant.name] = resolved;
    }
    return { ...token, values };
  });
  return {
    ...definition,
    variants: definition.variants.map((variant) => ({
      ...variant,
      sourceFile: String(variantSources.get(variant.name)),
    })),
    tokens,
    sourceFiles: [...context.inputFiles].sort(),
  };
}

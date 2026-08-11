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
import { gitBuffer } from '../kernel/snapshot';
import { STYLEX_MODULE } from '../static/emit';
import { parseSource } from '../static/parse';
import { walk } from '../static/walk';
import type { CandidatePatch } from '../candidate/patch';
import type { ThemeDecisionDraft } from './model';

export type ThemeBridgeObservation = {
  +file: string,
  +status: 'observed' | 'not-observed' | 'resolution-failed',
  +importedVariants: $ReadOnlyArray<string>,
  +appliedVariants: $ReadOnlyArray<string>,
  +detail: string,
};

export type ThemeBridgeInspection = {
  +status: 'observed' | 'not-observed' | 'resolution-failed',
  +observations: $ReadOnlyArray<ThemeBridgeObservation>,
  +requiredVariants: $ReadOnlyArray<string>,
  +appliedVariants: $ReadOnlyArray<string>,
  +missingVariants: $ReadOnlyArray<string>,
  +complete: boolean,
  +limitation: string,
};

function extensionless(file: string): string {
  return file.replace(/\.(?:js|jsx|ts|tsx)$/, '');
}

function targetImport(
  file: string,
  specifier: string,
  target: string,
): boolean {
  if (!specifier.startsWith('.')) return false;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(file), specifier),
  );
  return extensionless(resolved) === extensionless(target);
}

function patternNames(pattern: $FlowFixMe, names: Set<string>): void {
  if (pattern == null || typeof pattern !== 'object') return;
  if (pattern.type === 'Identifier') {
    names.add(String(pattern.name));
    return;
  }
  if (pattern.type === 'RestElement') {
    patternNames(pattern.argument, names);
    return;
  }
  if (pattern.type === 'AssignmentPattern') {
    patternNames(pattern.left, names);
    return;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties ?? []) {
      patternNames(
        property.type === 'RestElement' ? property.argument : property.value,
        names,
      );
    }
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements ?? []) patternNames(element, names);
  }
}

function observeSource(
  source: string,
  file: string,
  draft: ThemeDecisionDraft,
): ThemeBridgeObservation {
  const parsed = parseSource(source, file);
  if (!parsed.ok) {
    return Object.freeze({
      file,
      status: 'resolution-failed',
      importedVariants: Object.freeze([]),
      appliedVariants: Object.freeze([]),
      detail: parsed.reason,
    });
  }
  const variants = new Set(draft.variants.map((variant) => variant.exportName));
  const imported = new Map<string, string>();
  const stylexNamespaces = new Set<string>();
  for (const statement of parsed.ast.program?.body ?? []) {
    if (statement.type !== 'ImportDeclaration') continue;
    const specifier = String(statement.source?.value ?? '');
    if (specifier === STYLEX_MODULE) {
      for (const item of statement.specifiers ?? []) {
        if (
          item.type === 'ImportNamespaceSpecifier' &&
          item.local?.type === 'Identifier'
        ) {
          stylexNamespaces.add(String(item.local.name));
        }
      }
    }
    if (!targetImport(file, specifier, draft.targetModule)) continue;
    for (const item of statement.specifiers ?? []) {
      if (item.type !== 'ImportSpecifier') continue;
      const exported = String(
        item.imported?.name ?? item.imported?.value ?? '',
      );
      if (variants.has(exported) && item.local?.type === 'Identifier') {
        imported.set(String(item.local.name), exported);
      }
    }
  }
  const aliases = new Map<string, Set<string>>();
  const declarators: Array<$FlowFixMe> = [];
  const declarationCounts = new Map<string, number>();
  const parameterNames = new Set<string>();
  walk(parsed.ast, (node) => {
    if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier' &&
      node.init != null
    ) {
      declarators.push(node);
      const name = String(node.id.name);
      declarationCounts.set(name, (declarationCounts.get(name) ?? 0) + 1);
    }
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      for (const parameter of node.params ?? []) {
        patternNames(parameter, parameterNames);
      }
    } else if (node.type === 'CatchClause') {
      patternNames(node.param, parameterNames);
    }
  });
  const unshadowedImport = (name: string): boolean =>
    !parameterNames.has(name) && (declarationCounts.get(name) ?? 0) === 0;
  const unshadowedAlias = (name: string): boolean =>
    !parameterNames.has(name) && declarationCounts.get(name) === 1;
  for (let pass = 0; pass <= declarators.length; pass++) {
    let changed = false;
    for (const declarator of declarators) {
      const found = new Set<string>();
      walk(declarator.init, (child) => {
        if (child.type !== 'Identifier') return;
        const name = String(child.name);
        const direct = imported.get(name);
        if (direct != null && unshadowedImport(name)) found.add(direct);
        if (unshadowedAlias(name)) {
          for (const variant of aliases.get(name) ?? []) found.add(variant);
        }
      });
      const name = String(declarator.id.name);
      const previous = aliases.get(name) ?? new Set();
      if ([...found].some((variant) => !previous.has(variant))) {
        aliases.set(name, new Set([...previous, ...found]));
        changed = true;
      }
    }
    if (!changed) break;
  }
  const applied = new Set<string>();
  walk(parsed.ast, (node) => {
    if (
      node.type !== 'CallExpression' ||
      node.callee?.type !== 'MemberExpression' ||
      node.callee.computed === true ||
      node.callee.object?.type !== 'Identifier' ||
      !stylexNamespaces.has(String(node.callee.object.name)) ||
      !unshadowedImport(String(node.callee.object.name)) ||
      node.callee.property?.type !== 'Identifier' ||
      node.callee.property.name !== 'props'
    ) {
      return;
    }
    for (const argument of node.arguments ?? []) {
      if (argument == null || argument.type === 'SpreadElement') continue;
      walk(argument, (child) => {
        if (child.type !== 'Identifier') return;
        const name = String(child.name);
        const exported = imported.get(name);
        if (exported != null && unshadowedImport(name)) applied.add(exported);
        if (unshadowedAlias(name)) {
          for (const variant of aliases.get(name) ?? []) applied.add(variant);
        }
      });
    }
  });
  return Object.freeze({
    file,
    status: applied.size > 0 ? 'observed' : 'not-observed',
    importedVariants: Object.freeze([...new Set(imported.values())].sort()),
    appliedVariants: Object.freeze([...applied].sort()),
    detail:
      applied.size > 0
        ? 'observed a generated theme variant passed to stylex.props'
        : 'no generated theme variant application was observed',
  });
}

export function inspectThemeBridge({
  repositoryRoot,
  draft,
}: {
  +repositoryRoot: string,
  +draft: ThemeDecisionDraft,
}): ThemeBridgeInspection | null {
  if (draft.bridge == null) return null;
  const sources: { [string]: string | null } = {};
  for (const file of draft.bridge.boundaryFiles) {
    try {
      sources[file] = fs.readFileSync(path.join(repositoryRoot, file), 'utf8');
    } catch (_error) {
      sources[file] = null;
    }
  }
  return inspectThemeBridgeSources({ draft, sources });
}

export function inspectThemeBridgeSources({
  draft,
  sources,
}: {
  +draft: ThemeDecisionDraft,
  +sources: { +[file: string]: string | null },
}): ThemeBridgeInspection | null {
  const bridge = draft.bridge;
  if (bridge == null) return null;
  const observations = bridge.boundaryFiles.map((file) => {
    const source = sources[file];
    if (source == null) {
      const empty: $ReadOnlyArray<string> = Object.freeze([]);
      return Object.freeze({
        file,
        status: 'resolution-failed' as 'resolution-failed',
        importedVariants: empty,
        appliedVariants: empty,
        detail: 'bridge boundary source was unavailable',
      });
    }
    try {
      return observeSource(source, file, draft);
    } catch (error) {
      const empty: $ReadOnlyArray<string> = Object.freeze([]);
      return Object.freeze({
        file,
        status: 'resolution-failed' as 'resolution-failed',
        importedVariants: empty,
        appliedVariants: empty,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });
  const status = observations.some((item) => item.status === 'observed')
    ? 'observed'
    : observations.some((item) => item.status === 'resolution-failed')
      ? 'resolution-failed'
      : 'not-observed';
  const requiredVariants = [...draft.variants]
    .map((variant) => variant.exportName)
    .sort();
  const appliedVariants = [
    ...new Set(observations.flatMap((item) => item.appliedVariants)),
  ].sort();
  const missingVariants = requiredVariants.filter(
    (variant) => !appliedVariants.includes(variant),
  );
  return Object.freeze({
    status,
    observations: Object.freeze(observations),
    requiredVariants: Object.freeze(requiredVariants),
    appliedVariants: Object.freeze(appliedVariants),
    missingVariants: Object.freeze(missingVariants),
    complete:
      missingVariants.length === 0 &&
      observations.every((item) => item.status !== 'resolution-failed'),
    limitation:
      'Static observation of stylex.props does not prove bridge coverage, nesting, portals, inverted themes, SSR, hydration, or runtime behavior.',
  });
}

export function inspectThemeBridgeCandidate({
  candidate,
  draft,
}: {
  +candidate: CandidatePatch,
  +draft: ThemeDecisionDraft,
}): ThemeBridgeInspection | null {
  const bridge = draft.bridge;
  if (bridge == null) return null;
  const changes = new Map(
    candidate.changes.map((change) => [change.path, change]),
  );
  const sources: { [string]: string | null } = {};
  for (const file of bridge.boundaryFiles) {
    const changed = changes.get(file);
    if (changed != null) {
      sources[file] = changed.content;
      continue;
    }
    try {
      const bytes = gitBuffer(candidate.repositoryRoot, [
        'show',
        `${candidate.baseCommit}:${file}`,
      ]);
      const source = bytes.toString('utf8');
      sources[file] = Buffer.from(source, 'utf8').equals(bytes) ? source : null;
    } catch (_error) {
      sources[file] = null;
    }
  }
  return inspectThemeBridgeSources({ draft, sources });
}

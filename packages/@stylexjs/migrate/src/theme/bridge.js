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
import { STYLEX_MODULE } from '../static/emit';
import { parseSource } from '../static/parse';
import { walk } from '../static/walk';
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
  const applied = new Set<string>();
  walk(parsed.ast, (node) => {
    if (
      node.type !== 'CallExpression' ||
      node.callee?.type !== 'MemberExpression' ||
      node.callee.computed === true ||
      node.callee.object?.type !== 'Identifier' ||
      !stylexNamespaces.has(String(node.callee.object.name)) ||
      node.callee.property?.type !== 'Identifier' ||
      node.callee.property.name !== 'props'
    ) {
      return;
    }
    for (const argument of node.arguments ?? []) {
      if (argument?.type !== 'Identifier') continue;
      const exported = imported.get(String(argument.name));
      if (exported != null) applied.add(exported);
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
  const observations = draft.bridge.boundaryFiles.map((file) => {
    try {
      return observeSource(
        fs.readFileSync(path.join(repositoryRoot, file), 'utf8'),
        file,
        draft,
      );
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
  return Object.freeze({
    status,
    observations: Object.freeze(observations),
    limitation:
      'Static observation of stylex.props does not prove bridge coverage, nesting, portals, inverted themes, SSR, hydration, or runtime behavior.',
  });
}

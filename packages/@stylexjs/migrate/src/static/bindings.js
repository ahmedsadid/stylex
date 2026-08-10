/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { walk } from './walk';

/**
 * Binding-aware identifier handling.
 *
 * Emitters never hardcode `stylex`, `React`, or a registry name. A file that
 * already imports StyleX under another name, or that has its own `styles`
 * variable, must still receive working output — writing `stylex.props(...)`
 * into a file where the local name is `sx` produces code that references
 * something that does not exist.
 */

export type ModuleBinding = {
  +localName: string,
  // When false, the caller has to add an import for it.
  +alreadyImported: boolean,
  // Where an existing import ends, so a new one can be placed after it.
  +lastImportEnd: number | null,
  +firstStatementStart: number | null,
};

export function collectUsedNames(ast: $FlowFixMe): $ReadOnlySet<string> {
  const names = new Set<string>();
  walk(ast, (node) => {
    if (
      (node.type === 'Identifier' || node.type === 'JSXIdentifier') &&
      typeof node.name === 'string'
    ) {
      names.add(node.name);
    }
  });
  return names;
}

/**
 * Pick a name that is not already used anywhere in the file. Conservative on
 * purpose: it considers every identifier in the file rather than doing scope
 * analysis, because a wrong answer here produces silently broken code.
 */
export function freeName(base: string, used: $ReadOnlySet<string>): string {
  if (!used.has(base)) {
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}${suffix}`)) {
    suffix++;
  }
  return `${base}${suffix}`;
}

function importedLocalName(ast: $FlowFixMe, moduleName: string): string | null {
  let localName = null;
  walk(ast, (node) => {
    if (
      node.type !== 'ImportDeclaration' ||
      node.source == null ||
      node.source.value !== moduleName
    ) {
      return;
    }
    for (const specifier of node.specifiers ?? []) {
      if (
        (specifier.type === 'ImportNamespaceSpecifier' ||
          specifier.type === 'ImportDefaultSpecifier') &&
        specifier.local != null &&
        typeof specifier.local.name === 'string'
      ) {
        localName = specifier.local.name;
      }
    }
  });
  return localName;
}

export function resolveModuleBinding(
  ast: $FlowFixMe,
  moduleName: string,
  preferredName: string,
): ModuleBinding {
  const body = ast.program?.body ?? [];
  let lastImportEnd = null;
  for (const statement of body) {
    if (statement.type === 'ImportDeclaration') {
      lastImportEnd = statement.end;
    }
  }
  const firstStatementStart = body.length > 0 ? body[0].start : null;

  const existing = importedLocalName(ast, moduleName);
  if (existing != null) {
    return Object.freeze({
      localName: existing,
      alreadyImported: true,
      lastImportEnd,
      firstStatementStart,
    });
  }
  return Object.freeze({
    localName: freeName(preferredName, collectUsedNames(ast)),
    alreadyImported: false,
    lastImportEnd,
    firstStatementStart,
  });
}

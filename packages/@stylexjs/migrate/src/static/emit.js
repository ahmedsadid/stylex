/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import type { Declaration, StaticValue, StyleObject } from './ir';

/**
 * Turning the neutral representation into StyleX source text.
 *
 * Output is plain text rather than a printed AST, so the rest of each file
 * stays byte-for-byte untouched. A pretty-printer would reformat code it was
 * never asked to change, which turns every review into a hunt for the real
 * edit.
 */

export type StyleEntry = {
  +key: string,
  +style: StyleObject,
  // Callers carry their own bookkeeping on these; emission reads only the two
  // fields above.
  ...
};

export const STYLEX_MODULE: string = '@stylexjs/stylex';

export function serializeValue(value: StaticValue): string {
  if (typeof value === 'number') {
    return String(value);
  }
  const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${escaped}'`;
}

/**
 * Keys are emitted in alphabetical order.
 *
 * This is only safe because the supported subset excludes shorthands: with
 * every declaration addressing an independent property, no ordering of them
 * can change the result, and sorted keys satisfy StyleX's own lint rule without
 * anyone having to run an autofix over the file.
 */
function sortedDeclarations(
  declarations: $ReadOnlyArray<Declaration>,
): $ReadOnlyArray<Declaration> {
  return [...declarations].sort((a, b) =>
    a.property < b.property ? -1 : a.property > b.property ? 1 : 0,
  );
}

export function emitStyleObject(style: StyleObject, indent: string): string {
  const lines = sortedDeclarations(style.declarations).map(
    (declaration) =>
      `${indent}  ${declaration.property}: ${serializeValue(declaration.value)},`,
  );
  return `{\n${lines.join('\n')}\n${indent}}`;
}

export function emitCreateCall(
  namespace: string,
  registryName: string,
  entries: $ReadOnlyArray<StyleEntry>,
): string {
  const body = entries
    .map((entry) => `  ${entry.key}: ${emitStyleObject(entry.style, '  ')},`)
    .join('\n');
  return `const ${registryName} = ${namespace}.create({\n${body}\n});`;
}

export function emitPropsSpread(
  namespace: string,
  registryName: string,
  key: string,
): string {
  return `{...${namespace}.props(${registryName}.${key})}`;
}

export function emitImport(namespace: string): string {
  return `import * as ${namespace} from '${STYLEX_MODULE}';`;
}

/**
 * Style keys are named after the element they came from, so a reviewer reading
 * `styles.button` can tell what it belongs to. Collisions get a numeric suffix
 * in source order, which keeps the naming stable between runs.
 */
export function allocateKeys(
  elementNames: $ReadOnlyArray<string>,
): $ReadOnlyArray<string> {
  const counts = new Map<string, number>();
  return elementNames.map((name) => {
    const seen = counts.get(name) ?? 0;
    counts.set(name, seen + 1);
    return seen === 0 ? name : `${name}${seen + 1}`;
  });
}

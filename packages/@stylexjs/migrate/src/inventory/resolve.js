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
import { createFact } from './model';
import type { Fact, LocalDependency } from './model';

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

function localSpecifiers(ast: $FlowFixMe): $ReadOnlyArray<string> {
  const specifiers = [];
  for (const node of ast.program?.body ?? []) {
    if (
      (node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      typeof node.source?.value === 'string' &&
      node.source.value.startsWith('.')
    ) {
      specifiers.push(node.source.value);
    }
  }
  return [...new Set(specifiers)].sort();
}

function candidates(base: string): $ReadOnlyArray<string> {
  const output = [base];
  if (path.extname(base) === '') {
    for (const extension of EXTENSIONS) {
      output.push(`${base}${extension}`);
    }
    for (const extension of EXTENSIONS) {
      output.push(path.join(base, `index${extension}`));
    }
  }
  return output;
}

function resolveLocal(
  repositoryRoot: string,
  importer: string,
  specifier: string,
): string | null {
  const base = path.resolve(repositoryRoot, path.dirname(importer), specifier);
  const relativeBase = path.relative(repositoryRoot, base);
  if (
    path.isAbsolute(relativeBase) ||
    relativeBase === '..' ||
    relativeBase.startsWith(`..${path.sep}`)
  ) {
    return null;
  }
  for (const candidate of candidates(base)) {
    try {
      const stats = fs.lstatSync(candidate);
      if (stats.isFile() && !stats.isSymbolicLink()) {
        return path
          .relative(repositoryRoot, candidate)
          .split(path.sep)
          .join('/');
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
      return null;
    }
  }
  return null;
}

export function analyzeLocalDependencies({
  ast,
  repositoryRoot,
  file,
}: {
  +ast: $FlowFixMe,
  +repositoryRoot: string,
  +file: string,
}): {
  +dependencies: $ReadOnlyArray<LocalDependency>,
  +facts: $ReadOnlyArray<Fact>,
} {
  const dependencies: Array<LocalDependency> = [];
  const facts: Array<Fact> = [];
  for (const specifier of localSpecifiers(ast)) {
    const resolvedPath = resolveLocal(repositoryRoot, file, specifier);
    const fact = createFact({
      kind: 'local-module-resolution',
      status: resolvedPath == null ? 'resolution-failed' : 'known',
      value: { specifier, resolvedPath },
      provenance: [
        {
          kind: 'resolver',
          file,
          detail:
            resolvedPath == null
              ? `could not resolve ${specifier}`
              : `resolved ${specifier} to ${resolvedPath}`,
        },
      ],
      inputFiles: resolvedPath == null ? [file] : [file, resolvedPath],
    });
    facts.push(fact);
    const status: 'known' | 'resolution-failed' =
      resolvedPath == null ? 'resolution-failed' : 'known';
    dependencies.push(
      Object.freeze({
        specifier,
        status,
        resolvedPath,
        factId: fact.id,
      }),
    );
  }
  return Object.freeze({
    dependencies: Object.freeze(dependencies),
    facts: Object.freeze(facts),
  });
}

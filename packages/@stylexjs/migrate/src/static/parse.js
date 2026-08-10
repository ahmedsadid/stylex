/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { parse as babelParse } from '@babel/parser';
import path from 'path';
import type { ParserPlugin } from '@babel/parser';

/**
 * Parsing, isolated behind one module.
 *
 * Two things matter here and nowhere else:
 *
 *   1. `.ts` is not `.tsx`. In a `.ts` file `<number>x` is a type assertion; in
 *      a `.tsx` file it is the start of a JSX element. Parsing every TypeScript
 *      file as TSX misreads real code, so the plugin set is chosen from the
 *      filename.
 *   2. Parsing never throws at the caller. A file we cannot read is a refusal
 *      with a reason, not a crashed run — one unusual file in a repository must
 *      not take down the migration.
 */

export type ParseFailure = {
  +ok: false,
  +reason: string,
};

export type ParseSuccess = {
  +ok: true,
  // The babel File node. Deliberately untyped: this module is the only place
  // allowed to know what shape the parser produces.
  +ast: $FlowFixMe,
};

export type ParseResult = ParseFailure | ParseSuccess;

const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.mts', '.cts']);
const TYPESCRIPT_JSX_EXTENSIONS = new Set(['.tsx', '.mtsx', '.ctsx']);

export function pluginsForFilename(
  filename: string,
): $ReadOnlyArray<ParserPlugin> {
  const extension = path.extname(filename);
  if (TYPESCRIPT_EXTENSIONS.has(extension)) {
    // No `jsx`: it changes the meaning of `<T>value` in these files.
    return ['typescript'];
  }
  if (TYPESCRIPT_JSX_EXTENSIONS.has(extension)) {
    return ['typescript', 'jsx'];
  }
  return ['flow', 'jsx'];
}

export function parseSource(source: string, filename: string): ParseResult {
  try {
    const ast = babelParse(source, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: false,
      plugins: [...pluginsForFilename(filename)],
    });
    return { ok: true, ast };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `could not parse file (${message})` };
  }
}

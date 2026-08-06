/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * A compact unified diff of a conversion, for the CLI's `--diff` preview — so a
 * user can SEE exactly what would change before `--write`, not just the counts.
 */

// $FlowFixMe[cannot-resolve-module] - `diff` has no flow libdef here
import { createPatch } from 'diff';

/** A unified diff of `before` → `after`, with the `Index:`/`===`/`--- `/`+++ `
 * header lines stripped (the filename is already shown by the report). Empty
 * string when there's no change. */
export function fileDiff(
  filename: string,
  before: string,
  after: string,
): string {
  if (before === after) {
    return '';
  }
  const patch: string = createPatch(filename, before, after, '', '', {
    context: 2,
  });
  return patch
    .split('\n')
    .filter(
      (line) =>
        !line.startsWith('Index:') &&
        !line.startsWith('====') &&
        !line.startsWith('--- ') &&
        !line.startsWith('+++ '),
    )
    .join('\n')
    .trim();
}

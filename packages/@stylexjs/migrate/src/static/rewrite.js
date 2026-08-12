/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

/**
 * Span-based source editing.
 *
 * Every change is expressed as "replace exactly these characters". Nothing
 * outside a listed span can move, so the diff a reviewer sees contains only the
 * conversion — no reflowed lines, no requoted strings, no reordered imports
 * that a printer decided to tidy on the way past.
 */

export type Edit = {
  +start: number,
  +end: number,
  +text: string,
};

export type EditResult = {
  +code: string,
  // Where each edit's text begins in the output, indexed as the edits were
  // given. Callers use this to check that a specific source site received a
  // specific replacement, which scanning the output cannot establish.
  +placements: $ReadOnlyArray<number>,
};

export function applyEdits(
  source: string,
  edits: $ReadOnlyArray<Edit>,
): string {
  return applyEditsWithPlacements(source, edits).code;
}

export function applyEditsWithPlacements(
  source: string,
  edits: $ReadOnlyArray<Edit>,
): EditResult {
  const ordered = edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) =>
      a.edit.start !== b.edit.start
        ? a.edit.start - b.edit.start
        : // Insertions at the same offset keep the caller's order.
          a.index - b.index,
    );

  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1].edit;
    const current = ordered[i].edit;
    if (current.start < previous.end) {
      throw new Error(
        `Overlapping edits: [${previous.start}, ${previous.end}) and ` +
          `[${current.start}, ${current.end}). This is a bug in the proposer, ` +
          'not something the source can cause.',
      );
    }
  }

  const placements: Array<number> = edits.map(() => -1);
  let result = '';
  let cursor = 0;
  for (const { edit, index } of ordered) {
    result += source.slice(cursor, edit.start);
    placements[index] = result.length;
    result += edit.text;
    cursor = edit.end;
  }
  result += source.slice(cursor);
  return { code: result, placements };
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * A minimal `[done/total]` progress line on stderr for large runs, so a
 * migration over thousands of files (or a slow --render-check) doesn't look
 * hung. Interactive only: it overwrites one line via carriage return when
 * stderr is a TTY; in a pipe/CI (non-TTY) it stays silent so logs aren't
 * flooded. stderr keeps stdout clean for --json.
 */

export type Progress = {
  +tick: (done: number, total: number, note?: string) => void,
  +done: () => void,
};

const NOOP: Progress = { tick: () => {}, done: () => {} };

/** A progress reporter, or a no-op when stderr isn't an interactive TTY. */
export function makeProgress(label: string): Progress {
  const stream: $FlowFixMe = process.stderr;
  if (stream.isTTY !== true) {
    return NOOP;
  }
  let last = '';
  return {
    tick(done: number, total: number, note?: string): void {
      const suffix = note != null && note !== '' ? `  ${note}` : '';
      const line = `${label} [${done}/${total}]${suffix}`;
      // Pad to clear a previously-longer line.
      const padded = line.padEnd(last.length);
      stream.write(`\r${padded}`);
      last = line;
    },
    done(): void {
      if (last !== '') {
        stream.write('\n');
      }
    },
  };
}

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
import { execFileSync } from 'child_process';
import { hashFields, hashString } from './hash';

/**
 * A workspace snapshot identifies the exact source state a candidate was built
 * against.
 *
 * `fileHashes` maps a repository-relative path to the hash of its contents, or
 * to `null` when the file did not exist. Recording absence explicitly matters:
 * a candidate that adds `Button.styles.js` must become stale if somebody else
 * creates that file in the meantime.
 */
export type WorkspaceSnapshot = {
  +repositoryRoot: string,
  +gitCommit: string,
  +dirty: boolean,
  +configHash: string,
  +fileHashes: { +[path: string]: string | null },
};

export function git(
  repositoryRoot: string,
  args: $ReadOnlyArray<string>,
): string {
  try {
    const output = execFileSync('git', [...args], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      // Capture stderr rather than letting git write to the caller's terminal;
      // it is reported through the thrown error when a command actually fails.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return String(output);
  } catch (error) {
    const stderr =
      error != null && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr ?? '').trim()
        : '';
    throw new Error(
      `git ${args.join(' ')} failed in ${repositoryRoot}` +
        (stderr === '' ? '' : `: ${stderr}`),
    );
  }
}

export function gitCommitOf(repositoryRoot: string): string {
  return git(repositoryRoot, ['rev-parse', 'HEAD']).trim();
}

export function isWorktreeClean(repositoryRoot: string): boolean {
  return git(repositoryRoot, ['status', '--porcelain']).trim() === '';
}

function hashFileAt(
  repositoryRoot: string,
  relativePath: string,
): string | null {
  const absolute = path.join(repositoryRoot, relativePath);
  if (!fs.existsSync(absolute)) {
    return null;
  }
  return hashString(fs.readFileSync(absolute, 'utf8'));
}

export function createSnapshot({
  repositoryRoot,
  files,
  configHash,
}: {
  +repositoryRoot: string,
  +files: $ReadOnlyArray<string>,
  +configHash?: string,
}): WorkspaceSnapshot {
  const fileHashes: { [path: string]: string | null } = {};
  for (const file of files) {
    fileHashes[file] = hashFileAt(repositoryRoot, file);
  }
  return Object.freeze({
    repositoryRoot,
    gitCommit: gitCommitOf(repositoryRoot),
    dirty: !isWorktreeClean(repositoryRoot),
    configHash: configHash ?? hashString(''),
    fileHashes: Object.freeze(fileHashes),
  });
}

/**
 * Add files to a snapshot that were not known when it was taken, recording
 * their current hash (or absence). Used when a candidate turns out to touch a
 * file the original plan did not list, so that staleness detection covers
 * everything the write will actually touch.
 */
export function extendSnapshot(
  snapshot: WorkspaceSnapshot,
  files: $ReadOnlyArray<string>,
): WorkspaceSnapshot {
  const known = new Set(Object.keys(snapshot.fileHashes));
  const missing = files.filter((file) => !known.has(file));
  if (missing.length === 0) {
    return snapshot;
  }
  const fileHashes: { [path: string]: string | null } = {
    ...snapshot.fileHashes,
  };
  for (const file of missing) {
    fileHashes[file] = hashFileAt(snapshot.repositoryRoot, file);
  }
  return Object.freeze({
    ...snapshot,
    fileHashes: Object.freeze(fileHashes),
  });
}

export function snapshotHash(snapshot: WorkspaceSnapshot): string {
  const paths = Object.keys(snapshot.fileHashes).sort();
  const fields = [snapshot.gitCommit, snapshot.configHash];
  for (const file of paths) {
    fields.push(file, snapshot.fileHashes[file] ?? 'absent');
  }
  return hashFields(fields);
}

/**
 * Re-read every file the snapshot covers and report the ones that no longer
 * match. A non-empty result means any candidate built on this snapshot is
 * stale and must not be written.
 */
export function detectStaleFiles(
  snapshot: WorkspaceSnapshot,
): $ReadOnlyArray<string> {
  const stale = [];
  for (const file of Object.keys(snapshot.fileHashes).sort()) {
    const recorded = snapshot.fileHashes[file];
    const current = hashFileAt(snapshot.repositoryRoot, file);
    if (recorded !== current) {
      stale.push(file);
    }
  }
  return stale;
}

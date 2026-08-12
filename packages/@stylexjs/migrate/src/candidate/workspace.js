/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  canonicalRoot,
  git,
  gitCommitOf,
  isWorktreeClean,
} from '../kernel/snapshot';

/**
 * The candidate workspace: an isolated git worktree, created at an exact base
 * commit, that a proposer may write to freely.
 *
 * It lives outside the repository by design. Only operational artifacts belong
 * there, and a stray worktree inside the source tree would show up in the
 * user's own diffs and in later scans.
 */
export type CandidateWorkspace = {
  +path: string,
  +repositoryRoot: string,
  +baseCommit: string,
  +allowedPaths: $ReadOnlyArray<string>,
};

export function assertCleanWorktree(repositoryRoot: string): void {
  if (!isWorktreeClean(repositoryRoot)) {
    throw new Error(
      'The repository has uncommitted changes. A candidate workspace needs a ' +
        'clean worktree so its base commit is reproducible. Commit or stash ' +
        'first — this tool will not discard your work.',
    );
  }
}

export function createCandidateWorkspace({
  repositoryRoot: requestedRoot,
  allowedPaths,
  baseCommit,
  requireClean = true,
  rootDir,
}: {
  +repositoryRoot: string,
  +allowedPaths: $ReadOnlyArray<string>,
  +baseCommit?: string,
  +requireClean?: boolean,
  +rootDir?: string,
}): CandidateWorkspace {
  // Canonicalised for the same reason the snapshot is: the two are compared to
  // establish that a candidate belongs to the repository it will be written
  // into, and `/tmp/x` and `/private/tmp/x` must not look like different
  // repositories.
  const repositoryRoot = canonicalRoot(requestedRoot);
  if (requireClean) {
    assertCleanWorktree(repositoryRoot);
  }
  const commit = baseCommit ?? gitCommitOf(repositoryRoot);
  const parent = rootDir ?? path.join(os.tmpdir(), 'stylex-migrate');
  fs.mkdirSync(parent, { recursive: true });
  const workspacePath = path.join(
    parent,
    `candidate-${crypto.randomBytes(8).toString('hex')}`,
  );
  git(repositoryRoot, ['worktree', 'add', '--detach', workspacePath, commit]);
  // Worktrees inherit sparse-checkout configuration from the source
  // repository. Candidate allowlists are enforced by the kernel, while an
  // inherited sparse index can reject authorized new paths (notably generated
  // dot-directories) before that validation runs.
  git(workspacePath, ['sparse-checkout', 'disable']);
  return Object.freeze({
    path: workspacePath,
    repositoryRoot,
    baseCommit: commit,
    allowedPaths: Object.freeze([...allowedPaths]),
  });
}

export function removeCandidateWorkspace(workspace: CandidateWorkspace): void {
  try {
    git(workspace.repositoryRoot, [
      'worktree',
      'remove',
      '--force',
      workspace.path,
    ]);
  } catch (error) {
    // A worktree that is already gone must not fail cleanup; prune the
    // administrative entry and remove whatever is left on disk.
    fs.rmSync(workspace.path, { recursive: true, force: true });
    git(workspace.repositoryRoot, ['worktree', 'prune']);
  }
}

/** Materialize every tracked path in a disposable worktree used for evidence. */
export function materializeFullCheckout(workspace: CandidateWorkspace): void {
  git(workspace.path, ['sparse-checkout', 'disable']);
}

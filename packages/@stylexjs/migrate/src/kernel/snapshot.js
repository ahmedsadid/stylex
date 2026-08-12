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
import { hashBytes, hashFields, hashString } from './hash';

/**
 * A workspace snapshot identifies the exact source state a candidate was built
 * against.
 *
 * `fileHashes` maps a repository-relative path to the hash of its contents **at
 * `gitCommit`**, or to `null` when the file did not exist there. Two details
 * carry weight:
 *
 *   - Preimages come from the commit, never from the working tree. A proposer
 *     edits a worktree checked out at that commit, so the commit is what its
 *     work is based on. Reading the working tree instead would let a file the
 *     user edited after the snapshot be recorded as though it were the
 *     proposer's starting point, and the user's edit would then be overwritten
 *     without ever looking stale.
 *   - Absence is recorded explicitly, so a candidate that adds a file becomes
 *     stale if somebody else creates that path in the meantime.
 *
 * Staleness compares the working tree against those preimages, which is what
 * makes a concurrent edit visible.
 */
export type WorkspaceSnapshot = {
  +repositoryRoot: string,
  +gitCommit: string,
  +dirty: boolean,
  +configHash: string,
  +fileHashes: { +[path: string]: string | null },
  // Git-relevant file mode at `gitCommit`. Content alone cannot distinguish a
  // regular source file from an executable one.
  +fileModes: { +[path: string]: string | null },
  // Human decisions are immutable inputs just like source bytes. This field is
  // optional only so candidates persisted before the decision protocol remain
  // readable; new decision-backed snapshots always carry it.
  +decisionArtifactHashes?: $ReadOnlyArray<string>,
  // Test assumptions are deliberately separate from owner decisions. They may
  // authorize named disposable checks but can never satisfy approval policy.
  +assumptionArtifactHashes?: $ReadOnlyArray<string>,
};

function canonicalArtifactHashes(
  values: $ReadOnlyArray<string> = [],
): $ReadOnlyArray<string> {
  if (values.some((value) => typeof value !== 'string' || value === '')) {
    throw new Error('Decision artifact hashes must be non-empty strings');
  }
  return Object.freeze([...new Set(values)].sort());
}

export function snapshotDecisionArtifactHashes(
  snapshot: WorkspaceSnapshot,
): $ReadOnlyArray<string> {
  return canonicalArtifactHashes(snapshot.decisionArtifactHashes);
}

export function snapshotAssumptionArtifactHashes(
  snapshot: WorkspaceSnapshot,
): $ReadOnlyArray<string> {
  return canonicalArtifactHashes(snapshot.assumptionArtifactHashes);
}

export function bindSnapshotDecisionArtifacts(
  snapshot: WorkspaceSnapshot,
  decisionArtifactHashes: $ReadOnlyArray<string>,
): WorkspaceSnapshot {
  const stable = canonicalArtifactHashes(decisionArtifactHashes);
  return Object.freeze({
    ...snapshot,
    decisionArtifactHashes: stable,
  });
}

export function bindSnapshotAssumptionArtifacts(
  snapshot: WorkspaceSnapshot,
  assumptionArtifactHashes: $ReadOnlyArray<string>,
): WorkspaceSnapshot {
  const stable = canonicalArtifactHashes(assumptionArtifactHashes);
  return Object.freeze({
    ...snapshot,
    assumptionArtifactHashes: stable,
  });
}

export function git(
  repositoryRoot: string,
  args: $ReadOnlyArray<string>,
): string {
  return gitBuffer(repositoryRoot, args).toString('utf8');
}

export function gitBuffer(
  repositoryRoot: string,
  args: $ReadOnlyArray<string>,
): Buffer {
  try {
    const output = execFileSync('git', [...args], {
      cwd: repositoryRoot,
      maxBuffer: 256 * 1024 * 1024,
      // Capture stderr rather than letting git write to the caller's terminal;
      // it is reported through the thrown error when a command actually fails.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return typeof output === 'string' ? Buffer.from(output) : output;
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

/**
 * Run a git command that is expected to fail for ordinary reasons, such as
 * asking for a path that does not exist in a commit.
 */
function gitBufferOrNull(
  repositoryRoot: string,
  args: $ReadOnlyArray<string>,
): Buffer | null {
  try {
    return gitBuffer(repositoryRoot, args);
  } catch (error) {
    return null;
  }
}

/**
 * Resolve a repository root to its canonical absolute path.
 *
 * Two paths that name the same repository through different symlinks or
 * relative forms must compare equal, because that comparison is what stops a
 * candidate verified against one checkout from being written into another.
 */
export function canonicalRoot(repositoryRoot: string): string {
  return fs.realpathSync(path.resolve(repositoryRoot));
}

export function gitCommitOf(repositoryRoot: string): string {
  return git(repositoryRoot, ['rev-parse', 'HEAD']).trim();
}

export function isWorktreeClean(repositoryRoot: string): boolean {
  return git(repositoryRoot, ['status', '--porcelain']).trim() === '';
}

/**
 * The content of a path as of a commit, or null when it did not exist.
 */
function blobAt(
  repositoryRoot: string,
  commit: string,
  relativePath: string,
): Buffer | null {
  return gitBufferOrNull(repositoryRoot, ['show', `${commit}:${relativePath}`]);
}

function commitHashAt(
  repositoryRoot: string,
  commit: string,
  relativePath: string,
): string | null {
  const blob = blobAt(repositoryRoot, commit, relativePath);
  return blob == null ? null : hashBytes(blob);
}

function commitModeAt(
  repositoryRoot: string,
  commit: string,
  relativePath: string,
): string | null {
  const output = gitBufferOrNull(repositoryRoot, [
    'ls-tree',
    '-z',
    commit,
    '--',
    relativePath,
  ]);
  if (output == null || output.length === 0) {
    return null;
  }
  const header = output.toString('utf8').split('\t', 1)[0];
  const mode = header.split(' ', 1)[0];
  return mode === '' ? null : mode;
}

/**
 * The hash of what is on disk right now, or null when nothing is there.
 *
 * The file kind is folded into the hash: replacing a regular file with a
 * symlink that points at identical content is still a change, and comparing
 * only the bytes read through the link would miss it.
 */
function workingTreeHashAt(
  repositoryRoot: string,
  relativePath: string,
): string | null {
  const absolute = path.join(repositoryRoot, relativePath);
  let stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch (error) {
    return null;
  }
  if (stats.isSymbolicLink()) {
    return hashString(`link:${fs.readlinkSync(absolute)}`);
  }
  if (!stats.isFile()) {
    return hashString(`other:${relativePath}`);
  }
  return hashBytes(fs.readFileSync(absolute));
}

function workingTreeModeAt(
  repositoryRoot: string,
  relativePath: string,
): string | null {
  const absolute = path.join(repositoryRoot, relativePath);
  let stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch (error) {
    return null;
  }
  if (stats.isSymbolicLink()) {
    return '120000';
  }
  if (!stats.isFile()) {
    return 'other';
  }
  return (stats.mode & 0o111) !== 0 ? '100755' : '100644';
}

export function createSnapshot({
  repositoryRoot,
  files,
  configHash,
  decisionArtifactHashes = [],
  assumptionArtifactHashes = [],
}: {
  +repositoryRoot: string,
  +files: $ReadOnlyArray<string>,
  +configHash?: string,
  +decisionArtifactHashes?: $ReadOnlyArray<string>,
  +assumptionArtifactHashes?: $ReadOnlyArray<string>,
}): WorkspaceSnapshot {
  const root = canonicalRoot(repositoryRoot);
  const gitCommit = gitCommitOf(root);
  const fileHashes: { [path: string]: string | null } = {};
  const fileModes: { [path: string]: string | null } = {};
  for (const file of files) {
    fileHashes[file] = commitHashAt(root, gitCommit, file);
    fileModes[file] = commitModeAt(root, gitCommit, file);
  }
  const decisions = canonicalArtifactHashes(decisionArtifactHashes);
  const assumptions = canonicalArtifactHashes(assumptionArtifactHashes);
  return Object.freeze({
    repositoryRoot: root,
    gitCommit,
    dirty: !isWorktreeClean(root),
    configHash: configHash ?? hashString(''),
    fileHashes: Object.freeze(fileHashes),
    fileModes: Object.freeze(fileModes),
    decisionArtifactHashes: decisions,
    assumptionArtifactHashes: assumptions,
  } as WorkspaceSnapshot);
}

/**
 * Add files to a snapshot that were not known when it was taken.
 *
 * Preimages are read from the snapshot's commit, so extending a snapshot after
 * a proposer has run cannot absorb an edit the user made in the meantime: the
 * recorded value is what the proposer started from, and the user's newer
 * content will not match it.
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
  const fileModes: { [path: string]: string | null } = {
    ...snapshot.fileModes,
  };
  for (const file of missing) {
    fileHashes[file] = commitHashAt(
      snapshot.repositoryRoot,
      snapshot.gitCommit,
      file,
    );
    fileModes[file] = commitModeAt(
      snapshot.repositoryRoot,
      snapshot.gitCommit,
      file,
    );
  }
  return Object.freeze({
    ...snapshot,
    fileHashes: Object.freeze(fileHashes),
    fileModes: Object.freeze(fileModes),
  });
}

export function snapshotHash(snapshot: WorkspaceSnapshot): string {
  const paths = Object.keys(snapshot.fileHashes).sort();
  const fields = [
    snapshot.repositoryRoot,
    snapshot.gitCommit,
    snapshot.configHash,
  ];
  const decisions = snapshotDecisionArtifactHashes(snapshot);
  if (decisions.length > 0) {
    fields.push('decision-artifacts', ...decisions);
  }
  const assumptions = snapshotAssumptionArtifactHashes(snapshot);
  if (assumptions.length > 0) {
    fields.push('test-assumption-artifacts', ...assumptions);
  }
  for (const file of paths) {
    fields.push(
      file,
      snapshot.fileModes[file] ?? 'absent',
      snapshot.fileHashes[file] ?? 'absent',
    );
  }
  return hashFields(fields);
}

/**
 * Re-read every file the snapshot covers and report the ones that no longer
 * match its commit. A non-empty result means any candidate built on this
 * snapshot is stale and must not be written.
 */
export function detectStaleFiles(
  snapshot: WorkspaceSnapshot,
): $ReadOnlyArray<string> {
  const stale = [];
  for (const file of Object.keys(snapshot.fileHashes).sort()) {
    const recorded = snapshot.fileHashes[file];
    const current = workingTreeHashAt(snapshot.repositoryRoot, file);
    const recordedMode = snapshot.fileModes[file];
    const currentMode = workingTreeModeAt(snapshot.repositoryRoot, file);
    if (recorded !== current || recordedMode !== currentMode) {
      stale.push(file);
    }
  }
  return stale;
}

/**
 * The repository must still be on the commit the snapshot names.
 *
 * A snapshot records the hashes of the files it was told about. Advancing HEAD
 * can change anything else in the repository — a dependency, a config file, a
 * module the converted file imports — so a candidate built before that move is
 * no longer known to be based on the current state, whether or not its own
 * files happen to match.
 */
export function detectMovedHead(snapshot: WorkspaceSnapshot): string | null {
  const current = gitCommitOf(snapshot.repositoryRoot);
  return current === snapshot.gitCommit ? null : current;
}

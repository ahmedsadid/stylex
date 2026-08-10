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
import { detectStaleFiles, snapshotHash } from '../kernel/snapshot';
import { changedPaths } from './patch';
import { validateScope } from './scope';
import type { WorkspaceSnapshot } from '../kernel/snapshot';
import type { CandidatePatch } from './patch';
import type { ScopeRules, ScopeViolation } from './scope';

/**
 * Writing a candidate into the accepted source tree.
 *
 * This is the only place in the kit that modifies the user's files, and it
 * refuses in three situations before it writes anything: the candidate is not
 * bound to this snapshot, the patch leaves its allowed paths, or a source file
 * has changed since the candidate was verified.
 *
 * When a write fails part-way, the originals are restored from a recovery
 * directory and the patch is left on disk, so the tree is never abandoned in a
 * half-written state. Git remains the rollback mechanism of last resort; this
 * module never runs a destructive git command.
 */

export type WriteIO = {
  +writeFileSync: (file: string, data: string) => void,
  +renameSync: (from: string, to: string) => void,
};

export type WriteResult =
  | {
      +status: 'written',
      +candidateId: string,
      +files: $ReadOnlyArray<string>,
      +recoveryPath: string,
    }
  | {
      +status: 'stale',
      +candidateId: string,
      +staleFiles: $ReadOnlyArray<string>,
    }
  | {
      +status: 'scope-violation',
      +candidateId: string,
      +violations: $ReadOnlyArray<ScopeViolation>,
    }
  | {
      +status: 'failed',
      +candidateId: string,
      +error: string,
      +restored: $ReadOnlyArray<string>,
      +unrestored: $ReadOnlyArray<string>,
      +recoveryPath: string,
    };

const TEMP_SUFFIX = '.stylex-migrate-tmp';

export const defaultWriteIO: WriteIO = Object.freeze({
  writeFileSync: (file: string, data: string) => {
    fs.writeFileSync(file, data, 'utf8');
  },
  renameSync: (from: string, to: string) => {
    fs.renameSync(from, to);
  },
});

function assertSafeRelativePath(filePath: string): void {
  if (path.isAbsolute(filePath)) {
    throw new Error(`Candidate path must be repository-relative: ${filePath}`);
  }
  const normalized = path.normalize(filePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Candidate path escapes the repository: ${filePath}`);
  }
}

function prepareRecovery(
  repositoryRoot: string,
  candidate: CandidatePatch,
  recoveryRoot: string,
): string {
  const recoveryPath = path.join(recoveryRoot, candidate.id);
  fs.mkdirSync(path.join(recoveryPath, 'originals'), { recursive: true });
  fs.writeFileSync(
    path.join(recoveryPath, 'candidate.patch'),
    candidate.patchText,
    'utf8',
  );
  fs.writeFileSync(
    path.join(recoveryPath, 'manifest.json'),
    JSON.stringify(
      {
        candidateId: candidate.id,
        baseCommit: candidate.baseCommit,
        baseSnapshotHash: candidate.baseSnapshotHash,
        patchHash: candidate.patchHash,
        touchedFiles: candidate.touchedFiles,
      },
      null,
      2,
    ),
    'utf8',
  );
  for (const file of candidate.touchedFiles) {
    const absolute = path.join(repositoryRoot, file);
    if (fs.existsSync(absolute)) {
      const target = path.join(recoveryPath, 'originals', file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(absolute, target);
    }
  }
  return recoveryPath;
}

function restore(
  repositoryRoot: string,
  recoveryPath: string,
  files: $ReadOnlyArray<string>,
): { +restored: $ReadOnlyArray<string>, +unrestored: $ReadOnlyArray<string> } {
  const restored = [];
  const unrestored = [];
  for (const file of files) {
    const absolute = path.join(repositoryRoot, file);
    const original = path.join(recoveryPath, 'originals', file);
    try {
      if (fs.existsSync(original)) {
        fs.copyFileSync(original, absolute);
      } else {
        // The file did not exist before this candidate; undo means remove it.
        fs.rmSync(absolute, { force: true });
      }
      restored.push(file);
    } catch (error) {
      unrestored.push(file);
    }
  }
  return { restored, unrestored };
}

export function writeCandidate({
  repositoryRoot,
  candidate,
  snapshot,
  scopeRules,
  io = defaultWriteIO,
  recoveryRoot,
}: {
  +repositoryRoot: string,
  +candidate: CandidatePatch,
  +snapshot: WorkspaceSnapshot,
  +scopeRules: ScopeRules,
  +io?: WriteIO,
  +recoveryRoot?: string,
}): WriteResult {
  if (snapshotHash(snapshot) !== candidate.baseSnapshotHash) {
    throw new Error(
      `Candidate ${candidate.id} is not bound to the given snapshot. ` +
        'Evidence and approval are tied to one snapshot; pass the snapshot ' +
        'returned alongside the candidate.',
    );
  }
  for (const change of candidate.changes) {
    assertSafeRelativePath(change.path);
  }

  const scope = validateScope(changedPaths(candidate), scopeRules);
  if (!scope.ok) {
    return Object.freeze({
      status: 'scope-violation',
      candidateId: candidate.id,
      violations: scope.violations,
    });
  }

  const staleFiles = detectStaleFiles(snapshot);
  if (staleFiles.length > 0) {
    return Object.freeze({
      status: 'stale',
      candidateId: candidate.id,
      staleFiles,
    });
  }

  const resolvedRecoveryRoot =
    recoveryRoot ?? path.join(os.tmpdir(), 'stylex-migrate', 'recovery');
  const recoveryPath = prepareRecovery(
    repositoryRoot,
    candidate,
    resolvedRecoveryRoot,
  );

  const written: Array<string> = [];
  const temporaries: Array<string> = [];
  try {
    for (const change of candidate.changes) {
      if (change.status === 'deleted') {
        continue;
      }
      const absolute = path.join(repositoryRoot, change.path);
      const temporary = `${absolute}${TEMP_SUFFIX}`;
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      temporaries.push(temporary);
      io.writeFileSync(temporary, change.content ?? '');
      io.renameSync(temporary, absolute);
      temporaries.pop();
      written.push(change.path);
    }
    for (const change of candidate.changes) {
      if (change.status !== 'deleted') {
        continue;
      }
      fs.rmSync(path.join(repositoryRoot, change.path), { force: true });
      written.push(change.path);
    }
  } catch (error) {
    for (const temporary of temporaries) {
      fs.rmSync(temporary, { force: true });
    }
    const { restored, unrestored } = restore(
      repositoryRoot,
      recoveryPath,
      written,
    );
    return Object.freeze({
      status: 'failed',
      candidateId: candidate.id,
      error: error instanceof Error ? error.message : String(error),
      restored,
      unrestored,
      recoveryPath,
    });
  }

  return Object.freeze({
    status: 'written',
    candidateId: candidate.id,
    files: Object.freeze(written),
    recoveryPath,
  });
}

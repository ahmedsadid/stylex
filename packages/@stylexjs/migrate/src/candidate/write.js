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
  detectMovedHead,
  detectStaleFiles,
  snapshotHash,
} from '../kernel/snapshot';
import { changedPaths, validateCandidatePatch } from './patch';
import { validateScope } from './scope';
import type { WorkspaceSnapshot } from '../kernel/snapshot';
import type { CandidatePatch } from './patch';
import type { ScopeRules, ScopeViolation } from './scope';

/**
 * Writing a candidate into the accepted source tree.
 *
 * This is the only code in the kit that modifies the user's files, and it is
 * deliberately not part of the package's public surface: reaching it goes
 * through an apply plan, so that state, evidence and approval are checked
 * rather than assumed. See `kernel/applyPlan.js`.
 *
 * The destination is taken from the snapshot rather than accepted as an
 * argument. A separately supplied root would let a candidate verified against
 * one checkout be written into another, which is the precise failure this
 * layer exists to prevent.
 *
 * Before anything is written it refuses when: the candidate is not bound to
 * this snapshot, the repository has moved to a different commit, the patch
 * leaves its allowed paths, or a covered file no longer matches its preimage.
 */

export type WriteIO = {
  +writeFileSync: (
    file: string,
    data: string,
    options?: { +flag?: string },
  ) => void,
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
      +movedHead: string | null,
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

const MODE_BITS: { +[string]: number } = {
  '100644': 0o644,
  '100755': 0o755,
};

export const defaultWriteIO: WriteIO = Object.freeze({
  writeFileSync: (file: string, data: string, options) => {
    fs.writeFileSync(file, data, {
      encoding: 'utf8',
      flag: options?.flag ?? 'w',
    });
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

function isInside(repositoryRoot: string, candidatePath: string): boolean {
  const relative = path.relative(repositoryRoot, candidatePath);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/**
 * Refuse destinations whose existing path components can redirect a write.
 * Lexical `..` checks are not enough: `src/generated -> /tmp/outside` still
 * looks repository-relative while ordinary filesystem calls follow it.
 */
function assertSafeDestination(
  repositoryRoot: string,
  relativePath: string,
): void {
  assertSafeRelativePath(relativePath);
  const absolute = path.join(repositoryRoot, relativePath);
  const parent = path.dirname(absolute);
  let current = repositoryRoot;
  const parentRelative = path.relative(repositoryRoot, parent);
  for (const component of parentRelative.split(path.sep)) {
    if (component === '') {
      continue;
    }
    current = path.join(current, component);
    try {
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink()) {
        throw new Error(
          `Candidate path has a symbolic-link parent: ${relativePath}`,
        );
      }
      if (!stats.isDirectory()) {
        throw new Error(
          `Candidate path has a non-directory parent: ${relativePath}`,
        );
      }
    } catch (error) {
      if (
        error != null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        // The remaining components will be created below a validated ancestor.
        break;
      }
      throw error;
    }
  }

  try {
    if (fs.lstatSync(absolute).isSymbolicLink()) {
      throw new Error(
        `Candidate destination is a symbolic link: ${relativePath}`,
      );
    }
  } catch (error) {
    if (
      error == null ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error;
    }
  }

  if (fs.existsSync(parent)) {
    const resolvedParent = fs.realpathSync(parent);
    if (!isInside(repositoryRoot, resolvedParent)) {
      throw new Error(
        `Candidate destination resolves outside the repository: ${relativePath}`,
      );
    }
  }
}

function temporaryPathFor(absolute: string): string {
  return path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.stylex-migrate-${crypto
      .randomBytes(12)
      .toString('hex')}`,
  );
}

function resultingMode(existing: number | null, candidateMode: string): number {
  if (existing == null) {
    return MODE_BITS[candidateMode] ?? 0o644;
  }
  const executable = candidateMode === '100755' ? 0o111 : 0;
  return (existing & ~0o111) | executable;
}

function existingMode(absolute: string): number | null {
  try {
    const stats = fs.lstatSync(absolute);
    return stats.isFile() ? stats.mode & 0o777 : null;
  } catch (error) {
    return null;
  }
}

function prepareRecovery(
  repositoryRoot: string,
  candidate: CandidatePatch,
  recoveryRoot: string,
): { +recoveryPath: string, +modes: Map<string, number> } {
  const recoveryPath = path.join(recoveryRoot, candidate.id);
  fs.mkdirSync(path.join(recoveryPath, 'originals'), { recursive: true });
  fs.writeFileSync(
    path.join(recoveryPath, 'candidate.patch'),
    candidate.patchText,
    'utf8',
  );

  const modes = new Map<string, number>();
  for (const file of candidate.touchedFiles) {
    const absolute = path.join(repositoryRoot, file);
    const mode = existingMode(absolute);
    if (mode != null) {
      modes.set(file, mode);
      const target = path.join(recoveryPath, 'originals', file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(absolute, target);
      fs.chmodSync(target, mode);
    }
  }

  fs.writeFileSync(
    path.join(recoveryPath, 'manifest.json'),
    JSON.stringify(
      {
        candidateId: candidate.id,
        repositoryRoot,
        baseCommit: candidate.baseCommit,
        baseSnapshotHash: candidate.baseSnapshotHash,
        patchHash: candidate.patchHash,
        touchedFiles: candidate.touchedFiles,
        originalModes: Object.fromEntries(modes),
      },
      null,
      2,
    ),
    'utf8',
  );

  return { recoveryPath, modes };
}

function restore(
  repositoryRoot: string,
  recoveryPath: string,
  files: $ReadOnlyArray<string>,
  modes: Map<string, number>,
): { +restored: $ReadOnlyArray<string>, +unrestored: $ReadOnlyArray<string> } {
  const restored = [];
  const unrestored = [];
  for (const file of files) {
    const absolute = path.join(repositoryRoot, file);
    const original = path.join(recoveryPath, 'originals', file);
    try {
      if (fs.existsSync(original)) {
        fs.copyFileSync(original, absolute);
        const mode = modes.get(file);
        if (mode != null) {
          fs.chmodSync(absolute, mode);
        }
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
  candidate,
  snapshot,
  scopeRules,
  io = defaultWriteIO,
  recoveryRoot,
}: {
  +candidate: CandidatePatch,
  +snapshot: WorkspaceSnapshot,
  +scopeRules: ScopeRules,
  +io?: WriteIO,
  +recoveryRoot?: string,
}): WriteResult {
  const candidateProblem = validateCandidatePatch(candidate, snapshot);
  if (candidateProblem != null) {
    throw new Error(
      `Candidate ${candidate.id} is invalid: ${candidateProblem}`,
    );
  }
  if (snapshotHash(snapshot) !== candidate.baseSnapshotHash) {
    throw new Error(
      `Candidate ${candidate.id} is not bound to the given snapshot. ` +
        'Evidence and approval are tied to one snapshot; pass the snapshot ' +
        'returned alongside the candidate.',
    );
  }
  if (candidate.repositoryRoot !== snapshot.repositoryRoot) {
    throw new Error(
      `Candidate ${candidate.id} was built against ` +
        `${candidate.repositoryRoot}, not ${snapshot.repositoryRoot}.`,
    );
  }
  const repositoryRoot = canonicalRoot(snapshot.repositoryRoot);
  for (const change of candidate.changes) {
    assertSafeDestination(repositoryRoot, change.path);
  }

  const scope = validateScope(changedPaths(candidate), scopeRules);
  if (!scope.ok) {
    return Object.freeze({
      status: 'scope-violation',
      candidateId: candidate.id,
      violations: scope.violations,
    });
  }

  const movedHead = detectMovedHead(snapshot);
  const staleFiles = detectStaleFiles(snapshot);
  if (movedHead != null || staleFiles.length > 0) {
    return Object.freeze({
      status: 'stale',
      candidateId: candidate.id,
      staleFiles,
      movedHead,
    });
  }

  const resolvedRecoveryRoot =
    recoveryRoot ?? path.join(os.tmpdir(), 'stylex-migrate', 'recovery');
  const { recoveryPath, modes } = prepareRecovery(
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
      const temporary = temporaryPathFor(absolute);
      assertSafeDestination(repositoryRoot, change.path);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      // Validate again after creating missing parents. A symlink introduced in
      // an absent component must not turn the temporary write into an escape.
      assertSafeDestination(repositoryRoot, change.path);
      temporaries.push(temporary);
      io.writeFileSync(temporary, change.content ?? '', { flag: 'wx' });
      // An existing file keeps the permissions it already had; a new one takes
      // the mode git recorded for it. Either way the result matches the
      // candidate that was checked.
      const mode = resultingMode(modes.get(change.path) ?? null, change.mode);
      fs.chmodSync(temporary, mode);
      io.renameSync(temporary, absolute);
      temporaries.pop();
      written.push(change.path);
    }
    for (const change of candidate.changes) {
      if (change.status !== 'deleted') {
        continue;
      }
      assertSafeDestination(repositoryRoot, change.path);
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
      modes,
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

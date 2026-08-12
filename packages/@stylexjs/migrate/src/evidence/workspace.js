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
import {
  createCandidateWorkspace,
  materializeFullCheckout,
  removeCandidateWorkspace,
} from '../candidate/workspace';
import { validateCandidatePatch } from '../candidate/patch';
import type { CandidateWorkspace } from '../candidate/workspace';
import type { VerificationCandidate } from './candidates';

const MODES = new Set(['100644', '100755']);

function safeRelative(file: string): boolean {
  return (
    file !== '' &&
    !file.includes('\0') &&
    !path.isAbsolute(file) &&
    file !== '..' &&
    !file.split(/[\\/]/).includes('..')
  );
}

function ensureParent(root: string, file: string): string {
  if (!safeRelative(file)) {
    throw new Error(`Candidate contains an unsafe path: ${file}`);
  }
  const destination = path.join(root, file);
  const relativeParent = path.dirname(file);
  let current = root;
  if (relativeParent !== '.') {
    for (const segment of relativeParent.split('/')) {
      current = path.join(current, segment);
      try {
        const stats = fs.lstatSync(current);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          throw new Error(`Candidate path has an unsafe parent: ${file}`);
        }
      } catch (error) {
        if (
          error != null &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          fs.mkdirSync(current);
          continue;
        }
        throw error;
      }
    }
  }
  try {
    if (fs.lstatSync(destination).isSymbolicLink()) {
      throw new Error(`Candidate destination is a symbolic link: ${file}`);
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
  return destination;
}

export function createVerificationWorkspace({
  records,
  rootDir,
}: {
  +records: $ReadOnlyArray<VerificationCandidate>,
  +rootDir?: string,
}): CandidateWorkspace {
  if (records.length === 0) {
    throw new Error('Verification workspace requires candidates');
  }
  const repositoryRoot = records[0].candidate.repositoryRoot;
  const baseCommit = records[0].candidate.baseCommit;
  const owners = new Map<string, string>();
  for (const record of records) {
    const problem = validateCandidatePatch(record.candidate, record.snapshot);
    if (problem != null) {
      throw new Error(`Invalid candidate ${record.candidate.id}: ${problem}`);
    }
    if (
      record.candidate.repositoryRoot !== repositoryRoot ||
      record.candidate.baseCommit !== baseCommit
    ) {
      throw new Error(
        'Verification candidates must share a repository and base commit',
      );
    }
    for (const file of record.candidate.touchedFiles) {
      const existing = owners.get(file);
      if (existing != null) {
        throw new Error(
          `Candidates ${existing} and ${record.candidate.id} both change ${file}`,
        );
      }
      owners.set(file, record.candidate.id);
    }
  }

  const workspace = createCandidateWorkspace({
    repositoryRoot,
    baseCommit,
    allowedPaths: Object.freeze([...owners.keys()].sort()),
    requireClean: false,
    rootDir,
  });
  try {
    materializeFullCheckout(workspace);
    for (const record of records) {
      for (const change of record.candidate.changes) {
        const destination = ensureParent(workspace.path, change.path);
        if (change.status === 'deleted') {
          fs.unlinkSync(destination);
          continue;
        }
        if (change.content == null || !MODES.has(change.mode)) {
          throw new Error(`Candidate cannot materialize ${change.path}`);
        }
        fs.writeFileSync(destination, change.content, 'utf8');
        fs.chmodSync(destination, change.mode === '100755' ? 0o755 : 0o644);
      }
    }
    return workspace;
  } catch (error) {
    removeCandidateWorkspace(workspace);
    throw error;
  }
}

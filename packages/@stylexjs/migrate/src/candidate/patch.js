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
import { git, extendSnapshot, snapshotHash } from '../kernel/snapshot';
import { hashFields, hashString, shortHash } from '../kernel/hash';
import type { WorkspaceSnapshot } from '../kernel/snapshot';
import type { CandidateWorkspace } from './workspace';
import type { FileChangeStatus } from './scope';

const NUL = String.fromCharCode(0);

export type ProposerKind = 'deterministic' | 'agent' | 'human';

export type Proposer = {
  +kind: ProposerKind,
  +version: string,
  +skillVersion?: string,
};

export type FileChange = {
  +path: string,
  +status: FileChangeStatus,
  // null for a deletion.
  +content: string | null,
  +contentHash: string | null,
};

/**
 * An immutable candidate patch.
 *
 * `id` is derived from the base snapshot and the exact contents produced, so
 * evidence collected for an id can never silently belong to different bytes.
 * Editing a candidate does not exist as an operation: you build a new one, and
 * it gets a new id.
 */
export type CandidatePatch = {
  +id: string,
  +clusterIds: $ReadOnlyArray<string>,
  +baseSnapshotHash: string,
  +baseCommit: string,
  +proposer: Proposer,
  +changes: $ReadOnlyArray<FileChange>,
  +touchedFiles: $ReadOnlyArray<string>,
  +patchHash: string,
  +patchText: string,
  +decisionArtifactHashes: $ReadOnlyArray<string>,
};

function parseNameStatus(raw: string): $ReadOnlyArray<{
  +path: string,
  +status: FileChangeStatus,
}> {
  const parts = raw.split(NUL).filter((part) => part !== '');
  const changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i];
    const filePath = parts[i + 1];
    let status: FileChangeStatus;
    if (code.startsWith('A')) {
      status = 'added';
    } else if (code.startsWith('D')) {
      status = 'deleted';
    } else {
      status = 'modified';
    }
    changes.push({ path: filePath, status });
  }
  return changes;
}

function readWorkspaceFile(workspacePath: string, filePath: string): string {
  const content = fs.readFileSync(path.join(workspacePath, filePath), 'utf8');
  if (content.includes(NUL)) {
    throw new Error(
      `Candidate touches a binary file (${filePath}). The candidate boundary ` +
        'handles text only; exclude it from the allowlist or convert it in a ' +
        'separate, human-reviewed change.',
    );
  }
  return content;
}

/**
 * Build a candidate from whatever a proposer left in its workspace.
 *
 * The returned snapshot is the input snapshot extended with every file the
 * candidate actually touches, so staleness detection later covers the full set
 * of files the write will modify — including files that did not exist when the
 * plan was made.
 */
export function createCandidatePatch({
  workspace,
  snapshot,
  clusterIds = [],
  proposer,
  decisionArtifactHashes = [],
}: {
  +workspace: CandidateWorkspace,
  +snapshot: WorkspaceSnapshot,
  +clusterIds?: $ReadOnlyArray<string>,
  +proposer: Proposer,
  +decisionArtifactHashes?: $ReadOnlyArray<string>,
}): { +candidate: CandidatePatch, +snapshot: WorkspaceSnapshot } {
  // Stage everything so that new and deleted files are visible to `diff`.
  git(workspace.path, ['add', '-A']);
  const nameStatus = git(workspace.path, [
    'diff',
    '--cached',
    '--no-renames',
    '--name-status',
    '-z',
  ]);
  const patchText = git(workspace.path, ['diff', '--cached', '--no-renames']);

  const parsed = [...parseNameStatus(nameStatus)].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  const changes: Array<FileChange> = parsed.map(
    ({ path: filePath, status }) => {
      if (status === 'deleted') {
        return Object.freeze({
          path: filePath,
          status,
          content: null,
          contentHash: null,
        });
      }
      const content = readWorkspaceFile(workspace.path, filePath);
      return Object.freeze({
        path: filePath,
        status,
        content,
        contentHash: hashString(content),
      });
    },
  );

  const touchedFiles = changes.map((change) => change.path);
  const extended = extendSnapshot(snapshot, touchedFiles);
  const baseSnapshotHash = snapshotHash(extended);

  const patchHash = hashFields(
    changes.flatMap((change) => [
      change.status,
      change.path,
      change.contentHash ?? 'deleted',
    ]),
  );

  const candidate: CandidatePatch = Object.freeze({
    id: shortHash(hashFields([baseSnapshotHash, patchHash])),
    clusterIds: Object.freeze([...clusterIds]),
    baseSnapshotHash,
    baseCommit: workspace.baseCommit,
    proposer: Object.freeze({ ...proposer }),
    changes: Object.freeze(changes),
    touchedFiles: Object.freeze(touchedFiles),
    patchHash,
    patchText,
    decisionArtifactHashes: Object.freeze([...decisionArtifactHashes]),
  });

  return Object.freeze({ candidate, snapshot: extended });
}

export function changedPaths(
  candidate: CandidatePatch,
): $ReadOnlyArray<{ +path: string, +status: FileChangeStatus }> {
  return candidate.changes.map((change) => ({
    path: change.path,
    status: change.status,
  }));
}

export function isEmpty(candidate: CandidatePatch): boolean {
  return candidate.changes.length === 0;
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  git,
  gitBuffer,
  extendSnapshot,
  snapshotAssumptionArtifactHashes,
  snapshotDecisionArtifactHashes,
  snapshotHash,
} from '../kernel/snapshot';
import { hashFields, hashString, shortHash } from '../kernel/hash';
import { canonicalJson } from '../state/json';
import type { WorkspaceSnapshot } from '../kernel/snapshot';
import type { CandidateWorkspace } from './workspace';
import type { FileChangeStatus } from './scope';

const NUL = String.fromCharCode(0);

const REGULAR_FILE = '100644';
const EXECUTABLE_FILE = '100755';
const SYMLINK = '120000';
const GITLINK = '160000';
const ABSENT = '000000';

const SUPPORTED_MODES = new Set([REGULAR_FILE, EXECUTABLE_FILE]);

export type ProposerKind = 'deterministic' | 'agent' | 'human';

export type Proposer = {
  +kind: ProposerKind,
  +version: string,
  +skillVersion?: string,
  +name?: string,
  +protocolVersion?: string,
  +taskId?: string,
  +attemptId?: string,
};

export type FileChange = {
  +path: string,
  +status: FileChangeStatus,
  // The git file mode this change results in, e.g. '100644'. Part of the
  // candidate's identity: a file that only changes mode is still a change, and
  // a write that ignored it would not reproduce the candidate.
  +mode: string,
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
  +repositoryRoot: string,
  +proposer: Proposer,
  +changes: $ReadOnlyArray<FileChange>,
  +touchedFiles: $ReadOnlyArray<string>,
  +patchHash: string,
  +patchText: string,
  +decisionArtifactHashes: $ReadOnlyArray<string>,
  +assumptionArtifactHashes: $ReadOnlyArray<string>,
};

export type CandidateResult =
  | { +ok: true, +candidate: CandidatePatch, +snapshot: WorkspaceSnapshot }
  | { +ok: false, +reason: string, +paths: $ReadOnlyArray<string> };

type RawChange = {
  +path: string,
  +status: FileChangeStatus,
  +sourceMode: string,
  +targetMode: string,
  +targetBlob: string,
};

function candidateIdentity({
  baseSnapshotHash,
  patchHash,
  clusterIds,
  proposer,
  decisionArtifactHashes,
  assumptionArtifactHashes,
}: {
  +baseSnapshotHash: string,
  +patchHash: string,
  +clusterIds: $ReadOnlyArray<string>,
  +proposer: Proposer,
  +decisionArtifactHashes: $ReadOnlyArray<string>,
  +assumptionArtifactHashes: $ReadOnlyArray<string>,
}): string {
  return shortHash(
    hashString(
      canonicalJson({
        baseSnapshotHash,
        patchHash,
        clusterIds,
        proposer,
        decisionArtifactHashes,
        assumptionArtifactHashes,
      }),
    ),
  );
}

/**
 * Parse `git diff --cached --raw -z`, which reports both file modes and the
 * staged blob for every change.
 *
 * Modes matter: reading content through the working tree loses the difference
 * between a regular file, an executable and a symlink, and a writer that
 * always produces a regular file would then not reproduce the candidate it
 * claimed to have verified.
 */
function parseRawDiff(
  raw: string,
):
  | { +ok: true, +changes: $ReadOnlyArray<RawChange> }
  | { +ok: false, +reason: string, +paths: $ReadOnlyArray<string> } {
  const parts = raw.split(NUL).filter((part) => part !== '');
  const changes: Array<RawChange> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i];
    const filePath = parts[i + 1];
    if (!meta.startsWith(':')) {
      return {
        ok: false,
        reason: 'could not read the candidate diff',
        paths: [filePath],
      };
    }
    const fields = meta.slice(1).split(' ');
    if (fields.length < 5) {
      return {
        ok: false,
        reason: 'could not read the candidate diff',
        paths: [filePath],
      };
    }
    const [sourceMode, targetMode, , targetBlob, code] = fields;

    let status: FileChangeStatus;
    if (code.startsWith('A')) {
      status = 'added';
    } else if (code.startsWith('D')) {
      status = 'deleted';
    } else if (code.startsWith('M') || code.startsWith('T')) {
      status = 'modified';
    } else {
      return {
        ok: false,
        reason: `unsupported change type "${code}"`,
        paths: [filePath],
      };
    }

    changes.push({
      path: filePath,
      status,
      sourceMode,
      targetMode,
      targetBlob,
    });
  }
  return { ok: true, changes };
}

function rejectUnsupported(change: RawChange): { +reason: string } | null {
  const { sourceMode, targetMode, status, path: filePath } = change;

  if (sourceMode === SYMLINK || targetMode === SYMLINK) {
    return {
      reason:
        `${filePath} is a symbolic link. The writer reproduces regular files ` +
        'only, so a candidate containing one could not be applied exactly as ' +
        'it was checked.',
    };
  }
  if (sourceMode === GITLINK || targetMode === GITLINK) {
    return { reason: `${filePath} is a submodule, which is out of scope` };
  }
  if (status !== 'deleted' && !SUPPORTED_MODES.has(targetMode)) {
    return { reason: `${filePath} has unsupported file mode ${targetMode}` };
  }
  if (
    status === 'modified' &&
    sourceMode !== ABSENT &&
    sourceMode !== targetMode
  ) {
    return {
      reason:
        `${filePath} changes file mode from ${sourceMode} to ${targetMode}. ` +
        'Mode changes are out of scope for the mechanical lane.',
    };
  }
  return null;
}

/**
 * Build a candidate from whatever a proposer left in its workspace.
 *
 * The workspace and the snapshot must describe the same repository at the same
 * commit. Without that, a candidate can be generated against one state and
 * checked against another, and the snapshot's promise to identify "the exact
 * source state" would mean nothing.
 */
export function createCandidatePatch({
  workspace,
  snapshot,
  clusterIds = [],
  proposer,
  decisionArtifactHashes = [],
  assumptionArtifactHashes = [],
  expectedContent,
}: {
  +workspace: CandidateWorkspace,
  +snapshot: WorkspaceSnapshot,
  +clusterIds?: $ReadOnlyArray<string>,
  +proposer: Proposer,
  +decisionArtifactHashes?: $ReadOnlyArray<string>,
  +assumptionArtifactHashes?: $ReadOnlyArray<string>,
  // Repository-relative path to the content hash a verified proposal produced.
  // Supplying it closes the gap between "these bytes were checked" and "these
  // bytes are staged": without it, a candidate can carry evidence for code that
  // is not the code in the workspace. It is mandatory and exact for a
  // deterministic proposer; agent and human candidates use the approval lane.
  +expectedContent?: { +[path: string]: string },
}): CandidateResult {
  const stableDecisions = Object.freeze(
    [...new Set(decisionArtifactHashes)].sort(),
  );
  const snapshotDecisions = snapshotDecisionArtifactHashes(snapshot);
  if (
    stableDecisions.length !== snapshotDecisions.length ||
    stableDecisions.some((value, index) => value !== snapshotDecisions[index])
  ) {
    return {
      ok: false,
      reason:
        'candidate decision artifacts are not bound to the supplied snapshot',
      paths: [],
    };
  }
  const stableAssumptions = Object.freeze(
    [...new Set(assumptionArtifactHashes)].sort(),
  );
  const snapshotAssumptions = snapshotAssumptionArtifactHashes(snapshot);
  if (
    stableAssumptions.length !== snapshotAssumptions.length ||
    stableAssumptions.some(
      (value, index) => value !== snapshotAssumptions[index],
    )
  ) {
    return {
      ok: false,
      reason:
        'candidate test assumptions are not bound to the supplied snapshot',
      paths: [],
    };
  }
  if (workspace.repositoryRoot !== snapshot.repositoryRoot) {
    return {
      ok: false,
      reason:
        'the candidate workspace and the snapshot describe different ' +
        `repositories (${workspace.repositoryRoot} and ${snapshot.repositoryRoot})`,
      paths: [],
    };
  }
  if (workspace.baseCommit !== snapshot.gitCommit) {
    return {
      ok: false,
      reason:
        `the candidate workspace is based on ${workspace.baseCommit} but the ` +
        `snapshot records ${snapshot.gitCommit}`,
      paths: [],
    };
  }
  if (proposer.kind === 'deterministic' && expectedContent == null) {
    return {
      ok: false,
      reason:
        'a deterministic candidate must name the exact content hashes its ' +
        'proposal produced',
      paths: [],
    };
  }

  // Stage everything so that new and deleted files are visible to `diff`.
  git(workspace.path, ['add', '-A']);
  const raw = git(workspace.path, [
    'diff',
    '--cached',
    '--no-renames',
    '--raw',
    '-z',
  ]);
  const patchText = git(workspace.path, ['diff', '--cached', '--no-renames']);

  const parsed = parseRawDiff(raw);
  if (!parsed.ok) {
    return parsed;
  }

  const ordered = [...parsed.changes].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  const changes: Array<FileChange> = [];
  for (const change of ordered) {
    const rejection = rejectUnsupported(change);
    if (rejection != null) {
      return { ok: false, reason: rejection.reason, paths: [change.path] };
    }

    if (change.status === 'deleted') {
      changes.push(
        Object.freeze({
          path: change.path,
          status: change.status,
          mode: change.sourceMode,
          content: null,
          contentHash: null,
        }),
      );
      continue;
    }

    // Read the staged blob rather than the working tree: the blob is what the
    // diff described, and it cannot change under us afterwards.
    const bytes = gitBuffer(workspace.path, [
      'cat-file',
      'blob',
      change.targetBlob,
    ]);
    if (bytes.includes(0)) {
      return {
        ok: false,
        reason:
          `${change.path} is a binary file. The candidate boundary handles ` +
          'text only; exclude it from the allowlist or change it in a ' +
          'separate, human-reviewed commit.',
        paths: [change.path],
      };
    }
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes)) {
      return {
        ok: false,
        reason:
          `${change.path} is not valid UTF-8. The candidate boundary cannot ` +
          'round-trip its bytes exactly, so it must be migrated separately.',
        paths: [change.path],
      };
    }
    changes.push(
      Object.freeze({
        path: change.path,
        status: change.status,
        mode: change.targetMode,
        content,
        contentHash: hashString(content),
      }),
    );
  }

  if (expectedContent != null) {
    const expectedPaths = new Set(Object.keys(expectedContent));
    const byPath = new Map(
      changes.map((change) => [change.path, change.contentHash]),
    );
    for (const file of Object.keys(expectedContent)) {
      const staged = byPath.get(file);
      if (staged == null) {
        return {
          ok: false,
          reason: `the verified proposal changed ${file}, but the candidate does not`,
          paths: [file],
        };
      }
      if (staged !== expectedContent[file]) {
        return {
          ok: false,
          reason:
            `${file} in the workspace is not the content that was checked ` +
            '(the proposal and the candidate disagree)',
          paths: [file],
        };
      }
    }
    for (const change of changes) {
      if (!expectedPaths.has(change.path)) {
        return {
          ok: false,
          reason:
            `${change.path} is an extra candidate change that the verified ` +
            'proposal did not produce',
          paths: [change.path],
        };
      }
    }
  }

  const touchedFiles = changes.map((change) => change.path);
  const extended = extendSnapshot(snapshot, touchedFiles);
  const baseSnapshotHash = snapshotHash(extended);

  const patchHash = hashFields(
    changes.flatMap((change) => [
      change.status,
      change.mode,
      change.path,
      change.contentHash ?? 'deleted',
    ]),
  );

  const stableClusterIds = Object.freeze([...new Set(clusterIds)].sort());
  const stableProposer = Object.freeze({ ...proposer });
  const candidate: CandidatePatch = Object.freeze({
    id: candidateIdentity({
      baseSnapshotHash,
      patchHash,
      clusterIds: stableClusterIds,
      proposer: stableProposer,
      decisionArtifactHashes: stableDecisions,
      assumptionArtifactHashes: stableAssumptions,
    }),
    clusterIds: stableClusterIds,
    baseSnapshotHash,
    baseCommit: workspace.baseCommit,
    repositoryRoot: snapshot.repositoryRoot,
    proposer: stableProposer,
    changes: Object.freeze(changes),
    touchedFiles: Object.freeze(touchedFiles),
    patchHash,
    patchText,
    decisionArtifactHashes: stableDecisions,
    assumptionArtifactHashes: stableAssumptions,
  });

  return Object.freeze({ ok: true, candidate, snapshot: extended });
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

/** Recompute every content-addressed field before evidence or writing. */
export function validateCandidatePatch(
  candidate: CandidatePatch,
  snapshot: WorkspaceSnapshot,
): string | null {
  const expectedSnapshotHash = snapshotHash(snapshot);
  if (candidate.baseSnapshotHash !== expectedSnapshotHash) {
    return 'candidate is not bound to the supplied snapshot';
  }
  if (candidate.repositoryRoot !== snapshot.repositoryRoot) {
    return 'candidate and snapshot describe different repositories';
  }
  if (candidate.baseCommit !== snapshot.gitCommit) {
    return 'candidate and snapshot describe different base commits';
  }
  const snapshotDecisions = snapshotDecisionArtifactHashes(snapshot);
  if (
    candidate.decisionArtifactHashes.length !== snapshotDecisions.length ||
    candidate.decisionArtifactHashes.some(
      (value, index) => value !== snapshotDecisions[index],
    )
  ) {
    return 'candidate decision artifacts are not bound to its snapshot';
  }
  const snapshotAssumptions = snapshotAssumptionArtifactHashes(snapshot);
  if (
    candidate.assumptionArtifactHashes.length !== snapshotAssumptions.length ||
    candidate.assumptionArtifactHashes.some(
      (value, index) => value !== snapshotAssumptions[index],
    )
  ) {
    return 'candidate test assumptions are not bound to its snapshot';
  }
  if (
    candidate.proposer.version === '' ||
    (candidate.proposer.skillVersion != null &&
      candidate.proposer.skillVersion === '')
  ) {
    return 'candidate proposer has no reproducible version';
  }
  for (const values of [
    candidate.clusterIds,
    candidate.decisionArtifactHashes,
    candidate.assumptionArtifactHashes,
  ]) {
    if (
      new Set(values).size !== values.length ||
      values.some((value, index) => index > 0 && values[index - 1] > value)
    ) {
      return 'candidate identity inputs are not canonical';
    }
  }
  for (const change of candidate.changes) {
    const contentHash =
      change.content == null ? null : hashString(change.content);
    if (contentHash !== change.contentHash) {
      return `candidate content hash does not match ${change.path}`;
    }
  }
  const patchHash = hashFields(
    candidate.changes.flatMap((change) => [
      change.status,
      change.mode,
      change.path,
      change.contentHash ?? 'deleted',
    ]),
  );
  if (patchHash !== candidate.patchHash) {
    return 'candidate patch hash does not match its changes';
  }
  const touchedFiles = candidate.changes.map((change) => change.path);
  if (
    touchedFiles.length !== candidate.touchedFiles.length ||
    touchedFiles.some((file, index) => file !== candidate.touchedFiles[index])
  ) {
    return 'candidate touched-file list does not match its changes';
  }
  const id = candidateIdentity({
    baseSnapshotHash: candidate.baseSnapshotHash,
    patchHash,
    clusterIds: candidate.clusterIds,
    proposer: candidate.proposer,
    decisionArtifactHashes: candidate.decisionArtifactHashes,
    assumptionArtifactHashes: candidate.assumptionArtifactHashes,
  });
  return id === candidate.id
    ? null
    : 'candidate id does not match its contents';
}

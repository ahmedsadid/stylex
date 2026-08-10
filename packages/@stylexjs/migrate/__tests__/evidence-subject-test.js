/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  createApplyPlanEvidenceSubject,
  createCandidateEvidenceSubject,
  createCandidatePatch,
  createCandidateWorkspace,
  createSnapshot,
  removeCandidateWorkspace,
} from '../src/index';
import type {
  CandidatePatch,
  CandidateWorkspace,
  WorkspaceSnapshot,
} from '../src/index';
import {
  createTempDir,
  createTempRepo,
  removeTempDir,
  writeFiles,
} from './utils/tempRepo';

describe('M5 exact repository evidence subjects', () => {
  let repo: string;
  let workspaceRoot: string;
  let workspaces: Array<CandidateWorkspace>;

  beforeEach(() => {
    repo = createTempRepo({
      'src/A.js': 'export const A = 1;\n',
      'src/B.js': 'export const B = 1;\n',
    });
    workspaceRoot = createTempDir('stylex-migrate-evidence-subject-');
    workspaces = [];
  });

  afterEach(() => {
    for (const workspace of workspaces) {
      removeCandidateWorkspace(workspace);
    }
    removeTempDir(workspaceRoot);
    removeTempDir(repo);
  });

  function candidate(
    file: string,
    contents: string,
  ): { +candidate: CandidatePatch, +snapshot: WorkspaceSnapshot } {
    const workspace = createCandidateWorkspace({
      repositoryRoot: repo,
      allowedPaths: ['src/**'],
      rootDir: workspaceRoot,
    });
    workspaces.push(workspace);
    writeFiles(workspace.path, { [file]: contents });
    const snapshot = createSnapshot({ repositoryRoot: repo, files: [file] });
    const result = createCandidatePatch({
      workspace,
      snapshot,
      proposer: { kind: 'agent', version: 'test' },
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return { candidate: result.candidate, snapshot: result.snapshot };
  }

  test('candidate identity includes exact source and target bytes', () => {
    const first = candidate('src/A.js', 'export const A = 2;\n');
    const second = candidate('src/A.js', 'export const A = 3;\n');
    const firstSubject = createCandidateEvidenceSubject(first);
    const secondSubject = createCandidateEvidenceSubject(second);

    expect(firstSubject).toMatchObject({
      kind: 'candidate',
      candidateId: first.candidate.id,
      candidateIds: [first.candidate.id],
      changes: [
        {
          path: 'src/A.js',
          sourceHash: first.snapshot.fileHashes['src/A.js'],
          targetHash: first.candidate.changes[0].contentHash,
        },
      ],
    });
    expect(secondSubject.id).not.toBe(firstSubject.id);
  });

  test('apply-plan identity cannot be reused for a subset or superset', () => {
    const first = candidate('src/A.js', 'export const A = 2;\n');
    const second = candidate('src/B.js', 'export const B = 2;\n');
    const subset = createApplyPlanEvidenceSubject([first]);
    const complete = createApplyPlanEvidenceSubject([first, second]);

    expect(complete.candidateIds).toEqual(
      [first.candidate.id, second.candidate.id].sort(),
    );
    expect(complete.id).not.toBe(subset.id);
  });

  test('apply-plan subjects refuse competing change ownership', () => {
    const first = candidate('src/A.js', 'export const A = 2;\n');
    const second = candidate('src/A.js', 'export const A = 3;\n');
    expect(() => createApplyPlanEvidenceSubject([first, second])).toThrow(
      'both change src/A.js',
    );
  });
});

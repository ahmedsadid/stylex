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
import {
  createCandidatePatch,
  createCandidateWorkspace,
  createSnapshot,
  createVerificationWorkspace,
  initializeProject,
  loadVerificationCandidate,
  openProject,
  removeCandidateWorkspace,
  saveVerificationCandidate,
  writeRecord,
} from '../src/index';
import type {
  CandidateWorkspace,
  ProjectState,
  VerificationCandidate,
} from '../src/index';
import {
  createTempDir,
  createTempRepo,
  readFile,
  removeTempDir,
  writeFiles,
} from './utils/tempRepo';

describe('M5 persisted candidates and verification workspaces', () => {
  let repo: string;
  let project: ProjectState;
  let workspaceRoot: string;
  let workspaces: Array<CandidateWorkspace>;

  beforeEach(() => {
    repo = createTempRepo({
      'src/A.js': 'export const A = 1;\n',
      'src/B.js': 'export const B = 1;\n',
      'build/tool.js': 'export const build = true;\n',
    });
    project = initializeProject({ repositoryRoot: repo });
    workspaceRoot = createTempDir('stylex-migrate-verification-');
    workspaces = [];
  });

  afterEach(() => {
    for (const workspace of workspaces) {
      removeCandidateWorkspace(workspace);
    }
    removeTempDir(workspaceRoot);
    removeTempDir(repo);
  });

  function candidate(file: string, content: string): VerificationCandidate {
    const workspace = createCandidateWorkspace({
      repositoryRoot: repo,
      allowedPaths: ['src/**'],
      rootDir: workspaceRoot,
    });
    workspaces.push(workspace);
    writeFiles(workspace.path, { [file]: content });
    const snapshot = createSnapshot({ repositoryRoot: repo, files: [file] });
    const result = createCandidatePatch({
      workspace,
      snapshot,
      proposer: { kind: 'agent', version: 'fixture-v1' },
      clusterIds: [`cluster-${path.basename(file)}`],
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return {
      candidate: result.candidate,
      snapshot: result.snapshot,
      classification: 'repeatable-contextual',
      siteIdsByFile: { [file]: [`site-${path.basename(file)}`] },
      staticEvidence: [],
    };
  }

  test('candidate records survive reopen and retain their exact snapshot', () => {
    const record = candidate('src/A.js', 'export const A = 2;\n');
    saveVerificationCandidate(project, record);
    const loaded = loadVerificationCandidate(
      openProject(repo),
      record.candidate.id,
    );
    expect(loaded).toEqual({
      ...record,
      siteIdsByFile: { 'src/A.js': ['site-A.js'] },
      staticEvidence: [],
    });
    if (loaded == null) {
      throw new Error('candidate was not persisted');
    }
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  test('verification materializes a non-conflicting candidate set outside the source tree', () => {
    const first = candidate('src/A.js', 'export const A = 2;\n');
    const second = candidate('src/B.js', 'export const B = 2;\n');
    const verification = createVerificationWorkspace({
      records: [first, second],
      rootDir: workspaceRoot,
    });
    workspaces.push(verification);

    expect(readFile(verification.path, 'src/A.js')).toBe(
      'export const A = 2;\n',
    );
    expect(readFile(verification.path, 'src/B.js')).toBe(
      'export const B = 2;\n',
    );
    expect(readFile(repo, 'src/A.js')).toBe('export const A = 1;\n');
    expect(readFile(repo, 'src/B.js')).toBe('export const B = 1;\n');
  });

  test('verification materializes identical shared outputs once', () => {
    const first = candidate('src/A.js', 'export const A = 2;\n');
    const second = candidate('src/A.js', 'export const A = 2;\n');
    const verification = createVerificationWorkspace({
      records: [first, second],
      rootDir: workspaceRoot,
    });
    workspaces.push(verification);
    expect(readFile(verification.path, 'src/A.js')).toBe(
      'export const A = 2;\n',
    );
  });

  test('verification expands sparse repositories for real build evidence', () => {
    execFileSync('git', ['sparse-checkout', 'set', 'src'], {
      cwd: repo,
      stdio: 'pipe',
    });
    expect(fs.existsSync(path.join(repo, 'build/tool.js'))).toBe(false);
    const record = candidate('src/A.js', 'export const A = 2;\n');
    const verification = createVerificationWorkspace({
      records: [record],
      rootDir: workspaceRoot,
    });
    workspaces.push(verification);

    expect(readFile(verification.path, 'build/tool.js')).toBe(
      'export const build = true;\n',
    );
    expect(readFile(verification.path, 'src/A.js')).toBe(
      'export const A = 2;\n',
    );
  });

  test('persisted candidate identity is checked again when loaded', () => {
    const record = candidate('src/A.js', 'export const A = 2;\n');
    writeRecord(project, 'candidates', record.candidate.id, {
      kind: 'verification-candidate',
      ...record,
      candidate: { ...record.candidate, patchHash: 'tampered' },
    } as $FlowFixMe);
    expect(() =>
      loadVerificationCandidate(project, record.candidate.id),
    ).toThrow('candidate patch hash does not match');
  });

  test('verification refuses conflicting candidate writers', () => {
    const first = candidate('src/A.js', 'export const A = 2;\n');
    const second = candidate('src/A.js', 'export const A = 3;\n');
    expect(() =>
      createVerificationWorkspace({
        records: [first, second],
        rootDir: workspaceRoot,
      }),
    ).toThrow('conflict on src/A.js');
    expect(fs.readdirSync(workspaceRoot).length).toBe(workspaces.length);
  });
});

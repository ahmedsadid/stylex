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
  createCandidatePatch,
  createCandidateWorkspace,
  createSnapshot,
  removeCandidateWorkspace,
  transition,
  writeCandidate,
} from '../src/index';
import type {
  CandidateWorkspace,
  Proposer,
  WorkspaceSnapshot,
} from '../src/index';
import {
  createTempDir,
  createTempRepo,
  readFile,
  removeTempDir,
  writeFiles,
} from './utils/tempRepo';

const PROPOSER: Proposer = { kind: 'agent', version: 'test-1' };

const INITIAL: { +[path: string]: string } = {
  'src/Button.js': 'export const Button = 1;\n',
  'src/Card.js': 'export const Card = 2;\n',
  'src/Chip.js': 'export const Chip = 3;\n',
  'README.md': '# project\n',
};

describe('the candidate boundary', () => {
  let repo: string;
  let recoveryRoot: string;
  let workspaceRoot: string;
  let workspaces: Array<CandidateWorkspace> = [];

  beforeEach(() => {
    repo = createTempRepo(INITIAL);
    recoveryRoot = createTempDir('stylex-migrate-recovery-');
    workspaceRoot = createTempDir('stylex-migrate-ws-');
    workspaces = [];
  });

  afterEach(() => {
    for (const workspace of workspaces) {
      try {
        removeCandidateWorkspace(workspace);
      } catch (error) {
        // The repository is about to be deleted anyway.
      }
    }
    removeTempDir(repo);
    removeTempDir(recoveryRoot);
    removeTempDir(workspaceRoot);
  });

  function openWorkspace(
    allowedPaths: $ReadOnlyArray<string>,
  ): CandidateWorkspace {
    const workspace = createCandidateWorkspace({
      repositoryRoot: repo,
      allowedPaths,
      rootDir: workspaceRoot,
    });
    workspaces.push(workspace);
    return workspace;
  }

  function propose(
    workspace: CandidateWorkspace,
    files: $ReadOnlyArray<string>,
  ) {
    const snapshot = createSnapshot({ repositoryRoot: repo, files });
    return createCandidatePatch({ workspace, snapshot, proposer: PROPOSER });
  }

  test('a candidate is written only as the exact bytes that were verified', () => {
    const workspace = openWorkspace(['src/**']);
    writeFiles(workspace.path, {
      'src/Button.js': 'export const Button = 42;\n',
    });

    const { candidate, snapshot } = propose(workspace, ['src/Button.js']);
    expect(candidate.touchedFiles).toEqual(['src/Button.js']);
    expect(candidate.changes[0].status).toBe('modified');

    const result = writeCandidate({
      repositoryRoot: repo,
      candidate,
      snapshot,
      scopeRules: { allowedPaths: ['src/**'] },
      recoveryRoot,
    });

    expect(result.status).toBe('written');
    expect(readFile(repo, 'src/Button.js')).toBe('export const Button = 42;\n');
  });

  test('a no-op candidate traverses the lifecycle and changes nothing', () => {
    const workspace = openWorkspace(['src/**']);
    const { candidate, snapshot } = propose(workspace, ['src/Button.js']);

    expect(candidate.changes).toEqual([]);

    let state = transition('planned', 'candidate-created', 'proposer');
    state = transition(state, 'evidence-collected', 'kernel');
    state = transition(state, 'eligible-for-review', 'kernel');
    state = transition(state, 'approved', 'human');
    state = transition(state, 'write-ready', 'kernel');

    const result = writeCandidate({
      repositoryRoot: repo,
      candidate,
      snapshot,
      scopeRules: { allowedPaths: ['src/**'] },
      recoveryRoot,
    });
    expect(result.status).toBe('written');

    state = transition(state, 'committed', 'kernel');
    expect(state).toBe('committed');
    expect(readFile(repo, 'src/Button.js')).toBe(INITIAL['src/Button.js']);
  });

  test('an edit outside the allowlist is rejected on the patch, not on trust', () => {
    const workspace = openWorkspace(['src/**']);
    writeFiles(workspace.path, {
      'src/Button.js': 'export const Button = 42;\n',
      'README.md': '# owned by someone else\n',
    });

    const { candidate, snapshot } = propose(workspace, ['src/Button.js']);
    const result = writeCandidate({
      repositoryRoot: repo,
      candidate,
      snapshot,
      scopeRules: { allowedPaths: ['src/**'] },
      recoveryRoot,
    });

    expect(result.status).toBe('scope-violation');
    if (result.status === 'scope-violation') {
      expect(result.violations).toEqual([
        { path: 'README.md', reason: 'outside-allowlist' },
      ]);
    }
    // Nothing at all was written, including the in-scope file.
    expect(readFile(repo, 'src/Button.js')).toBe(INITIAL['src/Button.js']);
  });

  test('a source edit after verification makes the candidate stale', () => {
    const workspace = openWorkspace(['src/**']);
    writeFiles(workspace.path, {
      'src/Button.js': 'export const Button = 42;\n',
    });
    const { candidate, snapshot } = propose(workspace, ['src/Button.js']);

    // Somebody edits the accepted tree between verification and write.
    writeFiles(repo, { 'src/Button.js': 'export const Button = 7; // mine\n' });

    const result = writeCandidate({
      repositoryRoot: repo,
      candidate,
      snapshot,
      scopeRules: { allowedPaths: ['src/**'] },
      recoveryRoot,
    });

    expect(result.status).toBe('stale');
    if (result.status === 'stale') {
      expect(result.staleFiles).toEqual(['src/Button.js']);
    }
    expect(readFile(repo, 'src/Button.js')).toBe(
      'export const Button = 7; // mine\n',
    );
  });

  test('a candidate that adds a file goes stale if that path appears meanwhile', () => {
    const workspace = openWorkspace(['src/**']);
    writeFiles(workspace.path, { 'src/New.js': 'export const New = 1;\n' });
    const { candidate, snapshot } = propose(workspace, ['src/Button.js']);
    expect(candidate.changes[0].status).toBe('added');

    writeFiles(repo, { 'src/New.js': 'export const Mine = 1;\n' });

    const result = writeCandidate({
      repositoryRoot: repo,
      candidate,
      snapshot,
      scopeRules: { allowedPaths: ['src/**'] },
      recoveryRoot,
    });

    expect(result.status).toBe('stale');
    expect(readFile(repo, 'src/New.js')).toBe('export const Mine = 1;\n');
  });

  test('a failure part-way through a multi-file write restores the originals', () => {
    const workspace = openWorkspace(['src/**']);
    writeFiles(workspace.path, {
      'src/Button.js': 'export const Button = 42;\n',
      'src/Card.js': 'export const Card = 42;\n',
      'src/Chip.js': 'export const Chip = 42;\n',
    });
    const { candidate, snapshot } = propose(workspace, [
      'src/Button.js',
      'src/Card.js',
      'src/Chip.js',
    ]);
    expect(candidate.touchedFiles).toHaveLength(3);

    let renames = 0;
    const failingIO = {
      writeFileSync: (file: string, data: string) => {
        fs.writeFileSync(file, data, 'utf8');
      },
      renameSync: (from: string, to: string) => {
        renames += 1;
        if (renames === 2) {
          throw new Error('simulated disk failure');
        }
        fs.renameSync(from, to);
      },
    };

    const result = writeCandidate({
      repositoryRoot: repo,
      candidate,
      snapshot,
      scopeRules: { allowedPaths: ['src/**'] },
      io: failingIO,
      recoveryRoot,
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('simulated disk failure');
      expect(result.restored).toEqual(['src/Button.js']);
      expect(result.unrestored).toEqual([]);
      expect(
        fs.existsSync(path.join(result.recoveryPath, 'candidate.patch')),
      ).toBe(true);
    }

    // Every file is back to its original content.
    for (const file of ['src/Button.js', 'src/Card.js', 'src/Chip.js']) {
      expect(readFile(repo, file)).toBe(INITIAL[file]);
    }
    // No temporary files were left behind.
    expect(
      fs
        .readdirSync(path.join(repo, 'src'))
        .filter((name) => name.includes('tmp')),
    ).toEqual([]);
  });

  test('a candidate is immutable, and editing the workspace makes a new one', () => {
    const workspace = openWorkspace(['src/**']);
    writeFiles(workspace.path, {
      'src/Button.js': 'export const Button = 42;\n',
    });
    const first = propose(workspace, ['src/Button.js']).candidate;

    expect(() => {
      // $FlowExpectedError[cannot-write] - the point of the test
      first.id = 'tampered';
    }).toThrow();

    writeFiles(workspace.path, {
      'src/Button.js': 'export const Button = 43;\n',
    });
    const second = propose(workspace, ['src/Button.js']).candidate;

    expect(second.id).not.toBe(first.id);
    expect(second.patchHash).not.toBe(first.patchHash);
  });

  test('the same bytes on the same base always produce the same id', () => {
    const first = (() => {
      const workspace = openWorkspace(['src/**']);
      writeFiles(workspace.path, {
        'src/Button.js': 'export const Button = 42;\n',
      });
      return propose(workspace, ['src/Button.js']).candidate;
    })();
    const second = (() => {
      const workspace = openWorkspace(['src/**']);
      writeFiles(workspace.path, {
        'src/Button.js': 'export const Button = 42;\n',
      });
      return propose(workspace, ['src/Button.js']).candidate;
    })();

    expect(second.id).toBe(first.id);
  });

  test('a candidate bound to a different snapshot is refused outright', () => {
    const workspace = openWorkspace(['src/**']);
    writeFiles(workspace.path, {
      'src/Button.js': 'export const Button = 42;\n',
    });
    const { candidate } = propose(workspace, ['src/Button.js']);
    const unrelated: WorkspaceSnapshot = createSnapshot({
      repositoryRoot: repo,
      files: ['README.md'],
    });

    expect(() =>
      writeCandidate({
        repositoryRoot: repo,
        candidate,
        snapshot: unrelated,
        scopeRules: { allowedPaths: ['src/**'] },
        recoveryRoot,
      }),
    ).toThrow('not bound to the given snapshot');
  });

  test('a binary file in a candidate is refused with an actionable message', () => {
    const workspace = openWorkspace(['src/**']);
    fs.writeFileSync(
      path.join(workspace.path, 'src/logo.bin'),
      Buffer.from([0x00, 0x01, 0x02]),
    );

    expect(() => propose(workspace, ['src/Button.js'])).toThrow('binary file');
  });

  test('a clean worktree is required before a workspace is created', () => {
    writeFiles(repo, { 'src/Button.js': 'export const Button = 99;\n' });
    expect(() =>
      createCandidateWorkspace({
        repositoryRoot: repo,
        allowedPaths: ['src/**'],
        rootDir: workspaceRoot,
      }),
    ).toThrow('uncommitted changes');
  });
});

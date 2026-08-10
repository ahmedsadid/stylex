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
  approve,
  bundleEvidence,
  createCandidatePatch,
  createCandidateWorkspace,
  createSnapshot,
  hashString,
  makeEvidence,
  removeCandidateWorkspace,
  transition,
  writeCommitPlan,
} from '../src/index';
import { writeCandidate } from '../src/candidate/write';
import type {
  CandidatePatch,
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

const SUBJECT = { sourceHash: 'source-hash', targetHash: 'target-hash' };

const PASSING_EVIDENCE = [
  makeEvidence({
    check: 'test-only',
    provider: 'stylex-migrate',
    providerVersion: 'test',
    subject: SUBJECT,
    scope: ['test'],
    result: 'pass',
  }),
];

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
    repositoryRoot?: string,
  ): CandidateWorkspace {
    const workspace = createCandidateWorkspace({
      repositoryRoot: repositoryRoot ?? repo,
      allowedPaths,
      rootDir: workspaceRoot,
    });
    workspaces.push(workspace);
    return workspace;
  }

  function propose(
    workspace: CandidateWorkspace,
    files: $ReadOnlyArray<string>,
    repositoryRoot?: string,
  ) {
    const snapshot = createSnapshot({
      repositoryRoot: repositoryRoot ?? repo,
      files,
    });
    const result = createCandidatePatch({
      workspace,
      snapshot,
      proposer: PROPOSER,
    });
    if (!result.ok) {
      throw new Error(`expected a candidate, got refusal: ${result.reason}`);
    }
    return result;
  }

  function write(
    candidate: CandidatePatch,
    snapshot: WorkspaceSnapshot,
    allowedPaths: $ReadOnlyArray<string> = ['src/**'],
  ) {
    return writeCandidate({
      candidate,
      snapshot,
      scopeRules: { allowedPaths },
      recoveryRoot,
    });
  }

  test('a candidate is written only as the exact bytes that were verified', () => {
    const workspace = openWorkspace(['src/**']);
    writeFiles(workspace.path, {
      'src/Button.js': 'export const Button = 42;\n',
    });

    const { candidate, snapshot } = propose(workspace, ['src/Button.js']);
    expect(candidate.touchedFiles).toEqual(['src/Button.js']);
    expect(candidate.changes[0].status).toBe('modified');
    expect(candidate.changes[0].mode).toBe('100644');

    expect(write(candidate, snapshot).status).toBe('written');
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

    expect(write(candidate, snapshot).status).toBe('written');

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
    const result = write(candidate, snapshot);

    expect(result.status).toBe('scope-violation');
    if (result.status === 'scope-violation') {
      expect(result.violations).toEqual([
        { path: 'README.md', reason: 'outside-allowlist' },
      ]);
    }
    expect(readFile(repo, 'src/Button.js')).toBe(INITIAL['src/Button.js']);
  });

  test('a source edit after verification makes the candidate stale', () => {
    const workspace = openWorkspace(['src/**']);
    writeFiles(workspace.path, {
      'src/Button.js': 'export const Button = 42;\n',
    });
    const { candidate, snapshot } = propose(workspace, ['src/Button.js']);

    writeFiles(repo, { 'src/Button.js': 'export const Button = 7; // mine\n' });

    const result = write(candidate, snapshot);
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

    expect(write(candidate, snapshot).status).toBe('stale');
    expect(readFile(repo, 'src/New.js')).toBe('export const Mine = 1;\n');
  });

  /**
   * The preimage for a file the plan did not name has to be its content at the
   * base commit. Reading it from the working tree at candidate-creation time
   * would record a concurrent edit as the proposer's starting point, and the
   * user's work would then be overwritten without ever looking stale.
   */
  test('a file touched outside the original plan still detects a concurrent edit', () => {
    const workspace = openWorkspace(['src/**']);
    writeFiles(workspace.path, { 'src/Card.js': 'export const Card = 42;\n' });

    // The user edits Card.js before the candidate is even built.
    writeFiles(repo, { 'src/Card.js': 'export const Card = 99; // mine\n' });

    // The snapshot only ever knew about Button.js.
    const { candidate, snapshot } = propose(workspace, ['src/Button.js']);
    expect(candidate.touchedFiles).toEqual(['src/Card.js']);

    const result = write(candidate, snapshot);
    expect(result.status).toBe('stale');
    if (result.status === 'stale') {
      expect(result.staleFiles).toEqual(['src/Card.js']);
    }
    expect(readFile(repo, 'src/Card.js')).toBe(
      'export const Card = 99; // mine\n',
    );
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

    for (const file of ['src/Button.js', 'src/Card.js', 'src/Chip.js']) {
      expect(readFile(repo, file)).toBe(INITIAL[file]);
    }
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
    const build = () => {
      const workspace = openWorkspace(['src/**']);
      writeFiles(workspace.path, {
        'src/Button.js': 'export const Button = 42;\n',
      });
      return propose(workspace, ['src/Button.js']).candidate;
    };
    expect(build().id).toBe(build().id);
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

    expect(() => write(candidate, unrelated)).toThrow(
      'not bound to the given snapshot',
    );
  });

  test('a binary file in a candidate is refused with an actionable message', () => {
    const workspace = openWorkspace(['src/**']);
    fs.writeFileSync(
      path.join(workspace.path, 'src/logo.bin'),
      Buffer.from([0x00, 0x01, 0x02]),
    );

    const snapshot = createSnapshot({
      repositoryRoot: repo,
      files: ['src/Button.js'],
    });
    const result = createCandidatePatch({
      workspace,
      snapshot,
      proposer: PROPOSER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('binary file');
    }
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

  describe('binding a candidate to one repository at one commit', () => {
    test('a candidate cannot be written into a different repository', () => {
      const other = createTempRepo(INITIAL);
      try {
        const workspace = openWorkspace(['src/**']);
        writeFiles(workspace.path, {
          'src/Button.js': 'export const Button = 42;\n',
        });
        const { candidate } = propose(workspace, ['src/Button.js']);
        const otherSnapshot = createSnapshot({
          repositoryRoot: other,
          files: ['src/Button.js'],
        });

        // There is no argument that could aim this at another checkout: the
        // destination comes from the snapshot, and the candidate must match it.
        expect(() => write(candidate, otherSnapshot)).toThrow();
        expect(readFile(other, 'src/Button.js')).toBe(INITIAL['src/Button.js']);
      } finally {
        removeTempDir(other);
      }
    });

    test('a workspace based on a different commit is refused', () => {
      const first = createSnapshot({
        repositoryRoot: repo,
        files: ['src/Button.js'],
      });
      const workspace = openWorkspace(['src/**']);

      // Advance the repository, then snapshot the newer state.
      writeFiles(repo, { 'src/Card.js': 'export const Card = 20;\n' });
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['commit', '--quiet', '--no-verify', '-m', 'move'], {
        cwd: repo,
      });
      const second = createSnapshot({
        repositoryRoot: repo,
        files: ['src/Button.js'],
      });
      expect(second.gitCommit).not.toBe(first.gitCommit);

      writeFiles(workspace.path, {
        'src/Button.js': 'export const Button = 42;\n',
      });
      const result = createCandidatePatch({
        workspace,
        snapshot: second,
        proposer: PROPOSER,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('is based on');
      }
    });

    test('advancing HEAD after verification makes the candidate stale', () => {
      const workspace = openWorkspace(['src/**']);
      writeFiles(workspace.path, {
        'src/Button.js': 'export const Button = 42;\n',
      });
      const { candidate, snapshot } = propose(workspace, ['src/Button.js']);

      // A dependency the snapshot never listed is changed and committed.
      writeFiles(repo, { 'src/Chip.js': 'export const Chip = 30;\n' });
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['commit', '--quiet', '--no-verify', '-m', 'dep'], {
        cwd: repo,
      });

      const result = write(candidate, snapshot);
      expect(result.status).toBe('stale');
      if (result.status === 'stale') {
        expect(result.movedHead).not.toBeNull();
      }
      expect(readFile(repo, 'src/Button.js')).toBe(INITIAL['src/Button.js']);
    });
  });

  describe('file kinds the writer cannot reproduce', () => {
    test('a symbolic link is refused', () => {
      const workspace = openWorkspace(['src/**']);
      fs.symlinkSync('Button.js', path.join(workspace.path, 'src/Link.js'));

      const snapshot = createSnapshot({
        repositoryRoot: repo,
        files: ['src/Button.js'],
      });
      const result = createCandidatePatch({
        workspace,
        snapshot,
        proposer: PROPOSER,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('symbolic link');
      }
    });

    test('a mode change is refused', () => {
      const workspace = openWorkspace(['src/**']);
      fs.chmodSync(path.join(workspace.path, 'src/Button.js'), 0o755);

      const snapshot = createSnapshot({
        repositoryRoot: repo,
        files: ['src/Button.js'],
      });
      const result = createCandidatePatch({
        workspace,
        snapshot,
        proposer: PROPOSER,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('file mode');
      }
    });

    test('an added executable keeps its mode when written', () => {
      const workspace = openWorkspace(['src/**']);
      const script = path.join(workspace.path, 'src/tool.js');
      fs.writeFileSync(script, '#!/usr/bin/env node\n', 'utf8');
      fs.chmodSync(script, 0o755);

      const { candidate, snapshot } = propose(workspace, ['src/Button.js']);
      expect(candidate.changes[0].mode).toBe('100755');
      expect(write(candidate, snapshot).status).toBe('written');

      const mode = fs.statSync(path.join(repo, 'src/tool.js')).mode & 0o777;
      expect(mode & 0o111).not.toBe(0);
    });

    test('replacing content preserves the permissions the file already had', () => {
      fs.chmodSync(path.join(repo, 'src/Button.js'), 0o640);
      const workspace = openWorkspace(['src/**']);
      writeFiles(workspace.path, {
        'src/Button.js': 'export const Button = 42;\n',
      });
      const { candidate, snapshot } = propose(workspace, ['src/Button.js']);

      expect(write(candidate, snapshot).status).toBe('written');
      expect(fs.statSync(path.join(repo, 'src/Button.js')).mode & 0o777).toBe(
        0o640,
      );
    });
  });

  /**
   * Evidence is collected on a proposal's bytes; a candidate is built from a
   * workspace. Nothing links the two unless the candidate is required to
   * contain the content that was checked.
   */
  describe('binding a verified proposal to a candidate', () => {
    test('a candidate whose content matches the proposal is accepted', () => {
      const workspace = openWorkspace(['src/**']);
      const verified = 'export const Button = 42;\n';
      writeFiles(workspace.path, { 'src/Button.js': verified });

      const snapshot = createSnapshot({
        repositoryRoot: repo,
        files: ['src/Button.js'],
      });
      const result = createCandidatePatch({
        workspace,
        snapshot,
        proposer: PROPOSER,
        expectedContent: { 'src/Button.js': hashString(verified) },
      });
      expect(result.ok).toBe(true);
    });

    test('a workspace edited after verification is refused', () => {
      const workspace = openWorkspace(['src/**']);
      const verified = 'export const Button = 42;\n';
      // What actually ended up in the workspace is not what was checked.
      writeFiles(workspace.path, {
        'src/Button.js': 'export const Button = 43;\n',
      });

      const snapshot = createSnapshot({
        repositoryRoot: repo,
        files: ['src/Button.js'],
      });
      const result = createCandidatePatch({
        workspace,
        snapshot,
        proposer: PROPOSER,
        expectedContent: { 'src/Button.js': hashString(verified) },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('not the content that was checked');
      }
    });

    test('a proposal whose file the candidate never touched is refused', () => {
      const workspace = openWorkspace(['src/**']);
      writeFiles(workspace.path, {
        'src/Button.js': 'export const Button = 42;\n',
      });

      const snapshot = createSnapshot({
        repositoryRoot: repo,
        files: ['src/Button.js'],
      });
      const result = createCandidatePatch({
        workspace,
        snapshot,
        proposer: PROPOSER,
        expectedContent: { 'src/Card.js': hashString('anything') },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('but the candidate does not');
      }
    });
  });

  describe('the commit plan', () => {
    // The value distinguishes otherwise identical plans. Two candidates built
    // from the same bytes on the same base are the same candidate and share an
    // id, which is the point of content addressing — so a test about mismatched
    // ids has to produce genuinely different content.
    function planFor(
      value: number = 42,
      allowedPaths: $ReadOnlyArray<string> = ['src/**'],
    ) {
      const workspace = openWorkspace(allowedPaths);
      writeFiles(workspace.path, {
        'src/Button.js': `export const Button = ${value};\n`,
      });
      const { candidate, snapshot } = propose(workspace, ['src/Button.js']);
      return { candidate, snapshot, scopeRules: { allowedPaths } };
    }

    test('an approved candidate with passing evidence is committed', () => {
      const { candidate, snapshot, scopeRules } = planFor();
      const result = writeCommitPlan(
        {
          entries: [
            {
              candidate,
              snapshot,
              scopeRules,
              evidence: bundleEvidence(candidate, PASSING_EVIDENCE),
              approval: approve({ candidate, approvedBy: 'tester' }),
            },
          ],
        },
        { recoveryRoot },
      );
      expect(result.status).toBe('committed');
      expect(readFile(repo, 'src/Button.js')).toBe(
        'export const Button = 42;\n',
      );
    });

    test('evidence belonging to another candidate is rejected', () => {
      const first = planFor(42);
      const second = planFor(43);
      expect(second.candidate.id).not.toBe(first.candidate.id);
      const result = writeCommitPlan(
        {
          entries: [
            {
              ...first,
              evidence: bundleEvidence(second.candidate, PASSING_EVIDENCE),
              approval: approve({
                candidate: first.candidate,
                approvedBy: 'tester',
              }),
            },
          ],
        },
        { recoveryRoot },
      );
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toContain('evidence belongs to candidate');
      }
      expect(readFile(repo, 'src/Button.js')).toBe(INITIAL['src/Button.js']);
    });

    test('an approval naming another candidate is rejected', () => {
      const first = planFor(42);
      const second = planFor(43);
      expect(second.candidate.id).not.toBe(first.candidate.id);
      const result = writeCommitPlan(
        {
          entries: [
            {
              ...first,
              evidence: bundleEvidence(first.candidate, PASSING_EVIDENCE),
              approval: approve({
                candidate: second.candidate,
                approvedBy: 'tester',
              }),
            },
          ],
        },
        { recoveryRoot },
      );
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toContain('approval names candidate');
      }
      expect(readFile(repo, 'src/Button.js')).toBe(INITIAL['src/Button.js']);
    });

    test('failing evidence is rejected before anything is written', () => {
      const { candidate, snapshot, scopeRules } = planFor();
      const failing = [
        makeEvidence({
          check: 'test-only',
          provider: 'stylex-migrate',
          providerVersion: 'test',
          subject: SUBJECT,
          scope: ['test'],
          result: 'fail',
        }),
      ];
      const result = writeCommitPlan(
        {
          entries: [
            {
              candidate,
              snapshot,
              scopeRules,
              evidence: bundleEvidence(candidate, failing),
              approval: approve({ candidate, approvedBy: 'tester' }),
            },
          ],
        },
        { recoveryRoot },
      );
      expect(result.status).toBe('rejected');
      expect(readFile(repo, 'src/Button.js')).toBe(INITIAL['src/Button.js']);
    });

    test('a candidate with no evidence at all is rejected', () => {
      const { candidate, snapshot, scopeRules } = planFor();
      const result = writeCommitPlan(
        {
          entries: [
            {
              candidate,
              snapshot,
              scopeRules,
              evidence: bundleEvidence(candidate, []),
              approval: approve({ candidate, approvedBy: 'tester' }),
            },
          ],
        },
        { recoveryRoot },
      );
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toContain('no evidence');
      }
    });

    test('two candidates changing the same file are rejected as a conflict', () => {
      const first = planFor(42);
      const second = planFor(43);
      const result = writeCommitPlan(
        {
          entries: [first, second].map((entry) => ({
            ...entry,
            evidence: bundleEvidence(entry.candidate, PASSING_EVIDENCE),
            approval: approve({
              candidate: entry.candidate,
              approvedBy: 'tester',
            }),
          })),
        },
        { recoveryRoot },
      );
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toContain('both change');
      }
      expect(readFile(repo, 'src/Button.js')).toBe(INITIAL['src/Button.js']);
    });
  });
});

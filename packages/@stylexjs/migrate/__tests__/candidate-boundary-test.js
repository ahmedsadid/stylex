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
  proposeStaticConversion,
  removeCandidateWorkspace,
  transition,
  applyPlan,
  snapshotHash,
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

function passingEvidence(
  candidate: CandidatePatch,
  snapshot: WorkspaceSnapshot,
) {
  const change = candidate.changes[0];
  const subject = {
    file: change.path,
    sourceHash: snapshot.fileHashes[change.path] ?? null,
    targetHash: change.contentHash,
  };
  return [
    ['stylex-plugin-transform', '@stylexjs/babel-plugin'],
    ['stylex-lint', '@stylexjs/eslint-plugin'],
    ['binding-integrity', 'stylex-migrate'],
    ['static-css-comparison', 'stylex-migrate'],
  ].map(([check, provider]) =>
    makeEvidence({
      check,
      provider,
      providerVersion: 'test',
      subject:
        check === 'static-css-comparison'
          ? { ...subject, model: 'static-css-v3' }
          : subject,
      scope: [change.path],
      result: 'pass',
    }),
  );
}

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

  test('candidate identity includes proposer policy and cluster ownership', () => {
    function build(
      proposer: Proposer,
      clusterIds: $ReadOnlyArray<string>,
    ): string {
      const workspace = openWorkspace(['src/**']);
      const contents = 'export const Button = 42;\n';
      writeFiles(workspace.path, { 'src/Button.js': contents });
      const snapshot = createSnapshot({
        repositoryRoot: repo,
        files: ['src/Button.js'],
      });
      const result = createCandidatePatch({
        workspace,
        snapshot,
        proposer,
        clusterIds,
        ...(proposer.kind === 'deterministic'
          ? { expectedContent: { 'src/Button.js': hashString(contents) } }
          : {}),
      });
      if (!result.ok) {
        throw new Error(result.reason);
      }
      return result.candidate.id;
    }

    const agent = build({ kind: 'agent', version: 'test-1' }, ['cluster-a']);
    const deterministic = build({ kind: 'deterministic', version: 'test-1' }, [
      'cluster-a',
    ]);
    const anotherCluster = build({ kind: 'agent', version: 'test-1' }, [
      'cluster-b',
    ]);
    expect(new Set([agent, deterministic, anotherCluster]).size).toBe(3);
  });

  test('decision artifacts are inputs to both snapshot and candidate identity', () => {
    const workspace = openWorkspace(['src/**']);
    writeFiles(workspace.path, {
      'src/Button.js': 'export const Button = 42;\n',
    });
    const unbound = createSnapshot({
      repositoryRoot: repo,
      files: ['src/Button.js'],
    });
    const decisionHash = hashString('approved theme map');
    const refused = createCandidatePatch({
      workspace,
      snapshot: unbound,
      proposer: PROPOSER,
      decisionArtifactHashes: [decisionHash],
    });
    expect(refused).toMatchObject({
      ok: false,
      reason:
        'candidate decision artifacts are not bound to the supplied snapshot',
    });

    const bound = createSnapshot({
      repositoryRoot: repo,
      files: ['src/Button.js'],
      decisionArtifactHashes: [decisionHash],
    });
    expect(snapshotHash(bound)).not.toBe(snapshotHash(unbound));
    const accepted = createCandidatePatch({
      workspace,
      snapshot: bound,
      proposer: PROPOSER,
      decisionArtifactHashes: [decisionHash],
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.candidate.decisionArtifactHashes).toEqual([decisionHash]);
    }
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

    state = transition(state, 'applied', 'kernel');
    expect(state).toBe('applied');
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
      'not bound to the supplied snapshot',
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

  test('invalid UTF-8 without a NUL byte is refused', () => {
    const workspace = openWorkspace(['src/**']);
    fs.writeFileSync(
      path.join(workspace.path, 'src/invalid.js'),
      Buffer.from([0x66, 0x6f, 0x80, 0x6f]),
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
      expect(result.reason).toContain('not valid UTF-8');
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

    test('changing the executable bit after verification makes the candidate stale', () => {
      const workspace = openWorkspace(['src/**']);
      writeFiles(workspace.path, {
        'src/Button.js': 'export const Button = 42;\n',
      });
      const { candidate, snapshot } = propose(workspace, ['src/Button.js']);

      fs.chmodSync(path.join(repo, 'src/Button.js'), 0o755);

      const result = write(candidate, snapshot);
      expect(result.status).toBe('stale');
      if (result.status === 'stale') {
        expect(result.staleFiles).toEqual(['src/Button.js']);
      }
    });

    test('a symlinked destination parent cannot redirect a write outside the repository', () => {
      const workspace = openWorkspace(['src/**']);
      writeFiles(workspace.path, {
        'src/generated/New.js': 'export const New = 1;\n',
      });
      const { candidate, snapshot } = propose(workspace, ['src/Button.js']);
      const outside = createTempDir('stylex-migrate-outside-');
      try {
        fs.symlinkSync(outside, path.join(repo, 'src/generated'));
        expect(() => write(candidate, snapshot)).toThrow(
          'symbolic-link parent',
        );
        expect(fs.existsSync(path.join(outside, 'New.js'))).toBe(false);
      } finally {
        fs.rmSync(path.join(repo, 'src/generated'), { force: true });
        removeTempDir(outside);
      }
    });
  });

  /**
   * Evidence is collected on a proposal's bytes; a candidate is built from a
   * workspace. Nothing links the two unless the candidate is required to
   * contain the content that was checked.
   */
  describe('binding a verified proposal to a candidate', () => {
    test('a deterministic candidate cannot omit the proposal hashes', () => {
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
        proposer: { kind: 'deterministic', version: 'test-1' },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('must name the exact content hashes');
      }
    });

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

    test('an extra allowlisted edit that the proposal did not produce is refused', () => {
      const workspace = openWorkspace(['src/**']);
      const verified = 'export const Button = 42;\n';
      writeFiles(workspace.path, {
        'src/Button.js': verified,
        'src/Card.js': 'export const Card = 43;\n',
      });
      const snapshot = createSnapshot({
        repositoryRoot: repo,
        files: ['src/Button.js', 'src/Card.js'],
      });
      const result = createCandidatePatch({
        workspace,
        snapshot,
        proposer: { kind: 'deterministic', version: 'test-1' },
        expectedContent: { 'src/Button.js': hashString(verified) },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('extra candidate change');
        expect(result.paths).toEqual(['src/Card.js']);
      }
    });
  });

  describe('the apply plan', () => {
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

    test('real M2 evidence makes a mechanical candidate auto-eligible for an explicit write', () => {
      const source = `/** @jsxImportSource @emotion/react */
export const Button = () => <button css={{ color: 'red' }} />;
`;
      writeFiles(repo, { 'src/Button.js': source });
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync(
        'git',
        ['commit', '--quiet', '--no-verify', '-m', 'emotion source'],
        { cwd: repo },
      );

      const proposal = proposeStaticConversion({
        source,
        filename: 'src/Button.js',
      });
      if (proposal.status !== 'proposed') {
        throw new Error(`expected a proposal, got ${proposal.status}`);
      }
      const workspace = openWorkspace(['src/**']);
      writeFiles(workspace.path, { 'src/Button.js': proposal.code });
      const snapshot = createSnapshot({
        repositoryRoot: repo,
        files: ['src/Button.js'],
      });
      const built = createCandidatePatch({
        workspace,
        snapshot,
        proposer: { kind: 'deterministic', version: 'm2-test' },
        expectedContent: { 'src/Button.js': proposal.generatedHash },
      });
      if (!built.ok) {
        throw new Error(`candidate failed: ${built.reason}`);
      }
      const evidence = bundleEvidence(
        built.candidate,
        built.snapshot,
        proposal.evidence,
      );
      const result = applyPlan(
        {
          entries: [
            {
              candidate: built.candidate,
              snapshot: built.snapshot,
              evidence,
              scopeRules: { allowedPaths: ['src/**'] },
            },
          ],
        },
        { recoveryRoot },
      );

      expect(result.status).toBe('applied');
      expect(readFile(repo, 'src/Button.js')).toBe(proposal.code);
    });

    test('approved conditional evidence is eligible under the versioned mechanical policy', () => {
      const source = `/** @jsxImportSource @emotion/react */
export const Button = () => <button css={{ color: 'base', ':hover': { color: 'hover' }, ':focus': { color: 'focus' } }} />;
`;
      writeFiles(repo, { 'src/Button.js': source });
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync(
        'git',
        ['commit', '--quiet', '--no-verify', '-m', 'conditional source'],
        { cwd: repo },
      );
      const proposal = proposeStaticConversion({
        source,
        filename: 'src/Button.js',
      });
      if (proposal.status !== 'proposed') {
        throw new Error(`expected a proposal, got ${proposal.status}`);
      }
      const workspace = openWorkspace(['src/**']);
      writeFiles(workspace.path, { 'src/Button.js': proposal.code });
      const snapshot = createSnapshot({
        repositoryRoot: repo,
        files: ['src/Button.js'],
      });
      const built = createCandidatePatch({
        workspace,
        snapshot,
        proposer: { kind: 'deterministic', version: 'm6-test' },
        expectedContent: { 'src/Button.js': proposal.generatedHash },
      });
      if (!built.ok) throw new Error(built.reason);
      const evidence = bundleEvidence(
        built.candidate,
        built.snapshot,
        proposal.evidence,
      );
      const result = applyPlan(
        {
          entries: [
            {
              candidate: built.candidate,
              snapshot: built.snapshot,
              evidence,
              scopeRules: { allowedPaths: ['src/**'] },
            },
          ],
        },
        { recoveryRoot },
      );
      expect(result.status).toBe('applied');
      expect(readFile(repo, 'src/Button.js')).toBe(proposal.code);
    });

    test('approved pseudo-element evidence is eligible under the versioned mechanical policy', () => {
      const source = `/** @jsxImportSource @emotion/react */
export const Button = () => <button css={{ color: 'black', '::before': { content: '"x"', color: 'red' }, '::after': { color: 'blue' } }} />;
`;
      writeFiles(repo, { 'src/Button.js': source });
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync(
        'git',
        ['commit', '--quiet', '--no-verify', '-m', 'pseudo-element source'],
        { cwd: repo },
      );
      const proposal = proposeStaticConversion({
        source,
        filename: 'src/Button.js',
      });
      if (proposal.status !== 'proposed') {
        throw new Error(`expected a proposal, got ${proposal.status}`);
      }
      const workspace = openWorkspace(['src/**']);
      writeFiles(workspace.path, { 'src/Button.js': proposal.code });
      const snapshot = createSnapshot({
        repositoryRoot: repo,
        files: ['src/Button.js'],
      });
      const built = createCandidatePatch({
        workspace,
        snapshot,
        proposer: { kind: 'deterministic', version: 'm6-pseudo-test' },
        expectedContent: { 'src/Button.js': proposal.generatedHash },
      });
      if (!built.ok) throw new Error(built.reason);
      const evidence = bundleEvidence(
        built.candidate,
        built.snapshot,
        proposal.evidence,
      );
      const result = applyPlan(
        {
          entries: [
            {
              candidate: built.candidate,
              snapshot: built.snapshot,
              evidence,
              scopeRules: { allowedPaths: ['src/**'] },
            },
          ],
        },
        { recoveryRoot },
      );
      expect(result.status).toBe('applied');
      expect(readFile(repo, 'src/Button.js')).toBe(proposal.code);
    });

    test('approved media-query evidence is eligible under the versioned mechanical policy', () => {
      const source = `/** @jsxImportSource @emotion/react */
export const Button = () => <button css={{ color: 'black', '@media (min-width: 800px)': { color: 'blue' } }} />;
`;
      writeFiles(repo, { 'src/Button.js': source });
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync(
        'git',
        ['commit', '--quiet', '--no-verify', '-m', 'media-query source'],
        { cwd: repo },
      );
      const proposal = proposeStaticConversion({
        source,
        filename: 'src/Button.js',
      });
      if (proposal.status !== 'proposed') {
        throw new Error(`expected a proposal, got ${proposal.status}`);
      }
      const workspace = openWorkspace(['src/**']);
      writeFiles(workspace.path, { 'src/Button.js': proposal.code });
      const snapshot = createSnapshot({
        repositoryRoot: repo,
        files: ['src/Button.js'],
      });
      const built = createCandidatePatch({
        workspace,
        snapshot,
        proposer: { kind: 'deterministic', version: 'm6-media-test' },
        expectedContent: { 'src/Button.js': proposal.generatedHash },
      });
      if (!built.ok) throw new Error(built.reason);
      const evidence = bundleEvidence(
        built.candidate,
        built.snapshot,
        proposal.evidence,
      );
      const result = applyPlan(
        {
          entries: [
            {
              candidate: built.candidate,
              snapshot: built.snapshot,
              evidence,
              scopeRules: { allowedPaths: ['src/**'] },
            },
          ],
        },
        { recoveryRoot },
      );
      expect(result.status).toBe('applied');
      expect(readFile(repo, 'src/Button.js')).toBe(proposal.code);
    });

    test('an approved candidate with passing evidence is applied', () => {
      const { candidate, snapshot, scopeRules } = planFor();
      const evidence = bundleEvidence(
        candidate,
        snapshot,
        passingEvidence(candidate, snapshot),
      );
      const result = applyPlan(
        {
          entries: [
            {
              candidate,
              snapshot,
              scopeRules,
              evidence,
              approval: approve({ candidate, evidence, approvedBy: 'tester' }),
            },
          ],
        },
        { recoveryRoot },
      );
      expect(result.status).toBe('applied');
      expect(readFile(repo, 'src/Button.js')).toBe(
        'export const Button = 42;\n',
      );
    });

    test('a non-deterministic candidate cannot apply without approval', () => {
      const { candidate, snapshot, scopeRules } = planFor();
      const evidence = bundleEvidence(
        candidate,
        snapshot,
        passingEvidence(candidate, snapshot),
      );
      const result = applyPlan(
        { entries: [{ candidate, snapshot, scopeRules, evidence }] },
        { recoveryRoot },
      );
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toContain('requires approval');
      }
      expect(readFile(repo, 'src/Button.js')).toBe(INITIAL['src/Button.js']);
    });

    test('evidence belonging to another candidate is rejected', () => {
      const first = planFor(42);
      const second = planFor(43);
      expect(second.candidate.id).not.toBe(first.candidate.id);
      const evidence = bundleEvidence(
        second.candidate,
        second.snapshot,
        passingEvidence(second.candidate, second.snapshot),
      );
      const result = applyPlan(
        {
          entries: [
            {
              ...first,
              evidence,
              approval: approve({
                candidate: first.candidate,
                evidence,
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
      const evidence = bundleEvidence(
        first.candidate,
        first.snapshot,
        passingEvidence(first.candidate, first.snapshot),
      );
      const result = applyPlan(
        {
          entries: [
            {
              ...first,
              evidence,
              approval: approve({
                candidate: second.candidate,
                evidence,
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
      const change = candidate.changes[0];
      const failing = [
        makeEvidence({
          check: 'stylex-plugin-transform',
          provider: 'stylex-migrate',
          providerVersion: 'test',
          subject: {
            file: change.path,
            sourceHash: snapshot.fileHashes[change.path] ?? null,
            targetHash: change.contentHash,
          },
          scope: [change.path],
          result: 'fail',
        }),
      ];
      const evidence = bundleEvidence(candidate, snapshot, failing);
      const result = applyPlan(
        {
          entries: [
            {
              candidate,
              snapshot,
              scopeRules,
              evidence,
              approval: approve({ candidate, evidence, approvedBy: 'tester' }),
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
      const evidence = bundleEvidence(candidate, snapshot, []);
      const result = applyPlan(
        {
          entries: [
            {
              candidate,
              snapshot,
              scopeRules,
              evidence,
              approval: approve({ candidate, evidence, approvedBy: 'tester' }),
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

    test('passing evidence with the wrong target hash is rejected', () => {
      const { candidate, snapshot, scopeRules } = planFor();
      const results = passingEvidence(candidate, snapshot);
      const wrong = results.map((result, index) =>
        index === 0
          ? makeEvidence({
              ...result,
              subject: { ...result.subject, targetHash: 'wrong-target' },
            })
          : result,
      );
      const evidence = bundleEvidence(candidate, snapshot, wrong);
      const result = applyPlan(
        { entries: [{ candidate, snapshot, scopeRules, evidence }] },
        { recoveryRoot },
      );
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toContain('wrong target hash');
      }
      expect(readFile(repo, 'src/Button.js')).toBe(INITIAL['src/Button.js']);
    });

    test('an unrecognized comparison model is not admitted by policy v4', () => {
      const { candidate, snapshot, scopeRules } = planFor();
      const results = passingEvidence(candidate, snapshot).map((item) =>
        item.check === 'static-css-comparison'
          ? makeEvidence({
              ...item,
              subject: { ...item.subject, model: 'unreviewed-model-v1' },
            })
          : item,
      );
      const evidence = bundleEvidence(candidate, snapshot, results);
      const result = applyPlan(
        { entries: [{ candidate, snapshot, scopeRules, evidence }] },
        { recoveryRoot },
      );
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toContain('must use one of');
      }
    });

    test('an arbitrary passing check cannot replace the required policy', () => {
      const { candidate, snapshot, scopeRules } = planFor();
      const change = candidate.changes[0];
      const arbitrary = [
        makeEvidence({
          check: 'looks-good-to-me',
          provider: 'stylex-migrate',
          providerVersion: 'test',
          subject: {
            file: change.path,
            sourceHash: snapshot.fileHashes[change.path] ?? null,
            targetHash: change.contentHash,
          },
          scope: [change.path],
          result: 'pass',
        }),
      ];
      const evidence = bundleEvidence(candidate, snapshot, arbitrary);
      const result = applyPlan(
        { entries: [{ candidate, snapshot, scopeRules, evidence }] },
        { recoveryRoot },
      );
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toContain('missing required check');
      }
    });

    test('render-local evidence requires its call-integrity check', () => {
      const { candidate, snapshot, scopeRules } = planFor();
      const results = passingEvidence(candidate, snapshot).map((item) =>
        item.check === 'static-css-comparison'
          ? makeEvidence({
              ...item,
              subject: { ...item.subject, model: 'render-local-css-v1' },
            })
          : item,
      );
      const evidence = bundleEvidence(candidate, snapshot, results);
      const result = applyPlan(
        { entries: [{ candidate, snapshot, scopeRules, evidence }] },
        { recoveryRoot },
      );
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toContain(
          'missing required render-local call integrity',
        );
      }
    });

    test('two candidates changing the same file are rejected as a conflict', () => {
      const first = planFor(42);
      const second = planFor(43);
      const entries = [first, second].map((entry) => {
        const evidence = bundleEvidence(
          entry.candidate,
          entry.snapshot,
          passingEvidence(entry.candidate, entry.snapshot),
        );
        return {
          ...entry,
          evidence,
          approval: approve({
            candidate: entry.candidate,
            evidence,
            approvedBy: 'tester',
          }),
        };
      });
      const result = applyPlan(
        {
          entries,
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

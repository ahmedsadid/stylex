/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { execFileSync } from 'child_process';
import {
  createCandidatePatch,
  createCandidateWorkspace,
  createSnapshot,
  hashString,
  initializeProject,
  makeEvidence,
  removeCandidateWorkspace,
  saveVerificationCandidate,
  writeConfig,
} from '../src/index';
import { runCli, runCliAsync } from '../src/cli';
import type {
  CandidateWorkspace,
  Classification,
  EvidenceResult,
  ProjectState,
  Proposer,
} from '../src/index';
import {
  createTempDir,
  createTempRepo,
  readFile,
  removeTempDir,
  writeFiles,
} from './utils/tempRepo';

type CliResult = {
  +code: number,
  +json: $FlowFixMe,
  +stdout: string,
  +stderr: string,
};

function git(repo: string, args: $ReadOnlyArray<string>): string {
  return String(
    execFileSync('git', [...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe',
    }),
  ).trim();
}

async function asyncCli(
  repo: string,
  args: $ReadOnlyArray<string>,
): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const code = await runCliAsync([...args, '--json'], {
    cwd: repo,
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  return {
    code,
    stdout,
    stderr,
    json: stdout === '' ? null : JSON.parse(stdout),
  };
}

function syncCli(repo: string, args: $ReadOnlyArray<string>): CliResult {
  let stdout = '';
  let stderr = '';
  const code = runCli([...args, '--json'], {
    cwd: repo,
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  return {
    code,
    stdout,
    stderr,
    json: stdout === '' ? null : JSON.parse(stdout),
  };
}

describe('M5 verify and review CLI', () => {
  let repo: string;
  let project: ProjectState;
  let workspaceRoot: string;
  let workspaces: Array<CandidateWorkspace>;

  beforeEach(() => {
    repo = createTempRepo({
      'src/A.js': 'export const A = 1;\n',
      'src/B.js': 'export const B = 1;\n',
    });
    project = initializeProject({ repositoryRoot: repo });
    workspaceRoot = createTempDir('stylex-migrate-cli-candidate-');
    workspaces = [];
  });

  afterEach(() => {
    for (const workspace of workspaces) {
      removeCandidateWorkspace(workspace);
    }
    removeTempDir(workspaceRoot);
    removeTempDir(repo);
  });

  function persistCandidate({
    proposer,
    classification,
    includeStatic,
    file = 'src/A.js',
    clusterId = 'cluster-a',
  }: {
    +proposer: Proposer,
    +classification: Classification,
    +includeStatic: boolean,
    +file?: string,
    +clusterId?: string,
  }): string {
    const workspace = createCandidateWorkspace({
      repositoryRoot: repo,
      allowedPaths: ['src/**'],
      rootDir: workspaceRoot,
    });
    workspaces.push(workspace);
    const binding = file.includes('B.') ? 'B' : 'A';
    const content = `export const ${binding} = 2;\n`;
    writeFiles(workspace.path, { [file]: content });
    const snapshot = createSnapshot({
      repositoryRoot: repo,
      files: [file],
    });
    const result = createCandidatePatch({
      workspace,
      snapshot,
      proposer,
      clusterIds: [clusterId],
      ...(proposer.kind === 'deterministic'
        ? { expectedContent: { [file]: hashString(content) } }
        : {}),
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const change = result.candidate.changes[0];
    const subject = {
      file: change.path,
      sourceHash: result.snapshot.fileHashes[change.path] ?? null,
      targetHash: change.contentHash,
    };
    const staticEvidence: Array<EvidenceResult> = includeStatic
      ? [
          ['stylex-plugin-transform', '@stylexjs/babel-plugin'],
          ['stylex-lint', '@stylexjs/eslint-plugin'],
          ['binding-integrity', 'stylex-migrate'],
          ['static-css-comparison', 'stylex-migrate'],
        ].map(([check, provider]) =>
          makeEvidence({
            check,
            provider,
            providerVersion: 'fixture-v1',
            subject:
              check === 'static-css-comparison'
                ? { ...subject, model: 'static-css-v3' }
                : subject,
            scope: [change.path],
            result: 'pass',
          }),
        )
      : [];
    saveVerificationCandidate(project, {
      candidate: result.candidate,
      snapshot: result.snapshot,
      classification,
      siteIdsByFile: { [file]: [`site-${binding.toLowerCase()}`] },
      staticEvidence,
    });
    return result.candidate.id;
  }

  function configure(versionArgv?: $ReadOnlyArray<string>): void {
    writeConfig(project, {
      sourceGlobs: ['src/**/*.js'],
      evidence: {
        concurrency: 2,
        outputPreviewBytes: 1024,
        providers: [
          {
            id: 'repo-typecheck',
            kind: 'command',
            check: 'typecheck',
            checkVersion: 'fixture-v1',
            subject: 'candidate',
            cost: 'standard',
            argv: [
              process.execPath,
              '-e',
              "const fs=require('fs');const text=fs.readFileSync('src/A.js','utf8');if(!text.includes('A = 2'))process.exit(9);process.stdout.write('candidate bytes checked')",
            ],
            versionArgv: versionArgv ?? [
              process.execPath,
              '-e',
              "process.stdout.write('fixture-tool-v1')",
            ],
            cwd: '.',
            allowedEnv: ['PATH'],
            fileGlobs: ['src/**'],
            limitations: ['fixture typecheck only'],
            timeoutMs: 5000,
          },
        ],
      },
    });
  }

  test('verify checks isolated candidate bytes, persists a verdict, and never writes source', async () => {
    const candidateId = persistCandidate({
      proposer: { kind: 'deterministic', version: 'fixture-v1' },
      classification: 'mechanical',
      includeStatic: true,
    });
    configure();
    const head = git(repo, ['rev-parse', 'HEAD']);

    const first = await asyncCli(repo, ['verify', candidateId]);
    expect(first.code).toBe(0);
    expect(first.json).toMatchObject({
      command: 'verify',
      subject: { kind: 'candidate', candidateId },
      coverage: { status: 'covered' },
      runtimeCoverage: { status: 'not-configured' },
      warnings: [expect.stringContaining('Runtime behavior was not matched')],
      verdict: {
        outcome: 'auto-eligible',
        claims: expect.arrayContaining([
          expect.objectContaining({ claim: 'static-css-matched' }),
          expect.objectContaining({ claim: 'checks-passed' }),
        ]),
      },
    });
    expect(readFile(repo, 'src/A.js')).toBe('export const A = 1;\n');
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(repo, ['status', '--porcelain'])).toBe('');

    const review = syncCli(repo, ['review', candidateId]);
    expect(review.code).toBe(0);
    expect(review.json).toMatchObject({
      command: 'review',
      warnings: [expect.stringContaining('Runtime behavior was not matched')],
      verdict: { outcome: 'auto-eligible' },
      evidence: {
        coverage: { status: 'covered' },
        runtimeCoverage: { status: 'not-configured' },
        repositoryChecks: [
          expect.objectContaining({
            provider: 'repo-typecheck',
            result: 'pass',
          }),
        ],
      },
    });
    expect(syncCli(repo, ['explain', first.json.verdict.id]).json.kind).toBe(
      'verdict',
    );

    const second = await asyncCli(repo, ['verify', candidateId]);
    expect(second.code).toBe(0);
    expect(second.json.schedule.checks[0].cacheHit).toBe(true);
    expect(syncCli(repo, ['status']).json).toMatchObject({
      eventCount: 4,
      counts: { candidates: 1, verdicts: 1 },
    });
  });

  test('a missing tool is unavailable and produces the blocked exit code', async () => {
    const candidateId = persistCandidate({
      proposer: { kind: 'agent', version: 'fixture-v1' },
      classification: 'repeatable-contextual',
      includeStatic: false,
    });
    configure(['stylex-migrate-missing-tool', '--version']);
    const result = await asyncCli(repo, ['verify', candidateId]);
    expect(result.code).toBe(3);
    expect(result.json).toMatchObject({
      schedule: {
        checks: [
          expect.objectContaining({
            provider: 'repo-typecheck',
            result: 'unavailable',
          }),
        ],
      },
      verdict: { outcome: 'blocked' },
    });
  });

  test('one apply-plan check covers only its exact non-conflicting candidate set', async () => {
    const first = persistCandidate({
      proposer: { kind: 'agent', version: 'fixture-v1' },
      classification: 'repeatable-contextual',
      includeStatic: false,
      file: 'src/A.js',
    });
    const second = persistCandidate({
      proposer: { kind: 'agent', version: 'fixture-v1' },
      classification: 'repeatable-contextual',
      includeStatic: false,
      file: 'src/B.js',
    });
    writeConfig(project, {
      sourceGlobs: ['src/**/*.js'],
      evidence: {
        concurrency: 1,
        outputPreviewBytes: 1024,
        providers: [
          {
            id: 'repo-apply-typecheck',
            kind: 'command',
            check: 'typecheck',
            checkVersion: 'fixture-v1',
            subject: 'apply-plan',
            cost: 'standard',
            argv: [
              process.execPath,
              '-e',
              "const fs=require('fs');for(const f of ['src/A.js','src/B.js'])if(!fs.readFileSync(f,'utf8').includes('= 2'))process.exit(8)",
            ],
            versionArgv: [
              process.execPath,
              '-e',
              "process.stdout.write('fixture-tool-v1')",
            ],
            cwd: '.',
            allowedEnv: ['PATH'],
            fileGlobs: ['src/**'],
            limitations: [],
            timeoutMs: 5000,
          },
        ],
      },
    });

    const complete = await asyncCli(repo, ['verify', first, second]);
    expect(complete.code).toBe(0);
    expect(complete.json).toMatchObject({
      subject: {
        kind: 'apply-plan',
        candidateIds: [first, second].sort(),
      },
      coverage: { status: 'covered' },
      verdict: { outcome: 'eligible-for-review' },
    });

    const review = syncCli(repo, ['review', first]);
    expect(review.code).toBe(0);
    expect(review.json).toMatchObject({
      composition: {
        subjectId: complete.json.subject.id,
        kind: 'apply-plan',
        paths: [
          { file: 'src/A.js', ownership: 'exclusive', candidateIds: [first] },
          { file: 'src/B.js', ownership: 'exclusive', candidateIds: [second] },
        ],
      },
      candidates: expect.arrayContaining([
        expect.objectContaining({
          id: first,
          uniqueFiles: ['src/A.js'],
          sharedFiles: [],
        }),
        expect.objectContaining({
          id: second,
          uniqueFiles: ['src/B.js'],
          sharedFiles: [],
        }),
      ]),
    });

    const subset = await asyncCli(repo, ['verify', first]);
    expect(subset.code).toBe(3);
    expect(subset.json).toMatchObject({
      subject: { kind: 'candidate', candidateId: first },
      schedule: { checks: [] },
      verdict: { outcome: 'blocked' },
    });
    expect(subset.json.evidenceBundleId).not.toBe(
      complete.json.evidenceBundleId,
    );
  });

  test('combined review labels byte-identical shared outputs', async () => {
    const bridge = persistCandidate({
      proposer: { kind: 'agent', version: 'bridge-v1' },
      classification: 'repeatable-contextual',
      includeStatic: false,
      file: 'src/A.js',
      clusterId: 'bridge',
    });
    const consumer = persistCandidate({
      proposer: { kind: 'agent', version: 'consumer-v1' },
      classification: 'repeatable-contextual',
      includeStatic: false,
      file: 'src/A.js',
      clusterId: 'consumer',
    });
    writeConfig(project, {
      sourceGlobs: ['src/**/*.js'],
      evidence: {
        concurrency: 1,
        outputPreviewBytes: 1024,
        providers: [
          {
            id: 'shared-output-check',
            kind: 'command',
            check: 'typecheck',
            checkVersion: 'fixture-v1',
            subject: 'apply-plan',
            cost: 'cheap',
            argv: [process.execPath, '-e', 'process.exit(0)'],
            versionArgv: [
              process.execPath,
              '-e',
              "process.stdout.write('fixture-v1')",
            ],
            cwd: '.',
            allowedEnv: ['PATH'],
            fileGlobs: ['src/**'],
            limitations: [],
            timeoutMs: 5000,
          },
        ],
      },
    });
    const verified = await asyncCli(repo, ['verify', bridge, consumer]);
    expect(verified.code).toBe(0);
    const review = syncCli(repo, ['review', bridge]);
    expect(review.code).toBe(0);
    expect(review.json).toMatchObject({
      composition: {
        kind: 'apply-plan',
        paths: [
          {
            file: 'src/A.js',
            ownership: 'shared-identical',
            candidateIds: [bridge, consumer].sort(),
          },
        ],
      },
      candidates: expect.arrayContaining([
        expect.objectContaining({ id: bridge, sharedFiles: ['src/A.js'] }),
        expect.objectContaining({ id: consumer, sharedFiles: ['src/A.js'] }),
      ]),
    });
  });
});

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  createCandidateEvidenceSubject,
  createCandidatePatch,
  createCandidateWorkspace,
  createRepositoryEvidenceBundle,
  createSnapshot,
  canonicalJson,
  evidenceScheduleIdentity,
  evaluateRepositoryEvidence,
  hashBytes,
  hashString,
  initializeProject,
  loadRepositoryEvidenceBundle,
  loadRepositoryEvidenceVerdict,
  makeEvidence,
  removeCandidateWorkspace,
  repositoryEvidenceIdentity,
  saveRepositoryEvidenceBundle,
  saveRepositoryEvidenceVerdict,
  writeArtifact,
} from '../src/index';
import type {
  CandidateWorkspace,
  Classification,
  EvidenceConfig,
  EvidenceResult,
  EvidenceScheduleResult,
  ProjectState,
  Proposer,
  RepositoryEvidenceResult,
  RepositoryEvidenceSubject,
  VerificationCandidate,
} from '../src/index';
import {
  createTempDir,
  createTempRepo,
  removeTempDir,
  writeFiles,
} from './utils/tempRepo';

describe('M5 evidence bundles and policy verdicts', () => {
  let repo: string;
  let project: ProjectState;
  let workspaceRoot: string;
  let workspaces: Array<CandidateWorkspace>;

  beforeEach(() => {
    repo = createTempRepo({ 'src/A.js': 'export const A = 1;\n' });
    project = initializeProject({ repositoryRoot: repo });
    workspaceRoot = createTempDir('stylex-migrate-verdict-');
    workspaces = [];
  });

  afterEach(() => {
    for (const workspace of workspaces) {
      removeCandidateWorkspace(workspace);
    }
    removeTempDir(workspaceRoot);
    removeTempDir(repo);
  });

  function record({
    proposer,
    classification,
    includeStatic,
    comparisonModel = 'static-css-v3',
  }: {
    +proposer: Proposer,
    +classification: Classification,
    +includeStatic: boolean,
    +comparisonModel?: string,
  }): VerificationCandidate {
    const workspace = createCandidateWorkspace({
      repositoryRoot: repo,
      allowedPaths: ['src/**'],
      rootDir: workspaceRoot,
    });
    workspaces.push(workspace);
    const content = 'export const A = 2;\n';
    writeFiles(workspace.path, { 'src/A.js': content });
    const snapshot = createSnapshot({
      repositoryRoot: repo,
      files: ['src/A.js'],
    });
    const result = createCandidatePatch({
      workspace,
      snapshot,
      proposer,
      clusterIds: ['cluster-a'],
      ...(proposer.kind === 'deterministic'
        ? { expectedContent: { 'src/A.js': hashString(content) } }
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
                ? { ...subject, model: comparisonModel }
                : subject,
            scope: [change.path],
            result: 'pass',
          }),
        )
      : [];
    return {
      candidate: result.candidate,
      snapshot: result.snapshot,
      classification,
      siteIdsByFile: { 'src/A.js': ['site-a'] },
      staticEvidence,
    };
  }

  function repositoryEvidence(
    subject: RepositoryEvidenceSubject,
    outcome: 'pass' | 'unavailable' | 'fail',
  ): { +evidence: RepositoryEvidenceResult, +output: Buffer } {
    const output = Buffer.from(`repository check ${outcome}`);
    const provisional: RepositoryEvidenceResult = {
      id: '',
      check: 'typecheck',
      checkVersion: 'selection-v1',
      provider: 'repo-typecheck',
      providerVersion: 'tool-v1',
      subject,
      result: outcome,
      command: {
        argv: ['typecheck'],
        versionArgv: ['typecheck', '--version'],
        cwd: '.',
        allowedEnvKeys: ['PATH'],
        environmentFingerprint: 'environment',
        exitCode: outcome === 'pass' ? 0 : outcome === 'fail' ? 1 : null,
      },
      platform: { platform: 'test', architecture: 'x64', node: 'v1' },
      startedAt: '2026-08-10T00:00:00.000Z',
      durationMs: 10,
      outputHash: hashBytes(output),
      outputSize: output.length,
      outputPreview: output.toString('utf8'),
      limitations: [],
    };
    return {
      evidence: {
        ...provisional,
        id: repositoryEvidenceIdentity(provisional),
      },
      output,
    };
  }

  function inputs(
    candidate: VerificationCandidate,
    outcome: 'pass' | 'unavailable' | 'fail' = 'pass',
  ): {
    +subject: RepositoryEvidenceSubject,
    +schedule: EvidenceScheduleResult,
    +config: EvidenceConfig,
  } {
    const subject = createCandidateEvidenceSubject({
      candidate: candidate.candidate,
      snapshot: candidate.snapshot,
      siteIdsByFile: candidate.siteIdsByFile,
    });
    const repository = repositoryEvidence(subject, outcome);
    const artifact = writeArtifact(project, repository.output);
    const config: EvidenceConfig = {
      concurrency: 1,
      outputPreviewBytes: 1024,
      providers: [
        {
          id: 'repo-typecheck',
          kind: 'command',
          check: 'typecheck',
          checkVersion: 'selection-v1',
          subject: 'candidate',
          cost: 'standard',
          argv: ['typecheck'],
          versionArgv: ['typecheck', '--version'],
          cwd: '.',
          allowedEnv: ['PATH'],
          fileGlobs: ['src/**'],
          limitations: [],
          timeoutMs: 1000,
        },
      ],
    };
    const scheduleStable = {
      subjectId: subject.id,
      configHash: hashString(canonicalJson(config)),
      concurrency: 1,
      items: [
        {
          providerId: 'repo-typecheck',
          cost: 'standard' as 'standard',
          estimatedDurationMs: 10,
        },
      ],
      ignoredProviderIds: [],
      estimatedCommandRuns: 1,
      estimatedDurationMs: 10,
    };
    return {
      subject,
      schedule: {
        schedule: {
          id: evidenceScheduleIdentity({ id: '', ...scheduleStable }),
          ...scheduleStable,
        },
        entries: [
          {
            providerId: 'repo-typecheck',
            cost: 'standard',
            cacheHit: false,
            estimatedDurationMs: 10,
            elapsedMs: 10,
            evidence: repository.evidence,
            outputArtifact: artifact,
          },
        ],
        skippedProviderIds: [],
        actualDurationMs: 10,
      },
      config,
    };
  }

  test('complete static and repository evidence is auto-eligible only for deterministic work', () => {
    const candidate = record({
      proposer: { kind: 'deterministic', version: 'fixture-v1' },
      classification: 'mechanical',
      includeStatic: true,
    });
    const evidence = inputs(candidate);
    const bundle = createRepositoryEvidenceBundle({
      ...evidence,
      candidates: [candidate],
    });
    const verdict = evaluateRepositoryEvidence({
      bundle,
      candidates: [candidate],
    });
    expect(verdict.outcome).toBe('auto-eligible');
    expect(verdict.claims.map((claim) => claim.claim).sort()).toEqual([
      'checks-passed',
      'static-css-matched',
    ]);

    saveRepositoryEvidenceBundle(project, bundle);
    saveRepositoryEvidenceVerdict(project, verdict);
    const laterBundle = createRepositoryEvidenceBundle({
      ...evidence,
      candidates: [candidate],
      now: () => '2026-08-11T00:00:00.000Z',
    });
    const laterVerdict = evaluateRepositoryEvidence({
      bundle: laterBundle,
      candidates: [candidate],
      now: () => '2026-08-11T00:00:00.000Z',
    });
    expect(laterBundle.id).toBe(bundle.id);
    expect(laterVerdict.id).toBe(verdict.id);
    saveRepositoryEvidenceBundle(project, laterBundle);
    saveRepositoryEvidenceVerdict(project, laterVerdict);
    expect(loadRepositoryEvidenceBundle(project, bundle.id)).toEqual(bundle);
    expect(loadRepositoryEvidenceVerdict(project, verdict.id)).toEqual(verdict);
  });

  test('repository success cannot replace missing mechanical static coverage', () => {
    const candidate = record({
      proposer: { kind: 'deterministic', version: 'fixture-v1' },
      classification: 'mechanical',
      includeStatic: false,
    });
    const evidence = inputs(candidate);
    const verdict = evaluateRepositoryEvidence({
      bundle: createRepositoryEvidenceBundle({
        ...evidence,
        candidates: [candidate],
      }),
      candidates: [candidate],
    });
    expect(verdict.outcome).toBe('blocked');
    expect(verdict.claims.map((claim) => claim.claim)).toEqual([
      'checks-passed',
    ]);
    expect(verdict.missingRequirements).toHaveLength(4);
  });

  test('the repository verdict accepts the approved cascade referee model', () => {
    const candidate = record({
      proposer: { kind: 'deterministic', version: 'fixture-v1' },
      classification: 'mechanical',
      includeStatic: true,
      comparisonModel: 'cascade-referee-v1',
    });
    const evidence = inputs(candidate);
    const verdict = evaluateRepositoryEvidence({
      bundle: createRepositoryEvidenceBundle({
        ...evidence,
        candidates: [candidate],
      }),
      candidates: [candidate],
    });
    expect(verdict.outcome).toBe('auto-eligible');
    expect(verdict.policyId).toBe('mechanical-repository-v4');
  });

  test('the repository verdict accepts the pseudo-element referee model', () => {
    const candidate = record({
      proposer: { kind: 'deterministic', version: 'fixture-v1' },
      classification: 'mechanical',
      includeStatic: true,
      comparisonModel: 'pseudo-element-referee-v1',
    });
    const evidence = inputs(candidate);
    const verdict = evaluateRepositoryEvidence({
      bundle: createRepositoryEvidenceBundle({
        ...evidence,
        candidates: [candidate],
      }),
      candidates: [candidate],
    });
    expect(verdict.outcome).toBe('auto-eligible');
    expect(verdict.policyId).toBe('mechanical-repository-v4');
  });

  test('the repository verdict accepts the media-query referee model', () => {
    const candidate = record({
      proposer: { kind: 'deterministic', version: 'fixture-v1' },
      classification: 'mechanical',
      includeStatic: true,
      comparisonModel: 'media-query-referee-v1',
    });
    const evidence = inputs(candidate);
    const verdict = evaluateRepositoryEvidence({
      bundle: createRepositoryEvidenceBundle({
        ...evidence,
        candidates: [candidate],
      }),
      candidates: [candidate],
    });
    expect(verdict.outcome).toBe('auto-eligible');
    expect(verdict.policyId).toBe('mechanical-repository-v4');
  });

  test('the repository verdict rejects an unreviewed comparison model', () => {
    const candidate = record({
      proposer: { kind: 'deterministic', version: 'fixture-v1' },
      classification: 'mechanical',
      includeStatic: true,
      comparisonModel: 'unreviewed-model-v1',
    });
    const evidence = inputs(candidate);
    const verdict = evaluateRepositoryEvidence({
      bundle: createRepositoryEvidenceBundle({
        ...evidence,
        candidates: [candidate],
      }),
      candidates: [candidate],
    });
    expect(verdict.outcome).toBe('rejected');
    expect(verdict.missingRequirements.join('\n')).toContain(
      'unreviewed-model-v1',
    );
  });

  test('unavailable is not pass, and contextual review carries the runtime warning', () => {
    const mechanical = record({
      proposer: { kind: 'deterministic', version: 'fixture-v1' },
      classification: 'mechanical',
      includeStatic: true,
    });
    const unavailable = inputs(mechanical, 'unavailable');
    const blocked = evaluateRepositoryEvidence({
      bundle: createRepositoryEvidenceBundle({
        ...unavailable,
        candidates: [mechanical],
      }),
      candidates: [mechanical],
    });
    expect(blocked.outcome).toBe('blocked');
    expect(blocked.claims.map((claim) => claim.claim)).toEqual([
      'static-css-matched',
    ]);

    const contextual = record({
      proposer: { kind: 'agent', version: 'fixture-v1' },
      classification: 'repeatable-contextual',
      includeStatic: false,
    });
    const passing = inputs(contextual);
    const review = evaluateRepositoryEvidence({
      bundle: createRepositoryEvidenceBundle({
        ...passing,
        candidates: [contextual],
      }),
      candidates: [contextual],
    });
    expect(review.outcome).toBe('eligible-for-review');
    expect(review.limitations.join('\n')).toContain(
      'Runtime behavior was not compared',
    );
  });

  test('a repository check failure rejects the exact subject', () => {
    const candidate = record({
      proposer: { kind: 'deterministic', version: 'fixture-v1' },
      classification: 'mechanical',
      includeStatic: true,
    });
    const evidence = inputs(candidate, 'fail');
    const verdict = evaluateRepositoryEvidence({
      bundle: createRepositoryEvidenceBundle({
        ...evidence,
        candidates: [candidate],
      }),
      candidates: [candidate],
    });
    expect(verdict.outcome).toBe('rejected');
    expect(verdict.missingRequirements).toContain(
      'repo-typecheck failed typecheck',
    );
  });

  test('the bundle boundary rejects forged repository evidence', () => {
    const candidate = record({
      proposer: { kind: 'deterministic', version: 'fixture-v1' },
      classification: 'mechanical',
      includeStatic: true,
    });
    const inputsWithEvidence = inputs(candidate, 'unavailable');
    const entry = inputsWithEvidence.schedule.entries[0];
    const forgedSchedule = {
      ...inputsWithEvidence.schedule,
      entries: [
        {
          ...entry,
          evidence: { ...entry.evidence, result: 'pass' as 'pass' },
        },
      ],
    };
    expect(() =>
      createRepositoryEvidenceBundle({
        subject: inputsWithEvidence.subject,
        candidates: [candidate],
        schedule: forgedSchedule,
        config: inputsWithEvidence.config,
      }),
    ).toThrow('invalid repository evidence');
  });
});

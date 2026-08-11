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
  createEvidenceSchedule,
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
  RUNTIME_PROTOCOL_VERSION,
  compareRuntimeReports,
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
    includeRenderLocalIntegrity = false,
  }: {
    +proposer: Proposer,
    +classification: Classification,
    +includeStatic: boolean,
    +comparisonModel?: string,
    +includeRenderLocalIntegrity?: boolean,
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
    if (includeRenderLocalIntegrity) {
      staticEvidence.push(
        makeEvidence({
          check: 'render-local-call-integrity',
          provider: 'stylex-migrate',
          providerVersion: 'fixture-v1',
          subject,
          scope: [change.path],
          result: 'pass',
        }),
      );
    }
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

  function runtimeInputs(
    candidate: VerificationCandidate,
    outcome: 'pass' | 'unavailable' | 'fail',
  ): {
    +subject: RepositoryEvidenceSubject,
    +schedule: EvidenceScheduleResult,
    +config: EvidenceConfig,
  } {
    const base = inputs(candidate);
    const runtimeProvider = {
      id: 'repo-runtime',
      kind: 'runtime-command' as 'runtime-command',
      check: 'runtime-render' as 'runtime-render',
      checkVersion: 'runtime-selection-v1',
      subject: 'candidate' as 'candidate',
      cost: 'expensive' as 'expensive',
      runtimeInterface: 'playwright' as 'playwright',
      argv: ['runtime-fixture'],
      versionArgv: ['runtime-fixture', '--version'],
      cwd: '.',
      allowedEnv: ['PATH'],
      fileGlobs: ['src/**'],
      limitations: [
        'Runtime comparison covers only the recorded cases, states, viewports, and environment.',
      ],
      timeoutMs: 1000,
      cases: [
        {
          id: 'a-default',
          changePaths: ['src/A.js'],
          siteIds: ['site-a'],
          theme: 'default',
          interaction: 'initial',
          viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
        },
      ],
    };
    const config: EvidenceConfig = {
      ...base.config,
      providers: [...base.config.providers, runtimeProvider],
    };
    const report = (value: string) => ({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      environment: {
        renderer: 'playwright',
        rendererVersion: '1.56.1',
        browser: 'chromium',
        browserVersion: '140',
        platform: 'test',
      },
      cases: [
        {
          id: 'a-default',
          observation: {
            computedStyles: { target: { color: value } },
            dom: { target: { tagName: 'DIV' } },
            attributes: { target: {} },
            refs: { target: { attached: true } },
            interactions: { initial: { complete: true } },
          },
        },
      ],
    });
    const comparison = compareRuntimeReports({
      cases: runtimeProvider.cases,
      baseline: report('red'),
      candidate: report(outcome === 'fail' ? 'blue' : 'red'),
    });
    const output = Buffer.from(`runtime check ${outcome}`);
    const command = {
      argv: ['runtime-fixture'],
      versionArgv: ['runtime-fixture', '--version'],
      cwd: '.',
      allowedEnvKeys: ['PATH'],
      environmentFingerprint: 'environment',
      exitCode: outcome === 'unavailable' ? null : 0,
    };
    const provisional: RepositoryEvidenceResult = {
      id: '',
      check: 'runtime-render',
      checkVersion: 'runtime-selection-v1',
      provider: 'repo-runtime',
      providerVersion: outcome === 'unavailable' ? 'unavailable' : 'tool-v1',
      subject: base.subject,
      result: outcome,
      command,
      platform: { platform: 'test', architecture: 'x64', node: 'v1' },
      startedAt: '2026-08-10T00:00:00.000Z',
      durationMs: 10,
      outputHash: hashBytes(output),
      outputSize: output.length,
      outputPreview: output.toString('utf8'),
      limitations: runtimeProvider.limitations,
      ...(outcome === 'unavailable'
        ? { detail: 'browser was unavailable' }
        : {
            runtime: {
              runtimeInterface: 'playwright',
              baselineCommand: command,
              candidateCommand: command,
              comparison,
            },
          }),
    };
    const evidence = {
      ...provisional,
      id: repositoryEvidenceIdentity(provisional),
    };
    const outputArtifact = writeArtifact(project, output);
    const schedule = createEvidenceSchedule({
      project,
      subject: base.subject,
      config,
    });
    return {
      subject: base.subject,
      config,
      schedule: {
        schedule,
        entries: [
          ...base.schedule.entries,
          {
            providerId: 'repo-runtime',
            cost: 'expensive',
            cacheHit: false,
            estimatedDurationMs:
              schedule.items.find((item) => item.providerId === 'repo-runtime')
                ?.estimatedDurationMs ?? 300000,
            elapsedMs: 10,
            evidence,
            outputArtifact,
          },
        ],
        skippedProviderIds: [],
        actualDurationMs: 20,
      },
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
    expect(verdict.policyId).toBe('mechanical-repository-v10');
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
    expect(verdict.policyId).toBe('mechanical-repository-v10');
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
    expect(verdict.policyId).toBe('mechanical-repository-v10');
  });

  test('the repository verdict accepts the supports nesting referee model', () => {
    const candidate = record({
      proposer: { kind: 'deterministic', version: 'fixture-v1' },
      classification: 'mechanical',
      includeStatic: true,
      comparisonModel: 'supports-nesting-referee-v1',
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
    expect(verdict.policyId).toBe('mechanical-repository-v10');
  });

  test('the repository verdict accepts the keyframes referee model', () => {
    const candidate = record({
      proposer: { kind: 'deterministic', version: 'fixture-v1' },
      classification: 'mechanical',
      includeStatic: true,
      comparisonModel: 'keyframes-referee-v1',
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
    expect(verdict.policyId).toBe('mechanical-repository-v10');
  });

  test('the repository verdict accepts the box shorthand referee model', () => {
    const candidate = record({
      proposer: { kind: 'deterministic', version: 'fixture-v1' },
      classification: 'mechanical',
      includeStatic: true,
      comparisonModel: 'box-shorthand-referee-v1',
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
    expect(verdict.policyId).toBe('mechanical-repository-v10');
  });

  test('the repository verdict accepts the directional referee model', () => {
    const candidate = record({
      proposer: { kind: 'deterministic', version: 'fixture-v1' },
      classification: 'mechanical',
      includeStatic: true,
      comparisonModel: 'directional-referee-v1',
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
    expect(verdict.policyId).toBe('mechanical-repository-v10');
  });

  test('the repository verdict accepts the render-local css model', () => {
    const candidate = record({
      proposer: { kind: 'deterministic', version: 'fixture-v1' },
      classification: 'mechanical',
      includeStatic: true,
      comparisonModel: 'render-local-css-v1',
      includeRenderLocalIntegrity: true,
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
    expect(verdict.policyId).toBe('mechanical-repository-v10');
  });

  test('the repository verdict requires render-local call integrity', () => {
    const candidate = record({
      proposer: { kind: 'deterministic', version: 'fixture-v1' },
      classification: 'mechanical',
      includeStatic: true,
      comparisonModel: 'render-local-css-v1',
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
    expect(verdict.missingRequirements).toContain(
      'src/A.js requires render-local-call-integrity from stylex-migrate',
    );
    expect(verdict.claims.map((claim) => claim.claim)).toEqual([
      'checks-passed',
    ]);
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
      'WARNING: Runtime behavior was not matched',
    );
  });

  test('matched runtime cases earn a sampled claim with per-site coverage', () => {
    const candidate = record({
      proposer: { kind: 'agent', version: 'fixture-v1' },
      classification: 'repeatable-contextual',
      includeStatic: false,
    });
    const evidence = runtimeInputs(candidate, 'pass');
    const bundle = createRepositoryEvidenceBundle({
      ...evidence,
      candidates: [candidate],
    });
    const verdict = evaluateRepositoryEvidence({
      bundle,
      candidates: [candidate],
    });
    expect(bundle.runtimeCoverage).toMatchObject({
      status: 'matched',
      coveredPaths: ['src/A.js'],
      coveredSiteIds: ['site-a'],
      uncoveredPaths: [],
      uncoveredSiteIds: [],
      entries: [
        {
          providerId: 'repo-runtime',
          caseId: 'a-default',
          theme: 'default',
          interaction: 'initial',
          status: 'matched',
        },
      ],
    });
    expect(verdict.outcome).toBe('eligible-for-review');
    expect(verdict.claims.map((claim) => claim.claim).sort()).toEqual([
      'checks-passed',
      'runtime-matched',
    ]);
    expect(verdict.limitations.join('\n')).not.toContain('WARNING:');
  });

  test('runtime mismatch rejects, while runtime unavailability warns permissively', () => {
    const candidate = record({
      proposer: { kind: 'agent', version: 'fixture-v1' },
      classification: 'repeatable-contextual',
      includeStatic: false,
    });
    const differentEvidence = runtimeInputs(candidate, 'fail');
    const different = evaluateRepositoryEvidence({
      bundle: createRepositoryEvidenceBundle({
        ...differentEvidence,
        candidates: [candidate],
      }),
      candidates: [candidate],
    });
    expect(different.outcome).toBe('rejected');
    expect(different.missingRequirements).toContain(
      'repo-runtime failed runtime-render',
    );

    const unavailableEvidence = runtimeInputs(candidate, 'unavailable');
    const unavailable = evaluateRepositoryEvidence({
      bundle: createRepositoryEvidenceBundle({
        ...unavailableEvidence,
        candidates: [candidate],
      }),
      candidates: [candidate],
    });
    expect(unavailable.outcome).toBe('eligible-for-review');
    expect(unavailable.claims.map((claim) => claim.claim)).toEqual([
      'checks-passed',
    ]);
    expect(unavailable.limitations.join('\n')).toContain(
      'WARNING: Runtime behavior was not matched',
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

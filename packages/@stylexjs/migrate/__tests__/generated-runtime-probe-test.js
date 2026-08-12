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
  RUNTIME_PROTOCOL_VERSION,
  aggregateRuntimeCoverage,
  runGeneratedRuntimeProbeProvider,
} from '../src/index';
import type {
  GeneratedRuntimeProbeProviderConfig,
  RepositoryEvidenceSubject,
} from '../src/index';
import { createTempDir, removeTempDir } from './utils/tempRepo';

const ASSUMPTION = 'a'.repeat(64);
const SUBJECT: RepositoryEvidenceSubject = Object.freeze({
  kind: 'candidate',
  id: 'generated-subject',
  candidateId: 'candidate-1',
  candidateIds: Object.freeze(['candidate-1']),
  assumptionArtifactHashes: Object.freeze([ASSUMPTION]),
  changes: Object.freeze([
    Object.freeze({
      path: 'src/Card.jsx',
      sourceHash: 'source',
      targetHash: 'target',
      siteIds: Object.freeze(['site-card']),
    }),
  ]),
});

function report(color: string): $FlowFixMe {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    environment: {
      renderer: 'generated-fixture',
      rendererVersion: '1',
      browser: 'chromium',
      browserVersion: '140',
      platform: 'fixture',
    },
    cases: [
      {
        id: 'card-dark',
        observation: {
          computedStyles: { card: { color } },
          dom: { card: { tagName: 'DIV' } },
          attributes: { card: { 'data-theme': 'dark' } },
          refs: {},
          interactions: {},
        },
      },
    ],
  };
}

function expected(color: string): $FlowFixMe {
  const value = report(color);
  return {
    protocolVersion: value.protocolVersion,
    cases: value.cases,
  };
}

function provider(): GeneratedRuntimeProbeProviderConfig {
  return {
    id: 'generated-runtime-fixture',
    kind: 'generated-runtime-probe',
    check: 'runtime-render',
    checkVersion: 'generated-fixture-v1',
    subject: 'candidate',
    cost: 'expensive',
    runtimeInterface: 'playwright',
    argv: [
      process.execPath,
      '-e',
      "process.stdout.write(require('fs').readFileSync('report.json','utf8'))",
    ],
    versionArgv: [
      process.execPath,
      '-e',
      "process.stdout.write('generated-fixture-v1')",
    ],
    cwd: '.',
    allowedEnv: ['PATH'],
    fileGlobs: ['src/**'],
    limitations: ['generated fixture only'],
    timeoutMs: 5000,
    assumptionArtifactHash: ASSUMPTION,
    expectedObservations: expected('rgb(255, 0, 0)'),
    cases: [
      {
        id: 'card-dark',
        changePaths: ['src/Card.jsx'],
        siteIds: ['site-card'],
        theme: 'dark',
        interaction: 'initial',
        viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      },
    ],
  };
}

describe('generated runtime probe evidence', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = createTempDir('stylex-migrate-generated-runtime-');
    fs.writeFileSync(
      path.join(workspace, 'report.json'),
      JSON.stringify(report('rgb(255, 0, 0)')),
    );
  });

  afterEach(() => removeTempDir(workspace));

  test('matches locked expectations without inventing a baseline command', async () => {
    const config = provider();
    const execution = await runGeneratedRuntimeProbeProvider(config, {
      workspaceRoot: workspace,
      subject: SUBJECT,
    });
    expect(execution.evidence).toMatchObject({
      result: 'pass',
      runtime: {
        baselineKind: 'generated-probe',
        assumptionArtifactHash: ASSUMPTION,
        expectedReportHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        comparison: { result: 'matched' },
      },
      limitations: expect.arrayContaining([
        expect.stringContaining('not retained repository behavior'),
      ]),
    });
    expect(execution.evidence.runtime).not.toHaveProperty('baselineCommand');
    const coverage = aggregateRuntimeCoverage({
      subject: SUBJECT,
      providers: [config],
      entries: [
        {
          providerId: config.id,
          evidence: execution.evidence,
          outputArtifact: {
            hash: execution.evidence.outputHash,
            size: execution.evidence.outputSize,
          },
        },
      ],
    });
    expect(coverage).toMatchObject({
      status: 'matched',
      coveredPaths: ['src/Card.jsx'],
      coveredSiteIds: ['site-card'],
    });
  });

  test('uses the observed environment instead of requiring a fabricated expected one', async () => {
    const config = provider();
    const changed = report('rgb(255, 0, 0)');
    changed.environment.browserVersion = 'future-browser-version';
    fs.writeFileSync(
      path.join(workspace, 'report.json'),
      JSON.stringify(changed),
    );
    expect(
      (
        await runGeneratedRuntimeProbeProvider(config, {
          workspaceRoot: workspace,
          subject: SUBJECT,
        })
      ).evidence,
    ).toMatchObject({
      result: 'pass',
      runtime: {
        comparison: {
          result: 'matched',
          environment: { browserVersion: 'future-browser-version' },
        },
      },
    });
  });

  test('rejects differences, partial reports, and unbound assumptions', async () => {
    fs.writeFileSync(
      path.join(workspace, 'report.json'),
      JSON.stringify(report('rgb(0, 0, 255)')),
    );
    expect(
      (
        await runGeneratedRuntimeProbeProvider(provider(), {
          workspaceRoot: workspace,
          subject: SUBJECT,
        })
      ).evidence,
    ).toMatchObject({
      result: 'fail',
      detail: 'generated runtime comparison was different',
    });

    const partial = report('rgb(255, 0, 0)');
    partial.cases = [];
    fs.writeFileSync(
      path.join(workspace, 'report.json'),
      JSON.stringify(partial),
    );
    expect(
      (
        await runGeneratedRuntimeProbeProvider(provider(), {
          workspaceRoot: workspace,
          subject: SUBJECT,
        })
      ).evidence,
    ).toMatchObject({
      result: 'fail',
      detail: 'generated runtime comparison was incomplete',
    });

    expect(
      (
        await runGeneratedRuntimeProbeProvider(provider(), {
          workspaceRoot: workspace,
          subject: { ...SUBJECT, assumptionArtifactHashes: [] },
        })
      ).evidence,
    ).toMatchObject({
      result: 'fail',
      detail: expect.stringContaining('not bound'),
    });
  });
});

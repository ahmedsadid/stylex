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
  runRuntimeCommandProvider,
} from '../src/index';
import type {
  RepositoryEvidenceSubject,
  RuntimeCommandProviderConfig,
  RuntimeInterface,
} from '../src/index';
import { createTempDir, removeTempDir } from './utils/tempRepo';

const SUBJECT: RepositoryEvidenceSubject = Object.freeze({
  kind: 'candidate',
  id: 'subject-1',
  candidateId: 'candidate-1',
  candidateIds: Object.freeze(['candidate-1']),
  changes: Object.freeze([
    Object.freeze({
      path: 'src/Card.jsx',
      sourceHash: 'source',
      targetHash: 'target',
      siteIds: Object.freeze(['site-card']),
    }),
  ]),
});

function report(color: string = 'rgb(255, 0, 0)'): $FlowFixMe {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    environment: {
      renderer: 'fixture',
      rendererVersion: '1',
      browser: 'chromium',
      browserVersion: '140',
      platform: 'fixture',
    },
    cases: [
      {
        id: 'card-hover',
        observation: {
          computedStyles: { card: { color } },
          dom: { card: { tagName: 'DIV', childCount: 0, text: 'Card' } },
          attributes: { card: { 'aria-label': 'Card' } },
          refs: { card: { attached: true, tagName: 'DIV' } },
          interactions: { hover: { active: true } },
        },
      },
    ],
  };
}

function provider(
  runtimeInterface: RuntimeInterface = 'custom',
): RuntimeCommandProviderConfig {
  return {
    id: `runtime-${runtimeInterface}`,
    kind: 'runtime-command',
    check: 'runtime-render',
    checkVersion: 'runtime-fixture-v1',
    subject: 'candidate',
    cost: 'expensive',
    runtimeInterface,
    argv: [
      process.execPath,
      '-e',
      "process.stdout.write(require('fs').readFileSync('report.json', 'utf8'))",
    ],
    versionArgv: [
      process.execPath,
      '-e',
      "process.stdout.write('fixture-runtime-v1')",
    ],
    cwd: '.',
    allowedEnv: ['PATH'],
    fileGlobs: ['src/**'],
    limitations: ['fixture runtime'],
    timeoutMs: 5000,
    cases: [
      {
        id: 'card-hover',
        changePaths: ['src/Card.jsx'],
        siteIds: ['site-card'],
        theme: 'default',
        interaction: 'hover',
        viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      },
    ],
  };
}

describe('M8 runtime command provider', () => {
  let baseline: string;
  let candidate: string;

  beforeEach(() => {
    baseline = createTempDir('stylex-migrate-runtime-baseline-');
    candidate = createTempDir('stylex-migrate-runtime-candidate-');
    fs.writeFileSync(
      path.join(baseline, 'report.json'),
      JSON.stringify(report()),
    );
    fs.writeFileSync(
      path.join(candidate, 'report.json'),
      JSON.stringify(report()),
    );
  });

  afterEach(() => {
    removeTempDir(baseline);
    removeTempDir(candidate);
  });

  test.each(['playwright', 'storybook', 'component-test', 'custom'])(
    'runs the %s interface against retained baseline and candidate trees',
    async (runtimeInterface) => {
      const execution = await runRuntimeCommandProvider(
        provider(runtimeInterface as $FlowFixMe),
        {
          workspaceRoot: candidate,
          baselineWorkspaceRoot: baseline,
          subject: SUBJECT,
        },
      );
      expect(execution.evidence).toMatchObject({
        result: 'pass',
        providerVersion: 'fixture-runtime-v1',
        runtime: {
          baselineKind: 'retained-repository',
          runtimeInterface,
          comparison: {
            result: 'matched',
            coverage: { matchedCaseIds: ['card-hover'] },
          },
        },
      });
      expect(execution.evidence.outputSize).toBe(execution.fullOutput.length);
      expect(execution.fullOutput.toString('utf8')).toContain('[baseline]');
      expect(execution.fullOutput.toString('utf8')).toContain('[candidate]');
    },
  );

  test.each(['playwright', 'storybook', 'component-test', 'custom'])(
    'fails a seeded difference in the %s scope',
    async (runtimeInterface) => {
      fs.writeFileSync(
        path.join(candidate, 'report.json'),
        JSON.stringify(report('rgb(0, 0, 255)')),
      );
      const execution = await runRuntimeCommandProvider(
        provider(runtimeInterface as $FlowFixMe),
        {
          workspaceRoot: candidate,
          baselineWorkspaceRoot: baseline,
          subject: SUBJECT,
        },
      );
      expect(execution.evidence).toMatchObject({
        result: 'fail',
        detail: 'runtime comparison was different',
        runtime: { comparison: { result: 'different' } },
      });
    },
  );

  test('does not pass partial rendering or a missing baseline', async () => {
    const partial = report();
    partial.cases = [];
    fs.writeFileSync(
      path.join(candidate, 'report.json'),
      JSON.stringify(partial),
    );
    const incomplete = await runRuntimeCommandProvider(provider(), {
      workspaceRoot: candidate,
      baselineWorkspaceRoot: baseline,
      subject: SUBJECT,
    });
    expect(incomplete.evidence).toMatchObject({
      result: 'fail',
      runtime: { comparison: { result: 'incomplete' } },
    });

    const unavailable = await runRuntimeCommandProvider(provider(), {
      workspaceRoot: candidate,
      subject: SUBJECT,
    });
    expect(unavailable.evidence).toMatchObject({
      result: 'unavailable',
      detail: 'runtime comparison requires a retained baseline workspace',
    });
  });

  test('refuses cases outside the candidate scope', async () => {
    const config = provider();
    const invalid = {
      ...config,
      cases: [{ ...config.cases[0], siteIds: ['unknown-site'] }],
    };
    const execution = await runRuntimeCommandProvider(invalid as $FlowFixMe, {
      workspaceRoot: candidate,
      baselineWorkspaceRoot: baseline,
      subject: SUBJECT,
    });
    expect(execution.evidence).toMatchObject({
      result: 'fail',
      detail: 'runtime case card-hover names unknown site unknown-site',
    });
  });
});

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { aggregateRepositoryCoverage } from '../src/index';
import type {
  EvidenceProviderConfig,
  EvidenceRunEntry,
  RepositoryEvidenceSubject,
} from '../src/index';

const SUBJECT: RepositoryEvidenceSubject = {
  kind: 'candidate',
  id: 'subject',
  candidateId: 'candidate',
  candidateIds: ['candidate'],
  changes: [
    { path: 'src/A.js', sourceHash: 'a', targetHash: 'b', siteIds: ['site-a'] },
    {
      path: 'src/B.jsx',
      sourceHash: 'c',
      targetHash: 'd',
      siteIds: ['site-b'],
    },
    { path: 'styles/C.css', sourceHash: 'e', targetHash: 'f', siteIds: [] },
  ],
};

function provider(
  id: string,
  check: 'focused-test' | 'lint',
  fileGlobs: $ReadOnlyArray<string>,
): EvidenceProviderConfig {
  return {
    id,
    kind: 'command',
    check,
    checkVersion: 'v1',
    subject: 'candidate',
    cost: 'cheap',
    argv: ['node', 'check.js'],
    versionArgv: ['node', '--version'],
    cwd: '.',
    allowedEnv: ['PATH'],
    fileGlobs,
    limitations: [],
    timeoutMs: 1000,
  };
}

function entry(
  providerId: string,
  result: 'pass' | 'unavailable',
): EvidenceRunEntry {
  return {
    providerId,
    cost: 'cheap',
    cacheHit: false,
    estimatedDurationMs: 1,
    elapsedMs: 1,
    evidence: {
      id: `${providerId}-evidence`,
      check: providerId === 'tests' ? 'focused-test' : 'lint',
      checkVersion: 'v1',
      provider: providerId,
      providerVersion: 'tool-v1',
      subject: SUBJECT,
      result,
      command: {
        argv: [],
        versionArgv: [],
        cwd: '.',
        allowedEnvKeys: [],
        environmentFingerprint: 'env',
        exitCode: result === 'pass' ? 0 : null,
      },
      platform: { platform: 'test', architecture: 'x64', node: 'v1' },
      startedAt: '2026-08-10T00:00:00.000Z',
      durationMs: 1,
      outputHash: 'output',
      outputSize: 0,
      outputPreview: '',
      limitations: [],
    },
    outputArtifact: { hash: 'artifact', size: 0 },
  };
}

describe('M5 kernel-computed repository coverage', () => {
  test('distinguishes complete, partial, and absent path coverage', () => {
    const coverage = aggregateRepositoryCoverage({
      subject: SUBJECT,
      providers: [
        provider('tests', 'focused-test', ['src/**/*.{js,jsx}']),
        provider('lint-a', 'lint', ['src/A.js']),
      ],
      entries: [entry('tests', 'pass'), entry('lint-a', 'unavailable')],
    });
    expect(coverage).toEqual({
      status: 'uncovered',
      counts: { covered: 1, 'partially-covered': 1, uncovered: 1 },
      entries: [
        expect.objectContaining({
          changePath: 'src/A.js',
          siteIds: ['site-a'],
          status: 'partially-covered',
          claimsSupported: [],
        }),
        expect.objectContaining({
          changePath: 'src/B.jsx',
          siteIds: ['site-b'],
          status: 'covered',
          claimsSupported: ['checks-passed'],
        }),
        expect.objectContaining({
          changePath: 'styles/C.css',
          status: 'uncovered',
          detail: 'no configured repository check applies to this path',
        }),
      ],
    });
  });
});

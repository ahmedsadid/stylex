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
  evidenceCacheKey,
  initializeProject,
  loadCachedExecution,
  runCommandProvider,
  saveCachedExecution,
} from '../src/index';
import type {
  CommandCacheProbe,
  CommandExecution,
  CommandProviderConfig,
  EvidenceCacheInputs,
  ProjectState,
  RepositoryEvidenceSubject,
} from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

const SUBJECT: RepositoryEvidenceSubject = Object.freeze({
  kind: 'candidate',
  id: 'subject-1',
  candidateId: 'candidate-1',
  candidateIds: Object.freeze(['candidate-1']),
  changes: Object.freeze([
    Object.freeze({
      path: 'src/A.js',
      sourceHash: 'source',
      targetHash: 'target',
      siteIds: Object.freeze(['site-1']),
    }),
  ]),
});

function provider(counter: string): CommandProviderConfig {
  return {
    id: 'repo-test',
    kind: 'command',
    check: 'focused-test',
    checkVersion: 'selection-v1',
    subject: 'candidate',
    cost: 'cheap',
    argv: [
      process.execPath,
      '-e',
      "const fs=require('fs');const p=process.argv[1];const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));process.stdout.write('pass')",
      counter,
    ],
    versionArgv: [process.execPath, '-e', "process.stdout.write('fixture-v1')"],
    cwd: '.',
    allowedEnv: ['PATH'],
    fileGlobs: ['src/**'],
    limitations: [],
    timeoutMs: 5000,
  };
}

describe('M5 exact repository evidence cache', () => {
  let repo: string;
  let project: ProjectState;

  beforeEach(() => {
    repo = createTempRepo({ 'src/A.js': 'export const A = 1;\n' });
    project = initializeProject({ repositoryRoot: repo });
  });

  afterEach(() => {
    removeTempDir(repo);
  });

  test('a hit skips the expensive command but still probes its current version', async () => {
    const counter = path.join(repo, '.stylex-migrate', 'command-count');
    const config = provider(counter);
    let firstProbe: CommandCacheProbe | null = null;
    const first = await runCommandProvider(config, {
      workspaceRoot: repo,
      subject: SUBJECT,
      lookupCached: async (probe) => {
        firstProbe = probe;
        return null;
      },
    });
    expect(first.evidence.result).toBe('pass');
    expect(fs.readFileSync(counter, 'utf8')).toBe('1');
    if (firstProbe == null) {
      throw new Error('provider did not expose a cache probe');
    }
    const inputs: EvidenceCacheInputs = {
      subject: SUBJECT,
      provider: config,
      probe: firstProbe,
    };
    saveCachedExecution(project, inputs, first);

    let cacheHit = false;
    const second = await runCommandProvider(config, {
      workspaceRoot: repo,
      subject: SUBJECT,
      lookupCached: async (probe) => {
        const cached = loadCachedExecution(
          project,
          { subject: SUBJECT, provider: config, probe },
          8192,
        );
        cacheHit = cached != null;
        return cached;
      },
    });
    expect(cacheHit).toBe(true);
    expect(second.evidence.id).toBe(first.evidence.id);
    expect(second.fullOutput).toEqual(first.fullOutput);
    expect(fs.readFileSync(counter, 'utf8')).toBe('1');
  });

  test('every cache input participates in the key', () => {
    const config = provider('/tmp/not-executed');
    const probe: CommandCacheProbe = {
      providerVersion: 'fixture-v1',
      argv: config.argv,
      versionArgv: config.versionArgv,
      cwd: config.cwd,
      allowedEnvKeys: config.allowedEnv,
      environmentFingerprint: 'environment-1',
      platform: { platform: 'test', architecture: 'x64', node: 'v1' },
    };
    const base = { subject: SUBJECT, provider: config, probe };
    const key = evidenceCacheKey(base);
    for (const changed of [
      { ...base, subject: { ...SUBJECT, id: 'subject-2' } },
      {
        ...base,
        provider: { ...config, argv: [...config.argv, '--changed'] },
      },
      { ...base, probe: { ...probe, providerVersion: 'fixture-v2' } },
      {
        ...base,
        probe: { ...probe, environmentFingerprint: 'environment-2' },
      },
      {
        ...base,
        probe: {
          ...probe,
          platform: { ...probe.platform, architecture: 'arm64' },
        },
      },
    ]) {
      expect(evidenceCacheKey(changed as $FlowFixMe)).not.toBe(key);
    }
  });

  test('failed evidence cannot become a sticky cache entry', () => {
    const config = provider('/tmp/not-executed');
    const probe: CommandCacheProbe = {
      providerVersion: 'fixture-v1',
      argv: config.argv,
      versionArgv: config.versionArgv,
      cwd: '.',
      allowedEnvKeys: ['PATH'],
      environmentFingerprint: 'environment',
      platform: { platform: 'test', architecture: 'x64', node: 'v1' },
    };
    const execution: CommandExecution = {
      evidence: {
        id: 'failure',
        check: 'focused-test',
        checkVersion: 'selection-v1',
        provider: 'repo-test',
        providerVersion: 'fixture-v1',
        subject: SUBJECT,
        result: 'fail',
        command: {
          argv: config.argv,
          versionArgv: config.versionArgv,
          cwd: '.',
          allowedEnvKeys: ['PATH'],
          environmentFingerprint: 'environment',
          exitCode: 1,
        },
        platform: probe.platform,
        startedAt: '2026-08-10T00:00:00.000Z',
        durationMs: 1,
        outputHash: 'not-used',
        outputSize: 0,
        outputPreview: '',
        limitations: [],
      },
      fullOutput: Buffer.alloc(0),
    };
    expect(() =>
      saveCachedExecution(
        project,
        { subject: SUBJECT, provider: config, probe },
        execution,
      ),
    ).toThrow('Only passing repository evidence may be cached');
  });
});

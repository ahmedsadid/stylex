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
  createEvidenceSchedule,
  initializeProject,
  readArtifact,
  runEvidenceSchedule,
} from '../src/index';
import type {
  CommandProviderConfig,
  EvidenceConfig,
  EvidenceCost,
  ProjectState,
  RepositoryEvidenceSubject,
} from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

const SUBJECT: RepositoryEvidenceSubject = Object.freeze({
  kind: 'candidate',
  id: 'candidate-subject',
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

function provider({
  id,
  cost,
  exitCode,
  delayMs,
  log,
}: {
  +id: string,
  +cost: EvidenceCost,
  +exitCode: number,
  +delayMs: number,
  +log: string,
}): CommandProviderConfig {
  const script =
    "const fs=require('fs');const [log,id,delay,code]=process.argv.slice(1);fs.appendFileSync(log,id+'-start\\n');setTimeout(()=>{fs.appendFileSync(log,id+'-end\\n');process.exit(Number(code))},Number(delay))";
  return {
    id,
    kind: 'command',
    check: id.startsWith('cheap') ? 'focused-test' : 'build',
    checkVersion: `${id}-v1`,
    subject: 'candidate',
    cost,
    argv: [
      process.execPath,
      '-e',
      script,
      log,
      id,
      String(delayMs),
      String(exitCode),
    ],
    versionArgv: [
      process.execPath,
      '-e',
      `process.stdout.write('${id}-tool-v1')`,
    ],
    cwd: '.',
    allowedEnv: ['PATH'],
    fileGlobs: ['src/**'],
    limitations: [],
    timeoutMs: 5000,
  };
}

describe('M5 evidence scheduling and history', () => {
  let repo: string;
  let project: ProjectState;
  let log: string;
  let config: EvidenceConfig;

  beforeEach(() => {
    repo = createTempRepo({ 'src/A.js': 'export const A = 1;\n' });
    project = initializeProject({ repositoryRoot: repo });
    log = path.join(project.stateRoot, 'schedule.log');
    config = {
      concurrency: 2,
      outputPreviewBytes: 1024,
      providers: [
        provider({
          id: 'cheap-a',
          cost: 'cheap',
          exitCode: 0,
          delayMs: 80,
          log,
        }),
        provider({
          id: 'cheap-b',
          cost: 'cheap',
          exitCode: 0,
          delayMs: 50,
          log,
        }),
        provider({
          id: 'standard-fail',
          cost: 'standard',
          exitCode: 3,
          delayMs: 5,
          log,
        }),
        provider({
          id: 'expensive',
          cost: 'expensive',
          exitCode: 0,
          delayMs: 5,
          log,
        }),
      ],
    };
  });

  afterEach(() => {
    removeTempDir(repo);
  });

  test('runs tiers cheap-first, parallelizes peers, and skips after failure', async () => {
    const result = await runEvidenceSchedule({
      project,
      workspaceRoot: repo,
      subject: SUBJECT,
      config,
    });
    expect(result.entries.map((entry) => entry.providerId)).toEqual([
      'cheap-a',
      'cheap-b',
      'standard-fail',
    ]);
    expect(result.skippedProviderIds).toEqual(['expensive']);
    expect(result.entries.map((entry) => entry.evidence.result)).toEqual([
      'pass',
      'pass',
      'fail',
    ]);
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(lines.indexOf('standard-fail-start')).toBeGreaterThan(
      lines.indexOf('cheap-a-end'),
    );
    expect(lines.indexOf('standard-fail-start')).toBeGreaterThan(
      lines.indexOf('cheap-b-end'),
    );
    expect(lines).not.toContain('expensive-start');
    for (const entry of result.entries) {
      expect(readArtifact(project, entry.outputArtifact.hash).length).toBe(
        entry.outputArtifact.size,
      );
    }

    const next = createEvidenceSchedule({ project, subject: SUBJECT, config });
    for (const entry of result.entries) {
      expect(
        next.items.find((item) => item.providerId === entry.providerId)
          ?.estimatedDurationMs,
      ).toBe(entry.evidence.durationMs);
    }
  });

  test('reuses passing cheap checks but reruns a failed check', async () => {
    await runEvidenceSchedule({
      project,
      workspaceRoot: repo,
      subject: SUBJECT,
      config,
    });
    fs.writeFileSync(log, '', 'utf8');
    const second = await runEvidenceSchedule({
      project,
      workspaceRoot: repo,
      subject: SUBJECT,
      config,
    });
    expect(second.entries.map((entry) => entry.cacheHit)).toEqual([
      true,
      true,
      false,
    ]);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'standard-fail-start',
      'standard-fail-end',
    ]);
  });

  test('counts every process in the bootstrap verifier', () => {
    const schedule = createEvidenceSchedule({
      project,
      subject: SUBJECT,
      config: {
        concurrency: 1,
        outputPreviewBytes: 1024,
        providers: [
          {
            id: 'bootstrap-rspack',
            kind: 'bootstrap-rspack',
            check: 'build',
            checkVersion: 'bootstrap-v1',
            subject: 'candidate',
            cost: 'expensive',
            packageManager: 'pnpm',
            packageRoot: '',
            buildCommand: ['corepack', 'pnpm', 'run', 'build'],
            argv: ['stylex-migrate', 'internal', 'bootstrap-rspack'],
            versionArgv: ['stylex-migrate', '--version'],
            cwd: '.',
            allowedEnv: ['PATH'],
            fileGlobs: ['package.json'],
            limitations: [],
            timeoutMs: 1000,
          },
        ],
      },
    });

    expect(schedule.estimatedCommandRuns).toBe(3);
  });
});

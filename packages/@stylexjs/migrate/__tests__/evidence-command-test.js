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
  createEvidenceProviderRegistry,
  runCommandProvider,
} from '../src/index';
import type {
  CommandProviderConfig,
  RepositoryEvidenceSubject,
} from '../src/index';
import { createTempDir, removeTempDir } from './utils/tempRepo';

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

function provider(
  values?: Partial<CommandProviderConfig>,
): CommandProviderConfig {
  return {
    id: 'repo-test',
    kind: 'command',
    check: 'focused-test',
    checkVersion: 'test-selection-v1',
    subject: 'candidate',
    cost: 'cheap',
    argv: [process.execPath, '-e', 'process.exit(0)'],
    versionArgv: [
      process.execPath,
      '-e',
      "process.stdout.write('node-test-v1')",
    ],
    cwd: '.',
    allowedEnv: ['PATH'],
    fileGlobs: ['src/**'],
    limitations: ['fixture provider'],
    timeoutMs: 5000,
    ...values,
  };
}

describe('M5 shell-free command evidence provider', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = createTempDir('stylex-migrate-command-provider-');
    fs.mkdirSync(path.join(workspace, 'sub'));
  });

  afterEach(() => {
    removeTempDir(workspace);
  });

  test('passes literal argv, expands changed files, and allowlists environment', async () => {
    const script = `process.stdout.write(JSON.stringify({
      args: process.argv.slice(1),
      cwd: process.cwd(),
      visible: process.env.VISIBLE ?? null,
      secret: process.env.SECRET ?? null,
    }))`;
    const result = await runCommandProvider(
      provider({
        argv: [
          process.execPath,
          '-e',
          script,
          'literal;$(touch should-not-exist)',
          '{changedFiles}',
        ],
        cwd: 'sub',
        allowedEnv: ['PATH', 'VISIBLE'],
      }),
      {
        workspaceRoot: workspace,
        subject: SUBJECT,
        environment: {
          PATH: process.env.PATH,
          VISIBLE: 'yes',
          SECRET: 'must-not-leak',
        },
      },
    );
    expect(result.evidence.result).toBe('pass');
    expect(result.evidence.providerVersion).toBe('node-test-v1');
    expect(result.evidence.command).toMatchObject({
      argv: expect.arrayContaining([
        'literal;$(touch should-not-exist)',
        'src/A.js',
      ]),
      cwd: 'sub',
      allowedEnvKeys: ['PATH', 'VISIBLE'],
      exitCode: 0,
    });
    const output = result.fullOutput.toString('utf8');
    expect(output).toContain('"visible":"yes"');
    expect(output).toContain('"secret":null');
    expect(output).toContain(path.join(workspace, 'sub'));
    expect(fs.existsSync(path.join(workspace, 'sub', 'should-not-exist'))).toBe(
      false,
    );
  });

  test('missing version tools are unavailable rather than passing', async () => {
    const result = await runCommandProvider(
      provider({
        versionArgv: ['stylex-migrate-tool-that-does-not-exist', '--version'],
      }),
      { workspaceRoot: workspace, subject: SUBJECT },
    );
    expect(result.evidence.result).toBe('unavailable');
    expect(result.evidence.providerVersion).toBe('unavailable');
    expect(result.evidence.command.exitCode).toBe(null);
  });

  test('nonzero commands fail and retain output beyond the preview', async () => {
    const result = await runCommandProvider(
      provider({
        argv: [
          process.execPath,
          '-e',
          "process.stdout.write('x'.repeat(2048)); process.exit(7)",
        ],
      }),
      {
        workspaceRoot: workspace,
        subject: SUBJECT,
        outputPreviewBytes: 256,
      },
    );
    expect(result.evidence.result).toBe('fail');
    expect(result.evidence.detail).toBe('provider exited 7');
    expect(result.evidence.outputPreview).toContain('preview truncated');
    expect(result.fullOutput.length).toBeGreaterThan(2048);
    expect(result.evidence.outputSize).toBe(result.fullOutput.length);
  });

  test('timed-out commands fail even when they ignore graceful termination', async () => {
    const result = await runCommandProvider(
      provider({
        argv: [
          process.execPath,
          '-e',
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
        ],
        timeoutMs: 50,
      }),
      { workspaceRoot: workspace, subject: SUBJECT },
    );
    expect(result.evidence.result).toBe('fail');
    expect(result.evidence.detail).toBe('provider timed out after 50ms');
  });

  test('a provider cannot run against the wrong subject kind', async () => {
    const result = await runCommandProvider(
      provider({ subject: 'apply-plan' }),
      { workspaceRoot: workspace, subject: SUBJECT },
    );
    expect(result.evidence.result).toBe('not-applicable');
    expect(result.evidence.detail).toContain('apply-plan subject');
  });

  test('the registry refuses ambiguous runner replacement', () => {
    const registry = createEvidenceProviderRegistry();
    expect(registry.kinds()).toEqual([
      'bootstrap-rspack',
      'command',
      'generated-runtime-probe',
      'runtime-command',
    ]);
    expect(() => registry.register('command', registry.get('command'))).toThrow(
      'already registered',
    );
  });
});

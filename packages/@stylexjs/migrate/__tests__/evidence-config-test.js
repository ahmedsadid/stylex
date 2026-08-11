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
  STATE_SCHEMA_VERSION,
  canonicalJson,
  hashString,
  initializeProject,
  normalizeEvidenceConfig,
  readConfig,
  writeConfig,
} from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';
import { runCli } from '../src/cli';

const TYPECHECK = {
  id: 'repo-typecheck',
  kind: 'command',
  check: 'typecheck',
  checkVersion: 'flow-config-v1',
  subject: 'apply-plan',
  cost: 'standard',
  argv: ['yarn', 'flow', 'check'],
  versionArgv: ['yarn', 'flow', 'version'],
  cwd: '.',
  allowedEnv: ['PATH', 'CI'],
  fileGlobs: ['**/*.{js,jsx}'],
  limitations: ['does not exercise runtime behavior'],
  timeoutMs: 120000,
};

const RUNTIME = {
  id: 'runtime-playwright',
  kind: 'runtime-command',
  check: 'runtime-render',
  checkVersion: 'runtime-v1',
  subject: 'candidate',
  cost: 'expensive',
  runtimeInterface: 'playwright',
  argv: ['node', 'collect-runtime.js'],
  versionArgv: ['node', '--version'],
  cwd: '.',
  allowedEnv: ['PATH'],
  fileGlobs: ['src/**'],
  limitations: ['declared cases only'],
  timeoutMs: 30000,
  cases: [
    {
      id: 'card-default',
      changePaths: ['src/Card.jsx'],
      siteIds: ['site-card'],
      theme: 'default',
      interaction: 'none',
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    },
  ],
};

describe('M5 repository evidence configuration', () => {
  let repo: string;

  beforeEach(() => {
    repo = createTempRepo({ 'src/index.js': 'export const value = 1;\n' });
  });

  afterEach(() => {
    removeTempDir(repo);
  });

  test('normalizes argv-only provider configuration', () => {
    const config = normalizeEvidenceConfig({
      concurrency: 4,
      outputPreviewBytes: 4096,
      providers: [TYPECHECK],
    });
    expect(config.providers[0]).toEqual({
      ...TYPECHECK,
      allowedEnv: ['CI', 'PATH'],
    });
    expect(Object.isFrozen(config.providers[0].argv)).toBe(true);
  });

  test('rejects shell strings, escaping cwd, and an unrecorded PATH', () => {
    for (const provider of [
      { ...TYPECHECK, argv: 'yarn flow check' },
      { ...TYPECHECK, cwd: '../outside' },
      { ...TYPECHECK, allowedEnv: ['CI'] },
    ]) {
      expect(() =>
        normalizeEvidenceConfig({
          concurrency: 1,
          outputPreviewBytes: 1024,
          providers: [provider],
        }),
      ).toThrow('Invalid repository evidence provider configuration');
    }
  });

  test('project config persists providers and accepts pre-M5 config records', () => {
    const project = initializeProject({ repositoryRoot: repo });
    writeConfig(project, {
      sourceGlobs: ['src/**/*.js'],
      evidence: {
        concurrency: 3,
        outputPreviewBytes: 2048,
        providers: [TYPECHECK],
      },
    });
    expect(readConfig(project).evidence.providers[0].id).toBe('repo-typecheck');

    const configFile = path.join(project.stateRoot, 'config.json');
    const document: $FlowFixMe = JSON.parse(
      fs.readFileSync(configFile, 'utf8'),
    );
    const legacy = { sourceGlobs: ['src/**/*.js'] };
    document.config = legacy;
    document.contentHash = hashString(
      canonicalJson({
        schemaVersion: STATE_SCHEMA_VERSION,
        kind: 'config',
        config: legacy,
      }),
    );
    fs.writeFileSync(configFile, JSON.stringify(document), 'utf8');

    expect(readConfig(project)).toMatchObject({
      sourceGlobs: ['src/**/*.js'],
      evidence: { concurrency: 2, outputPreviewBytes: 8192, providers: [] },
    });
  });

  test('normalizes runtime harness interfaces and their declared cases', () => {
    const config = normalizeEvidenceConfig({
      concurrency: 1,
      outputPreviewBytes: 1024,
      providers: [RUNTIME],
    });
    expect(config.providers[0]).toMatchObject({
      kind: 'runtime-command',
      runtimeInterface: 'playwright',
      cases: [
        {
          id: 'card-default',
          changePaths: ['src/Card.jsx'],
          siteIds: ['site-card'],
        },
      ],
    });
    expect(() =>
      normalizeEvidenceConfig({
        concurrency: 1,
        outputPreviewBytes: 1024,
        providers: [{ ...RUNTIME, cases: [] }],
      }),
    ).toThrow('at least one declared case');
  });

  test('the CLI validates and stores a user-authored config document', () => {
    const project = initializeProject({ repositoryRoot: repo });
    const input = path.join(project.stateRoot, 'provider-input.json');
    fs.writeFileSync(
      input,
      JSON.stringify({
        sourceGlobs: ['src/**/*.js'],
        evidence: {
          concurrency: 3,
          outputPreviewBytes: 2048,
          providers: [TYPECHECK],
        },
      }),
      'utf8',
    );
    let stdout = '';
    expect(
      runCli(['config', 'set', input, '--json'], {
        cwd: repo,
        writeStdout: (text) => {
          stdout += text;
        },
      }),
    ).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      command: 'config set',
      config: {
        sourceGlobs: ['src/**/*.js'],
        evidence: { concurrency: 3, providers: [{ id: 'repo-typecheck' }] },
      },
    });

    stdout = '';
    expect(
      runCli(['config', 'show', '--json'], {
        cwd: repo,
        writeStdout: (text) => {
          stdout += text;
        },
      }),
    ).toBe(0);
    expect(JSON.parse(stdout).config.evidence.providers[0].argv).toEqual(
      TYPECHECK.argv,
    );
  });
});

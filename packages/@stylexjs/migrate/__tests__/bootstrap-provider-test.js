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
  BABEL_SENTINEL_CHECK_VERSION,
  BABEL_SENTINEL_LIMITATION,
  RSPACK_SENTINEL_CHECK_VERSION,
  RSPACK_SENTINEL_LIMITATION,
  runBootstrapBabelProvider,
  runBootstrapRspackProvider,
} from '../src/index';
import type {
  BootstrapBabelProviderConfig,
  BootstrapRspackProviderConfig,
  RepositoryEvidenceSubject,
} from '../src/index';
import { createTempDir, removeTempDir } from './utils/tempRepo';

const SUBJECT: RepositoryEvidenceSubject = Object.freeze({
  kind: 'candidate',
  id: 'bootstrap-subject',
  candidateId: 'bootstrap-candidate',
  candidateIds: Object.freeze(['bootstrap-candidate']),
  changes: Object.freeze([
    Object.freeze({
      path: 'package.json',
      sourceHash: 'before',
      targetHash: 'after',
      siteIds: Object.freeze([]),
    }),
  ]),
});

describe('Babel bootstrap emitted-CSS evidence', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = createTempDir('stylex-migrate-babel-provider-');
    const bin = path.join(workspace, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'corepack'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(bin, 'corepack'), 0o755);
    fs.writeFileSync(
      path.join(workspace, 'build.js'),
      "process.stdout.write('repository build passed\\n');\n",
    );
    fs.symlinkSync(
      path.resolve(__dirname, '../../../..', 'node_modules'),
      path.join(workspace, 'node_modules'),
      'dir',
    );
  });

  afterEach(() => removeTempDir(workspace));

  test('requires transform, CSS metadata, and runtime injection', async () => {
    const config: BootstrapBabelProviderConfig = {
      id: 'stylex-bootstrap-babel-fixture',
      kind: 'bootstrap-babel',
      check: 'build',
      checkVersion: BABEL_SENTINEL_CHECK_VERSION,
      subject: 'candidate',
      cost: 'expensive',
      packageManager: 'yarn',
      packageRoot: '',
      buildCommand: [process.execPath, 'build.js'],
      argv: ['stylex-migrate', 'internal', 'bootstrap-babel'],
      versionArgv: ['stylex-migrate', '--version'],
      cwd: '.',
      allowedEnv: ['PATH'],
      fileGlobs: ['package.json'],
      limitations: [BABEL_SENTINEL_LIMITATION],
      timeoutMs: 30000,
    };
    const execution = await runBootstrapBabelProvider(config, {
      workspaceRoot: workspace,
      subject: SUBJECT,
      environment: {
        PATH: `${path.join(workspace, 'bin')}:${process.env.PATH ?? ''}`,
      },
    });
    if (execution.evidence.result !== 'pass') {
      throw new Error(execution.fullOutput.toString('utf8'));
    }
    expect(execution.evidence).toMatchObject({
      result: 'pass',
      checkVersion: BABEL_SENTINEL_CHECK_VERSION,
    });
    expect(execution.fullOutput.toString()).toContain(
      '"runtimeInjection":true',
    );
  });
});

describe('Rspack bootstrap emitted-CSS evidence', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = createTempDir('stylex-migrate-rspack-provider-');
    const bin = path.join(workspace, 'bin');
    fs.mkdirSync(bin);
    const corepack = path.join(bin, 'corepack');
    fs.writeFileSync(corepack, '#!/bin/sh\nexit 0\n', 'utf8');
    fs.chmodSync(corepack, 0o755);
    fs.writeFileSync(
      path.join(workspace, 'build.js'),
      "process.stdout.write('repository build passed\\n');\n",
      'utf8',
    );
    fs.symlinkSync(
      path.resolve(__dirname, '../../../..', 'node_modules'),
      path.join(workspace, 'node_modules'),
      'dir',
    );
  });

  afterEach(() => removeTempDir(workspace));

  test('requires a real transform and emitted sentinel declaration', async () => {
    const config: BootstrapRspackProviderConfig = {
      id: 'stylex-bootstrap-rspack-fixture',
      kind: 'bootstrap-rspack',
      check: 'build',
      checkVersion: RSPACK_SENTINEL_CHECK_VERSION,
      subject: 'candidate',
      cost: 'expensive',
      packageManager: 'pnpm',
      packageRoot: '',
      buildCommand: [process.execPath, 'build.js'],
      argv: ['stylex-migrate', 'internal', 'bootstrap-rspack'],
      versionArgv: ['stylex-migrate', '--version'],
      cwd: '.',
      allowedEnv: ['PATH'],
      fileGlobs: ['package.json'],
      limitations: [RSPACK_SENTINEL_LIMITATION],
      timeoutMs: 30000,
    };
    const execution = await runBootstrapRspackProvider(config, {
      workspaceRoot: workspace,
      subject: SUBJECT,
      environment: {
        PATH: `${path.join(workspace, 'bin')}:${process.env.PATH ?? ''}`,
      },
    });

    expect(execution.evidence).toMatchObject({
      provider: config.id,
      check: 'build',
      checkVersion: RSPACK_SENTINEL_CHECK_VERSION,
      result: 'pass',
      detail: expect.stringContaining('repository application build passed'),
      command: {
        argv: expect.arrayContaining(['bootstrap-rspack']),
        exitCode: 0,
      },
    });
    expect(execution.fullOutput.toString('utf8')).toContain(
      '"transformedJavaScript":true',
    );
  });
});

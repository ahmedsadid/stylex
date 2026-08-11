/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { inspectBootstrap } from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

describe('StyleX repository bootstrap discovery', () => {
  let repo: string;

  afterEach(() => {
    removeTempDir(repo);
  });

  test('finds a pinned pnpm Rspack application that still needs StyleX', () => {
    repo = createTempRepo({
      'package.json': JSON.stringify({
        name: 'app',
        packageManager: 'pnpm@10.30.2+sha512.deadbeef',
        scripts: { build: 'rspack --config rspack.config.ts' },
      }),
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'rspack.config.ts':
        "import rspack from '@rspack/core';\nexport default {};\n",
      'src/App.tsx': 'export const App = () => null;\n',
    });

    const inspection = inspectBootstrap({
      repositoryRoot: repo,
      sourceFiles: ['src/App.tsx'],
      now: () => '2026-08-11T00:00:00.000Z',
    });

    expect(inspection.packageManager).toEqual(
      expect.objectContaining({
        status: 'known',
        name: 'pnpm',
        version: '10.30.2',
        lockfile: 'pnpm-lock.yaml',
      }),
    );
    expect(inspection.packages).toEqual([
      expect.objectContaining({
        root: '',
        manifestPath: 'package.json',
        name: 'app',
        stylexDependencies: {},
      }),
    ]);
    expect(inspection.integrations).toContainEqual(
      expect.objectContaining({
        kind: 'rspack',
        status: 'known',
        configFiles: ['rspack.config.ts'],
        stylexConfigured: false,
      }),
    );
    expect(inspection.inputFiles).toEqual([
      'package.json',
      'pnpm-lock.yaml',
      'rspack.config.ts',
    ]);
  });

  test('finds the nearest workspace package for selected source', () => {
    repo = createTempRepo({
      'package.json': JSON.stringify({
        name: 'workspace',
        packageManager: 'yarn@1.22.22',
      }),
      'yarn.lock': '# lock\n',
      'babel.config.js':
        "module.exports = {plugins: ['@stylexjs/babel-plugin']};\n",
      'packages/card/package.json': JSON.stringify({
        name: '@fixture/card',
        dependencies: { '@stylexjs/stylex': '^0.19.0' },
      }),
      'packages/card/src/Card.jsx': 'export const Card = () => null;\n',
    });

    const inspection = inspectBootstrap({
      repositoryRoot: repo,
      sourceFiles: ['packages/card/src/Card.jsx'],
    });

    expect(inspection.packages).toEqual([
      expect.objectContaining({ manifestPath: 'package.json' }),
      expect.objectContaining({
        root: 'packages/card',
        manifestPath: 'packages/card/package.json',
        stylexDependencies: { '@stylexjs/stylex': '^0.19.0' },
      }),
    ]);
    expect(inspection.integrations).toContainEqual(
      expect.objectContaining({
        kind: 'babel',
        stylexConfigured: true,
        stylexSources: ['babel.config.js'],
      }),
    );
  });

  test('reports conflicting package-manager evidence as resolution-failed', () => {
    repo = createTempRepo({
      'package.json': JSON.stringify({
        name: 'conflict',
        packageManager: 'pnpm@10.0.0',
      }),
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'yarn.lock': '# stale competing lock\n',
    });

    const inspection = inspectBootstrap({ repositoryRoot: repo });

    expect(inspection.packageManager).toMatchObject({
      status: 'resolution-failed',
      name: 'pnpm',
      lockfile: null,
    });
    expect(
      inspection.facts.find(
        (fact) => fact.kind === 'stylex-bootstrap-package-manager',
      ),
    ).toMatchObject({ status: 'resolution-failed' });
  });

  test('records malformed manifests without treating StyleX as absent', () => {
    repo = createTempRepo({
      'package.json': '{broken',
      'src/App.js': 'export const App = null;\n',
    });

    const inspection = inspectBootstrap({
      repositoryRoot: repo,
      sourceFiles: ['src/App.js'],
    });

    expect(inspection.packageManager.status).toBe('resolution-failed');
    expect(inspection.packages[0]).toMatchObject({
      status: 'resolution-failed',
      stylexDependencies: {},
    });
  });

  test('content identity does not depend on inspection time', () => {
    repo = createTempRepo({
      'package.json': JSON.stringify({ name: 'fixture' }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3 }),
    });
    const first = inspectBootstrap({
      repositoryRoot: repo,
      now: () => '2026-08-11T00:00:00.000Z',
    });
    const second = inspectBootstrap({
      repositoryRoot: repo,
      now: () => '2026-08-12T00:00:00.000Z',
    });

    expect(second.id).toBe(first.id);
    expect(second.inspectedAt).not.toBe(first.inspectedAt);
  });
});

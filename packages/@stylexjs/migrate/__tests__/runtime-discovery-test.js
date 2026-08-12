/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { runCli } from '../src/cli';
import { inspectRuntimeSurfaces } from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

describe('runtime surface discovery', () => {
  let repo: string;

  afterEach(() => removeTempDir(repo));

  test('distinguishes configured surfaces from dependency-only possibilities', () => {
    repo = createTempRepo({
      'package.json': JSON.stringify({
        scripts: { e2e: 'playwright test', test: 'jest --runInBand' },
        devDependencies: {
          '@playwright/test': '1.61.1',
          '@storybook/react': '10.0.0',
          '@testing-library/react': '16.3.2',
          jest: '30.4.2',
        },
      }),
      'playwright.config.ts': 'export default {};\n',
    });
    expect(inspectRuntimeSurfaces({ repositoryRoot: repo })).toMatchObject({
      id: expect.stringMatching(/^runtime-surfaces-/),
      surfaces: [
        {
          kind: 'component-test',
          status: 'known',
          packageScripts: [{ name: 'test', command: 'jest --runInBand' }],
        },
        { kind: 'playwright', status: 'known' },
        {
          kind: 'storybook',
          status: 'inferred',
          configFiles: [],
          packageScripts: [],
        },
      ],
      inputFiles: ['package.json', 'playwright.config.ts'],
    });
  });

  test('exposes stable CLI output without inventing a fallback', () => {
    repo = createTempRepo({ 'package.json': '{"private":true}\n' });
    let stdout = '';
    expect(
      runCli(['runtime', 'inspect', '--json'], {
        cwd: repo,
        writeStdout: (text) => (stdout += text),
      }),
    ).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      command: 'runtime inspect',
      discovery: {
        surfaces: [
          { kind: 'component-test', status: 'unknown' },
          { kind: 'playwright', status: 'unknown' },
          { kind: 'storybook', status: 'unknown' },
        ],
      },
    });
  });
});

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
import { runCli } from '../src/cli';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

describe('M3 stylex-migrate lifecycle CLI', () => {
  let repo: string;

  beforeEach(() => {
    repo = createTempRepo({ 'src/index.js': 'export const value = 1;\n' });
  });

  afterEach(() => {
    removeTempDir(repo);
  });

  test('the CLI survives process-style reopen between commands', () => {
    let stdout = '';
    const writeStdout = (text: string) => {
      stdout += text;
    };
    expect(runCli(['init', '--json'], { cwd: repo, writeStdout })).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      command: 'init',
      schemaVersion: 2,
    });

    stdout = '';
    expect(runCli(['status', '--json'], { cwd: repo, writeStdout })).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      command: 'status',
      eventCount: 0,
      counts: {
        applications: 0,
        candidates: 0,
        clusters: 0,
        decisions: 0,
        files: 0,
        verdicts: 0,
        tasks: 0,
        attempts: 0,
      },
    });
  });

  test('the package exposes the stylex-migrate executable', () => {
    const manifest: $FlowFixMe = require('../package.json');
    expect(manifest.bin).toEqual({ 'stylex-migrate': './lib/cli.js' });
    expect(
      fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8'),
    ).toMatch(/^#!\/usr\/bin\/env node/);
    expect(
      fs.statSync(path.join(__dirname, '../src/cli.js')).mode & 0o111,
    ).not.toBe(0);
  });
});

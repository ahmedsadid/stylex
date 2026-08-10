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
import { execFileSync } from 'child_process';
import {
  STATE_SCHEMA_VERSION,
  initializeProject,
  readArtifact,
  readConfig,
  readRecord,
  writeArtifact,
  writeRecord,
} from '../src/index';
import { createTempDir, createTempRepo, removeTempDir } from './utils/tempRepo';

function git(repo: string, args: $ReadOnlyArray<string>): string {
  return String(
    execFileSync('git', [...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe',
    }),
  ).trim();
}

function json(file: string): $FlowFixMe {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('M3 project-local storage', () => {
  let repo: string;

  beforeEach(() => {
    repo = createTempRepo({ 'src/index.js': 'export const value = 1;\n' });
  });

  afterEach(() => {
    removeTempDir(repo);
  });

  test('init creates the layout, ignores it locally, and never creates a commit', () => {
    const before = git(repo, ['rev-parse', 'HEAD']);
    const first = initializeProject({
      repositoryRoot: repo,
      now: () => '2026-08-10T00:00:00.000Z',
    });
    const second = initializeProject({ repositoryRoot: repo });

    expect(first.stateRoot).toBe(
      path.join(fs.realpathSync(repo), '.stylex-migrate'),
    );
    expect(second.schemaVersion).toBe(STATE_SCHEMA_VERSION);
    expect(readConfig(second)).toMatchObject({
      sourceGlobs: ['**/*.{js,jsx,ts,tsx}'],
      evidence: { concurrency: 2, outputPreviewBytes: 8192, providers: [] },
    });
    for (const name of [
      'events',
      'candidates',
      'evidence',
      'verdicts',
      'approvals',
      'decisions',
      'applications',
      'indexes',
      'artifacts',
      'reports',
      'backups',
    ]) {
      expect(fs.statSync(path.join(first.stateRoot, name)).isDirectory()).toBe(
        true,
      );
    }
    const excludeResult = git(repo, [
      'rev-parse',
      '--git-path',
      'info/exclude',
    ]);
    const exclude = path.isAbsolute(excludeResult)
      ? excludeResult
      : path.resolve(repo, excludeResult);
    expect(
      fs
        .readFileSync(exclude, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line === '.stylex-migrate/'),
    ).toHaveLength(1);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(before);
  });

  test('a failed atomic replacement leaves the previous record intact', () => {
    const project = initializeProject({ repositoryRoot: repo });
    writeRecord(project, 'decisions', 'theme', { answer: 'old' });

    expect(() =>
      writeRecord(
        project,
        'decisions',
        'theme',
        { answer: 'new' },
        {
          io: {
            renameSync: () => {
              throw new Error('simulated interruption');
            },
          },
        },
      ),
    ).toThrow('simulated interruption');
    expect(readRecord(project, 'decisions', 'theme').payload).toEqual({
      answer: 'old',
    });
    expect(
      fs
        .readdirSync(path.join(project.stateRoot, 'decisions'))
        .some((file) => file.endsWith('.tmp')),
    ).toBe(false);
  });

  test('state records snapshot and deeply freeze caller-owned JSON', () => {
    const project = initializeProject({ repositoryRoot: repo });
    const payload = { nested: { value: 'original' } };
    const record = writeRecord(project, 'decisions', 'immutable', payload);
    payload.nested.value = 'mutated later';

    expect(record.payload).toEqual({ nested: { value: 'original' } });
    const stored: $FlowFixMe = record.payload;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.nested)).toBe(true);
  });

  test('init refuses a symlinked state directory', () => {
    const outside = createTempDir('stylex-migrate-state-outside-');
    try {
      fs.symlinkSync(outside, path.join(repo, '.stylex-migrate'));
      expect(() => initializeProject({ repositoryRoot: repo })).toThrow(
        'must be a real directory',
      );
    } finally {
      fs.rmSync(path.join(repo, '.stylex-migrate'), { force: true });
      removeTempDir(outside);
    }
  });

  test('editing a record or an artifact is detected', () => {
    const project = initializeProject({ repositoryRoot: repo });
    writeRecord(project, 'candidates', 'candidate-1', { state: 'frozen' });
    const recordFile = path.join(
      project.stateRoot,
      'candidates',
      'candidate-1.json',
    );
    const changed = json(recordFile);
    changed.payload.state = 'applied';
    fs.writeFileSync(recordFile, JSON.stringify(changed), 'utf8');
    expect(() => readRecord(project, 'candidates', 'candidate-1')).toThrow(
      'Integrity check failed',
    );

    const artifact = writeArtifact(project, Buffer.from('candidate bytes'));
    const artifactFile = path.join(
      project.stateRoot,
      'artifacts',
      artifact.hash.slice(0, 2),
      artifact.hash,
    );
    fs.writeFileSync(artifactFile, 'different bytes', 'utf8');
    expect(() => readArtifact(project, artifact.hash)).toThrow(
      'Integrity check failed',
    );
  });

  test('editing project config is detected', () => {
    const project = initializeProject({ repositoryRoot: repo });
    const configFile = path.join(project.stateRoot, 'config.json');
    const config = json(configFile);
    config.config.sourceGlobs = ['private/**/*.js'];
    fs.writeFileSync(configFile, JSON.stringify(config), 'utf8');
    expect(() => readConfig(project)).toThrow('Integrity check failed');
  });
});

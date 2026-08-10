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
  cleanupProject,
  initializeProject,
  migrateProject,
  readArtifact,
  redact,
  redactText,
  writeArtifact,
  writeRecord,
} from '../src/index';
import { writeJsonAtomic } from '../src/state/json';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

function json(file: string): $FlowFixMe {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('M3 project-state maintenance', () => {
  let repo: string;

  beforeEach(() => {
    repo = createTempRepo({ 'src/index.js': 'export const value = 1;\n' });
  });

  afterEach(() => {
    removeTempDir(repo);
  });

  test('schema migration supports dry-run and creates a backup before changing state', () => {
    const project = initializeProject({ repositoryRoot: repo });
    const schemaFile = path.join(project.stateRoot, 'schema.json');
    writeJsonAtomic(schemaFile, {
      schemaVersion: 0,
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    const dryRun = migrateProject({ repositoryRoot: repo, dryRun: true });
    expect(dryRun).toMatchObject({
      fromVersion: 0,
      toVersion: 1,
      dryRun: true,
      changed: true,
      backupPath: null,
    });
    expect(json(schemaFile).schemaVersion).toBe(0);

    const migrated = migrateProject({
      repositoryRoot: repo,
      now: () => '2026-08-10T01:02:03.000Z',
    });
    expect(migrated.backupPath).not.toBeNull();
    expect(json(schemaFile).schemaVersion).toBe(1);
    if (migrated.backupPath != null) {
      expect(
        json(path.join(migrated.backupPath, 'schema.json')).schemaVersion,
      ).toBe(0);
    }
  });

  test('cleanup is a dry-run by default and preserves referenced artifacts', () => {
    const project = initializeProject({ repositoryRoot: repo });
    const kept = writeArtifact(project, Buffer.from('keep'));
    const unused = writeArtifact(project, Buffer.from('unused'));
    writeRecord(project, 'applications', 'application-1', {
      state: 'applied',
      recoveryArtifactHash: kept.hash,
    });

    const preview = cleanupProject({ project });
    expect(preview.removed).toEqual([]);
    expect(preview.unreferencedArtifacts).toHaveLength(1);
    expect(readArtifact(project, unused.hash).toString('utf8')).toBe('unused');

    const cleaned = cleanupProject({ project, confirm: true });
    expect(cleaned.removed).toHaveLength(1);
    expect(readArtifact(project, kept.hash).toString('utf8')).toBe('keep');
    expect(() => readArtifact(project, unused.hash)).toThrow();
  });

  test('structured and textual output redact common credentials', () => {
    expect(
      redact({
        token: 'abc',
        nested: { password: 'def', ordinary: 'visible' },
      }),
    ).toEqual({
      token: '[REDACTED]',
      nested: { password: '[REDACTED]', ordinary: 'visible' },
    });
    expect(
      redactText('Bearer abc.def https://host/?access_token=secret&x=1'),
    ).toBe('Bearer [REDACTED] https://host/?access_token=[REDACTED]&x=1');
  });
});

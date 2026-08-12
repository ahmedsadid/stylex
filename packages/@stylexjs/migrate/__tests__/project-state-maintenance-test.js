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
  RECORD_COLLECTIONS,
  appendStateEvent,
  canonicalJson,
  cleanupProject,
  hashString,
  initializeProject,
  migrateProject,
  openProject,
  readArtifact,
  readRecord,
  replayEvents,
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

function downgradeToSchemaV1(stateRoot: string): void {
  const configFile = path.join(stateRoot, 'config.json');
  const config = json(configFile);
  config.schemaVersion = 1;
  config.contentHash = hashString(
    canonicalJson({
      schemaVersion: 1,
      kind: 'config',
      config: config.config,
    }),
  );
  writeJsonAtomic(configFile, config);

  for (const collection of RECORD_COLLECTIONS) {
    const directory = path.join(stateRoot, collection);
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const record = json(file);
      record.schemaVersion = 1;
      record.contentHash = hashString(
        canonicalJson({
          schemaVersion: 1,
          collection,
          id: record.id,
          payload: record.payload,
        }),
      );
      writeJsonAtomic(file, record);
    }
  }

  const events = path.join(stateRoot, 'events');
  const staging = path.join(stateRoot, 'events-v1-fixture');
  fs.mkdirSync(staging);
  let previousEventHash: string | null = null;
  for (const name of fs.readdirSync(events).sort()) {
    const event = json(path.join(events, name));
    const body: $FlowFixMe = {
      schemaVersion: 1,
      sequence: event.sequence,
      previousEventHash,
      entityKind: event.entityKind,
      entityId: event.entityId,
      state: event.state,
      timestamp: event.timestamp,
      data: event.data,
    };
    const eventHash: string = hashString(canonicalJson(body));
    writeJsonAtomic(
      path.join(
        staging,
        `${String(event.sequence).padStart(12, '0')}-${eventHash}.json`,
      ),
      { ...body, eventHash },
    );
    previousEventHash = eventHash;
  }
  fs.rmSync(events, { recursive: true });
  fs.renameSync(staging, events);
  fs.rmSync(path.join(stateRoot, 'tasks'), { recursive: true });
  fs.rmSync(path.join(stateRoot, 'attempts'), { recursive: true });
  writeJsonAtomic(path.join(stateRoot, 'schema.json'), {
    schemaVersion: 1,
    format: 'stylex-migrate-project-state',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  });
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
    writeRecord(project, 'decisions', 'theme-map', { state: 'approved' });
    appendStateEvent({
      project,
      entityKind: 'decision',
      entityId: 'theme-map',
      state: 'approved',
      data: { artifact: 'theme-map' },
    });
    downgradeToSchemaV1(project.stateRoot);

    const dryRun = migrateProject({ repositoryRoot: repo, dryRun: true });
    expect(dryRun).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      dryRun: true,
      changed: true,
      backupPath: null,
    });
    expect(json(schemaFile).schemaVersion).toBe(1);

    const migrated = migrateProject({
      repositoryRoot: repo,
      now: () => '2026-08-10T01:02:03.000Z',
    });
    expect(migrated.backupPath).not.toBeNull();
    expect(json(schemaFile).schemaVersion).toBe(2);
    if (migrated.backupPath != null) {
      expect(
        json(path.join(migrated.backupPath, 'schema.json')).schemaVersion,
      ).toBe(1);
    }
    expect(
      fs.statSync(path.join(project.stateRoot, 'tasks')).isDirectory(),
    ).toBe(true);
    expect(
      fs.statSync(path.join(project.stateRoot, 'attempts')).isDirectory(),
    ).toBe(true);
    const reopened = openProject(repo);
    expect(readRecord(reopened, 'decisions', 'theme-map').payload).toEqual({
      state: 'approved',
    });
    expect(replayEvents(reopened).indexes.decisions['theme-map'].state).toBe(
      'approved',
    );
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

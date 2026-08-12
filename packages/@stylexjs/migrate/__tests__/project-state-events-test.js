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
  appendStateEvent,
  initializeProject,
  openProject,
  readRecord,
  rebuildIndexes,
  replayEvents,
} from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

function json(file: string): $FlowFixMe {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('M3 replayable state events', () => {
  let repo: string;

  beforeEach(() => {
    repo = createTempRepo({ 'src/index.js': 'export const value = 1;\n' });
  });

  afterEach(() => {
    removeTempDir(repo);
  });

  test('append-only events rebuild identical indexes after a restart', () => {
    const project = initializeProject({ repositoryRoot: repo });
    appendStateEvent({
      project,
      entityKind: 'candidate',
      entityId: 'candidate-1',
      state: 'candidate-created',
      data: { file: 'src/index.js' },
      now: () => '2026-08-10T00:00:01.000Z',
    });
    appendStateEvent({
      project,
      entityKind: 'candidate',
      entityId: 'candidate-1',
      state: 'auto-eligible',
      data: { file: 'src/index.js' },
      now: () => '2026-08-10T00:00:02.000Z',
    });
    appendStateEvent({
      project,
      entityKind: 'file',
      entityId: 'src.index.js',
      state: 'planned',
      data: { path: 'src/index.js' },
      now: () => '2026-08-10T00:00:03.000Z',
    });

    const before = replayEvents(project);
    for (const file of fs.readdirSync(
      path.join(project.stateRoot, 'indexes'),
    )) {
      fs.rmSync(path.join(project.stateRoot, 'indexes', file));
    }
    const reopened = openProject(repo);
    const rebuilt = rebuildIndexes(reopened);
    expect(rebuilt.indexes).toEqual(before.indexes);
    expect(readRecord(reopened, 'indexes', 'candidates').payload).toEqual(
      before.indexes.candidates,
    );
    expect(rebuilt.indexes.candidates['candidate-1'].state).toBe(
      'auto-eligible',
    );
  });

  test('editing an event breaks replay integrity', () => {
    const project = initializeProject({ repositoryRoot: repo });
    appendStateEvent({
      project,
      entityKind: 'decision',
      entityId: 'theme',
      state: 'active',
    });
    const eventName = fs.readdirSync(path.join(project.stateRoot, 'events'))[0];
    const eventFile = path.join(project.stateRoot, 'events', eventName);
    const event = json(eventFile);
    event.state = 'superseded';
    fs.writeFileSync(eventFile, JSON.stringify(event), 'utf8');
    expect(() => replayEvents(project)).toThrow('Integrity check failed');
  });

  test('a second event writer is refused instead of reusing a sequence', () => {
    const project = initializeProject({ repositoryRoot: repo });
    const lock = path.join(project.stateRoot, 'events.lock');
    fs.writeFileSync(lock, 'another-process\n', 'utf8');
    try {
      expect(() =>
        appendStateEvent({
          project,
          entityKind: 'candidate',
          entityId: 'candidate-1',
          state: 'candidate-created',
        }),
      ).toThrow('locked by another stylex-migrate operation');
      expect(fs.readdirSync(path.join(project.stateRoot, 'events'))).toEqual(
        [],
      );
    } finally {
      fs.rmSync(lock, { force: true });
    }
  });
});

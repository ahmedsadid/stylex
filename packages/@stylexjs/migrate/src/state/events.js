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
import { hashString } from '../kernel/hash';
import {
  canonicalJson,
  immutableJson,
  parseJson,
  writeJsonAtomic,
} from './json';
import { STATE_SCHEMA_VERSION, writeRecord } from './project';
import type { JsonValue } from './json';
import type { ProjectState } from './project';

export type EntityKind =
  | 'candidate'
  | 'file'
  | 'cluster'
  | 'decision'
  | 'verdict'
  | 'application'
  | 'task'
  | 'attempt';

export type StateEvent = {
  +schemaVersion: number,
  +sequence: number,
  +previousEventHash: string | null,
  +entityKind: EntityKind,
  +entityId: string,
  +state: string,
  +timestamp: string,
  +data: JsonValue,
  +eventHash: string,
};

export type IndexEntry = {
  +id: string,
  +state: string,
  +lastEventHash: string,
  +lastSequence: number,
  +updatedAt: string,
  +data: JsonValue,
};

export type StateIndexes = {
  +candidates: { +[string]: IndexEntry },
  +files: { +[string]: IndexEntry },
  +clusters: { +[string]: IndexEntry },
  +decisions: { +[string]: IndexEntry },
  +verdicts: { +[string]: IndexEntry },
  +applications: { +[string]: IndexEntry },
  +tasks: { +[string]: IndexEntry },
  +attempts: { +[string]: IndexEntry },
};

type MutableIndex = { [string]: IndexEntry };
type MutableStateIndexes = {
  candidates: MutableIndex,
  files: MutableIndex,
  clusters: MutableIndex,
  decisions: MutableIndex,
  verdicts: MutableIndex,
  applications: MutableIndex,
  tasks: MutableIndex,
  attempts: MutableIndex,
};

export type ReplayResult = {
  +lastSequence: number,
  +lastEventHash: string | null,
  +indexes: StateIndexes,
};

const INDEX_FOR_KIND: { +[EntityKind]: $Keys<StateIndexes> } = {
  candidate: 'candidates',
  file: 'files',
  cluster: 'clusters',
  decision: 'decisions',
  verdict: 'verdicts',
  application: 'applications',
  task: 'tasks',
  attempt: 'attempts',
};
const ENTITY_KINDS: $ReadOnlySet<string> = new Set(Object.keys(INDEX_FOR_KIND));

function emptyIndexes(): MutableStateIndexes {
  return {
    candidates: {},
    files: {},
    clusters: {},
    decisions: {},
    verdicts: {},
    applications: {},
    tasks: {},
    attempts: {},
  };
}

function indexFor(
  indexes: MutableStateIndexes,
  kind: EntityKind,
): MutableIndex {
  switch (kind) {
    case 'candidate':
      return indexes.candidates;
    case 'file':
      return indexes.files;
    case 'cluster':
      return indexes.clusters;
    case 'decision':
      return indexes.decisions;
    case 'verdict':
      return indexes.verdicts;
    case 'application':
      return indexes.applications;
    case 'task':
      return indexes.tasks;
    case 'attempt':
      return indexes.attempts;
    default:
      throw new Error(`Unknown state entity kind: ${String(kind)}`);
  }
}

function eventIdentity(event: {
  +schemaVersion: number,
  +sequence: number,
  +previousEventHash: string | null,
  +entityKind: EntityKind,
  +entityId: string,
  +state: string,
  +timestamp: string,
  +data: JsonValue,
}): string {
  return hashString(canonicalJson(event));
}

function eventFiles(project: ProjectState): $ReadOnlyArray<string> {
  const root = path.join(project.stateRoot, 'events');
  const files = fs.readdirSync(root);
  for (const file of files) {
    if (!/^\d{12}-[a-f0-9]{64}\.json$/.test(file) && !/\.tmp$/.test(file)) {
      throw new Error(`Unexpected state event file ${file}`);
    }
  }
  return files
    .filter((file) => /^\d{12}-[a-f0-9]{64}\.json$/.test(file))
    .sort();
}

function readEvent(project: ProjectState, filename: string): StateEvent {
  const file = path.join(project.stateRoot, 'events', filename);
  const value = parseJson(fs.readFileSync(file, 'utf8'), file);
  if (
    value == null ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    typeof value.sequence !== 'number' ||
    !Number.isInteger(value.sequence) ||
    value.sequence < 1 ||
    (value.previousEventHash !== null &&
      (typeof value.previousEventHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.previousEventHash))) ||
    typeof value.entityKind !== 'string' ||
    !ENTITY_KINDS.has(value.entityKind) ||
    typeof value.entityId !== 'string' ||
    typeof value.state !== 'string' ||
    typeof value.timestamp !== 'string' ||
    typeof value.eventHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.eventHash) ||
    !('data' in value)
  ) {
    throw new Error(`Invalid state event ${filename}`);
  }
  const event: StateEvent = immutableJson(value) as $FlowFixMe;
  const expected = eventIdentity({
    schemaVersion: event.schemaVersion,
    sequence: event.sequence,
    previousEventHash: event.previousEventHash,
    entityKind: event.entityKind,
    entityId: event.entityId,
    state: event.state,
    timestamp: event.timestamp,
    data: event.data,
  });
  if (
    event.schemaVersion !== STATE_SCHEMA_VERSION ||
    event.eventHash !== expected ||
    filename !==
      String(event.sequence).padStart(12, '0') + '-' + event.eventHash + '.json'
  ) {
    throw new Error(`Integrity check failed for state event ${filename}`);
  }
  return event;
}

export function replayEvents(project: ProjectState): ReplayResult {
  const indexes = emptyIndexes();
  let lastSequence = 0;
  let lastEventHash: string | null = null;
  for (const filename of eventFiles(project)) {
    const event = readEvent(project, filename);
    if (event.sequence !== lastSequence + 1) {
      throw new Error(
        `State event sequence is broken at ${event.sequence}; expected ${
          lastSequence + 1
        }`,
      );
    }
    if (event.previousEventHash !== lastEventHash) {
      throw new Error(`State event chain is broken at ${event.sequence}`);
    }
    indexFor(indexes, event.entityKind)[event.entityId] = Object.freeze({
      id: event.entityId,
      state: event.state,
      lastEventHash: event.eventHash,
      lastSequence: event.sequence,
      updatedAt: event.timestamp,
      data: event.data,
    });
    lastSequence = event.sequence;
    lastEventHash = event.eventHash;
  }
  for (const name of Object.values(INDEX_FOR_KIND)) {
    Object.freeze(indexes[name]);
  }
  return Object.freeze({
    lastSequence,
    lastEventHash,
    indexes: Object.freeze(indexes),
  });
}

export function rebuildIndexes(project: ProjectState): ReplayResult {
  const replay = replayEvents(project);
  for (const name of Object.values(INDEX_FOR_KIND).sort()) {
    writeRecord(project, 'indexes', name, replay.indexes[name] as $FlowFixMe);
  }
  return replay;
}

export function appendStateEvent({
  project,
  entityKind,
  entityId,
  state,
  data = {},
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +entityKind: EntityKind,
  +entityId: string,
  +state: string,
  +data?: JsonValue,
  +now?: () => string,
}): StateEvent {
  if (!ENTITY_KINDS.has(entityKind)) {
    throw new Error(`Unknown state entity kind: ${String(entityKind)}`);
  }
  if (entityId === '' || state === '') {
    throw new Error('State events require non-empty entityId and state');
  }
  const lock = path.join(project.stateRoot, 'events.lock');
  let descriptor: number;
  try {
    descriptor = fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (
      error != null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'EEXIST'
    ) {
      throw new Error(
        `Project state is locked by another stylex-migrate operation (${lock})`,
      );
    }
    throw error;
  }
  try {
    fs.writeSync(descriptor, `${process.pid}\n`);
    fs.fsyncSync(descriptor);
    const current = replayEvents(project);
    const body = {
      schemaVersion: STATE_SCHEMA_VERSION,
      sequence: current.lastSequence + 1,
      previousEventHash: current.lastEventHash,
      entityKind,
      entityId,
      state,
      timestamp: now(),
      data: immutableJson(data),
    };
    const event: StateEvent = Object.freeze({
      ...body,
      eventHash: eventIdentity(body),
    });
    const filename =
      String(event.sequence).padStart(12, '0') +
      '-' +
      event.eventHash +
      '.json';
    writeJsonAtomic(path.join(project.stateRoot, 'events', filename), event);
    rebuildIndexes(project);
    return event;
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lock, { force: true });
  }
}

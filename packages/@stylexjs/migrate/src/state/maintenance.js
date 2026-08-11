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
import { canonicalRoot } from '../kernel/snapshot';
import { hashString } from '../kernel/hash';
import { canonicalJson, parseJson, writeJsonAtomic } from './json';
import {
  RECORD_COLLECTIONS,
  STATE_DIRECTORY,
  STATE_SCHEMA_VERSION,
  initializeProject,
  openProject,
  readSchemaVersion,
} from './project';
import { rebuildIndexes } from './events';
import type { JsonValue } from './json';
import type { ProjectState } from './project';

export type MigrationResult = {
  +fromVersion: number,
  +toVersion: number,
  +dryRun: boolean,
  +changed: boolean,
  +backupPath: string | null,
};

export type CleanupResult = {
  +confirmed: boolean,
  +unreferencedArtifacts: $ReadOnlyArray<string>,
  +temporaryFiles: $ReadOnlyArray<string>,
  +removed: $ReadOnlyArray<string>,
};

function copyDirectory(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const name = String(entry.name);
    if (name === 'backups') {
      continue;
    }
    const from = path.join(source, name);
    const to = path.join(destination, name);
    if (entry.isDirectory()) {
      copyDirectory(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    } else {
      throw new Error(`Cannot back up unsupported state entry ${from}`);
    }
  }
}

function migrationBackup(stateRoot: string, now: string): string {
  const safeTime = now.replace(/[^0-9A-Za-z.-]/g, '-');
  const destination = path.join(
    stateRoot,
    'backups',
    `pre-v${STATE_SCHEMA_VERSION}-${safeTime}`,
  );
  copyDirectory(stateRoot, destination);
  return destination;
}

function versionedRecordHash(
  schemaVersion: number,
  collection: string,
  id: string,
  payload: JsonValue,
): string {
  return hashString(canonicalJson({ schemaVersion, collection, id, payload }));
}

function upgradeV1Config(stateRoot: string): void {
  const file = path.join(stateRoot, 'config.json');
  const parsed = parseJson(fs.readFileSync(file, 'utf8'), file);
  if (parsed == null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Cannot migrate an invalid schema-v1 project config');
  }
  const value: {
    +schemaVersion: number,
    +kind: string,
    +writtenAt: string,
    +contentHash: string,
    +config: JsonValue,
  } = parsed as any;
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'config' ||
    typeof value.writtenAt !== 'string' ||
    value.contentHash !==
      hashString(
        canonicalJson({
          schemaVersion: 1,
          kind: 'config',
          config: value.config,
        }),
      )
  ) {
    throw new Error('Cannot migrate an invalid schema-v1 project config');
  }
  writeJsonAtomic(file, {
    ...value,
    schemaVersion: STATE_SCHEMA_VERSION,
    contentHash: hashString(
      canonicalJson({
        schemaVersion: STATE_SCHEMA_VERSION,
        kind: 'config',
        config: value.config,
      }),
    ),
  });
}

function upgradeV1Records(stateRoot: string): void {
  for (const collection of RECORD_COLLECTIONS) {
    const directory = path.join(stateRoot, collection);
    if (!fs.existsSync(directory)) {
      continue;
    }
    for (const name of fs.readdirSync(directory).sort()) {
      if (!name.endsWith('.json')) {
        throw new Error(`Cannot migrate unexpected state file ${name}`);
      }
      const file = path.join(directory, name);
      const parsed = parseJson(fs.readFileSync(file, 'utf8'), file);
      if (
        parsed == null ||
        Array.isArray(parsed) ||
        typeof parsed !== 'object'
      ) {
        throw new Error(`Cannot migrate invalid ${collection} record ${name}`);
      }
      const value: {
        +schemaVersion: number,
        +collection: string,
        +id: string,
        +writtenAt: string,
        +contentHash: string,
        +payload: JsonValue,
      } = parsed as any;
      if (
        value.schemaVersion !== 1 ||
        value.collection !== collection ||
        typeof value.id !== 'string' ||
        name !== `${value.id}.json` ||
        typeof value.writtenAt !== 'string' ||
        value.contentHash !==
          versionedRecordHash(1, collection, value.id, value.payload)
      ) {
        throw new Error(`Cannot migrate invalid ${collection} record ${name}`);
      }
      writeJsonAtomic(file, {
        ...value,
        schemaVersion: STATE_SCHEMA_VERSION,
        contentHash: versionedRecordHash(
          STATE_SCHEMA_VERSION,
          collection,
          value.id,
          value.payload,
        ),
      });
    }
  }
}

function versionedEventHash(value: JsonValue): string {
  return hashString(canonicalJson(value));
}

function upgradeV1Events(stateRoot: string, now: string): void {
  const source = path.join(stateRoot, 'events');
  const safeTime = now.replace(/[^0-9A-Za-z.-]/g, '-');
  const staging = path.join(stateRoot, `events-v2-${safeTime}`);
  const replaced = path.join(stateRoot, `events-v1-${safeTime}`);
  fs.mkdirSync(staging);
  let sequence = 0;
  let oldPrevious: string | null = null;
  let newPrevious: string | null = null;
  for (const name of fs.readdirSync(source).sort()) {
    if (!/^\d{12}-[a-f0-9]{64}\.json$/.test(name)) {
      throw new Error(`Cannot migrate unexpected state event ${name}`);
    }
    const file = path.join(source, name);
    const value: $FlowFixMe = parseJson(fs.readFileSync(file, 'utf8'), file);
    const oldBody = {
      schemaVersion: value.schemaVersion,
      sequence: value.sequence,
      previousEventHash: value.previousEventHash,
      entityKind: value.entityKind,
      entityId: value.entityId,
      state: value.state,
      timestamp: value.timestamp,
      data: value.data,
    };
    const oldHash = versionedEventHash(oldBody as $FlowFixMe);
    if (
      value.schemaVersion !== 1 ||
      value.sequence !== sequence + 1 ||
      value.previousEventHash !== oldPrevious ||
      value.eventHash !== oldHash ||
      name !== `${String(value.sequence).padStart(12, '0')}-${oldHash}.json`
    ) {
      throw new Error(`Cannot migrate invalid state event ${name}`);
    }
    const newBody = {
      ...oldBody,
      schemaVersion: STATE_SCHEMA_VERSION,
      previousEventHash: newPrevious,
    };
    const newHash = versionedEventHash(newBody as $FlowFixMe);
    writeJsonAtomic(
      path.join(
        staging,
        `${String(value.sequence).padStart(12, '0')}-${newHash}.json`,
      ),
      { ...newBody, eventHash: newHash },
    );
    sequence = value.sequence;
    oldPrevious = oldHash;
    newPrevious = newHash;
  }
  fs.renameSync(source, replaced);
  fs.renameSync(staging, source);
  fs.rmSync(replaced, { recursive: true });
}

function upgradeV1State(stateRoot: string, now: string): void {
  upgradeV1Config(stateRoot);
  upgradeV1Records(stateRoot);
  upgradeV1Events(stateRoot, now);
}

export function migrateProject({
  repositoryRoot,
  dryRun = false,
  now = () => new Date().toISOString(),
}: {
  +repositoryRoot: string,
  +dryRun?: boolean,
  +now?: () => string,
}): MigrationResult {
  const root = canonicalRoot(repositoryRoot);
  const stateRoot = path.join(root, STATE_DIRECTORY);
  const fromVersion = readSchemaVersion(root);
  if (fromVersion === STATE_SCHEMA_VERSION) {
    return Object.freeze({
      fromVersion,
      toVersion: STATE_SCHEMA_VERSION,
      dryRun,
      changed: false,
      backupPath: null,
    });
  }
  if (fromVersion !== 0 && fromVersion !== 1) {
    throw new Error(`No migration exists from state schema ${fromVersion}`);
  }
  if (dryRun) {
    return Object.freeze({
      fromVersion,
      toVersion: STATE_SCHEMA_VERSION,
      dryRun: true,
      changed: true,
      backupPath: null,
    });
  }

  const timestamp = now();
  const backupPath = migrationBackup(stateRoot, timestamp);
  const previous = parseJson(
    fs.readFileSync(path.join(stateRoot, 'schema.json'), 'utf8'),
    path.join(stateRoot, 'schema.json'),
  );
  const createdAt =
    previous != null &&
    !Array.isArray(previous) &&
    typeof previous === 'object' &&
    typeof previous.createdAt === 'string'
      ? previous.createdAt
      : timestamp;
  if (fromVersion === 1) {
    upgradeV1State(stateRoot, timestamp);
  }
  writeJsonAtomic(path.join(stateRoot, 'schema.json'), {
    schemaVersion: STATE_SCHEMA_VERSION,
    format: 'stylex-migrate-project-state',
    createdAt,
    updatedAt: timestamp,
  });
  const project = initializeProject({ repositoryRoot: root, now });
  if (fromVersion === 1) {
    rebuildIndexes(project);
  }
  return Object.freeze({
    fromVersion,
    toVersion: STATE_SCHEMA_VERSION,
    dryRun: false,
    changed: true,
    backupPath,
  });
}

function walkFiles(root: string): $ReadOnlyArray<string> {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current == null) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, String(entry.name));
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }
  return files.sort();
}

function collectHashes(value: JsonValue, hashes: Set<string>): void {
  if (typeof value === 'string') {
    if (/^[a-f0-9]{64}$/.test(value)) {
      hashes.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectHashes(item, hashes);
    }
    return;
  }
  if (value != null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      collectHashes(value[key], hashes);
    }
  }
}

function referencedArtifacts(project: ProjectState): Set<string> {
  const hashes = new Set<string>();
  for (const directory of [
    'candidates',
    'evidence',
    'verdicts',
    'approvals',
    'decisions',
    'applications',
    'tasks',
    'attempts',
    'events',
    'reports',
  ]) {
    for (const file of walkFiles(path.join(project.stateRoot, directory))) {
      if (!file.endsWith('.json')) {
        continue;
      }
      collectHashes(parseJson(fs.readFileSync(file, 'utf8'), file), hashes);
    }
  }
  return hashes;
}

export function cleanupProject({
  project,
  confirm = false,
  now = () => Date.now(),
}: {
  +project: ProjectState,
  +confirm?: boolean,
  +now?: () => number,
}): CleanupResult {
  const referenced = referencedArtifacts(project);
  const artifactRoot = path.join(project.stateRoot, 'artifacts');
  const unreferencedArtifacts = walkFiles(artifactRoot)
    .filter((file) => /^[a-f0-9]{64}$/.test(path.basename(file)))
    .filter((file) => !referenced.has(path.basename(file)));
  const staleBefore = now() - 24 * 60 * 60 * 1000;
  const temporaryFiles = walkFiles(project.stateRoot)
    .filter((file) =>
      /\.[^.]+\.\d+\.[a-f0-9]{24}\.tmp$/.test(path.basename(file)),
    )
    .filter((file) => fs.statSync(file).mtimeMs < staleBefore);
  const candidates = [...unreferencedArtifacts, ...temporaryFiles].sort();
  const removed = [];
  if (confirm) {
    for (const file of candidates) {
      fs.rmSync(file, { force: true });
      removed.push(file);
    }
  }
  return Object.freeze({
    confirmed: confirm,
    unreferencedArtifacts: Object.freeze(unreferencedArtifacts),
    temporaryFiles: Object.freeze(temporaryFiles),
    removed: Object.freeze(removed),
  });
}

export function openForMaintenance(repositoryRoot: string): ProjectState {
  return openProject(repositoryRoot);
}

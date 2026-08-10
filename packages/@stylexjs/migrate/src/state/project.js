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
import { canonicalRoot } from '../kernel/snapshot';
import { hashBytes, hashString } from '../kernel/hash';
import {
  canonicalJson,
  immutableJson,
  parseJson,
  writeFileAtomic,
  writeJsonAtomic,
} from './json';
import type { AtomicWriteIO, JsonValue } from './json';

export const STATE_DIRECTORY: string = '.stylex-migrate';
export const STATE_SCHEMA_VERSION: number = 1;

export const RECORD_COLLECTIONS: $ReadOnlyArray<string> = Object.freeze([
  'candidates',
  'evidence',
  'verdicts',
  'approvals',
  'decisions',
  'applications',
  'indexes',
]);

const DIRECTORIES: $ReadOnlyArray<string> = Object.freeze([
  'events',
  ...RECORD_COLLECTIONS,
  'artifacts',
  'reports',
  'backups',
]);

export type ProjectState = {
  +repositoryRoot: string,
  +stateRoot: string,
  +schemaVersion: number,
};

export type RecordEnvelope = {
  +schemaVersion: number,
  +collection: string,
  +id: string,
  +payload: JsonValue,
  +contentHash: string,
  +writtenAt: string,
};

export type ArtifactReference = {
  +hash: string,
  +size: number,
};

export type ProjectConfig = {
  +sourceGlobs: $ReadOnlyArray<string>,
};

const DEFAULT_CONFIG: ProjectConfig = Object.freeze({
  sourceGlobs: Object.freeze(['**/*.{js,jsx,ts,tsx}']),
});

function safeSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function statePath(repositoryRoot: string): string {
  return path.join(canonicalRoot(repositoryRoot), STATE_DIRECTORY);
}

function assertDirectorySafe(directory: string, create: boolean): void {
  try {
    const stats = fs.lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`State path must be a real directory: ${directory}`);
    }
  } catch (error) {
    const notMissing =
      error == null ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'ENOENT';
    if (notMissing) {
      throw error;
    }
    if (!create) {
      throw error;
    }
    fs.mkdirSync(directory, { recursive: true });
    const created = fs.lstatSync(directory);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error(`State path must be a real directory: ${directory}`);
    }
  }
}

function schemaPath(stateRoot: string): string {
  return path.join(stateRoot, 'schema.json');
}

function schemaDocument(now: string): { [string]: JsonValue } {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    format: 'stylex-migrate-project-state',
    createdAt: now,
    updatedAt: now,
  };
}

function readObject(file: string): { +[string]: JsonValue } {
  const parsed = parseJson(fs.readFileSync(file, 'utf8'), file);
  if (parsed == null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`Expected a JSON object in ${file}`);
  }
  return parsed;
}

export function readSchemaVersion(repositoryRoot: string): number {
  const root = statePath(repositoryRoot);
  assertDirectorySafe(root, false);
  const schema = readObject(schemaPath(root));
  const version = schema.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new Error('Project state has no valid schemaVersion');
  }
  if (
    version === STATE_SCHEMA_VERSION &&
    schema.format !== 'stylex-migrate-project-state'
  ) {
    throw new Error('Project state has an invalid schema format');
  }
  return version;
}

function gitExcludePath(repositoryRoot: string): string {
  const result = String(
    execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    }),
  ).trim();
  if (result === '') {
    throw new Error('Git did not return an info/exclude path');
  }
  return path.isAbsolute(result)
    ? result
    : path.resolve(repositoryRoot, result);
}

function ensureLocallyIgnored(repositoryRoot: string): void {
  const exclude = gitExcludePath(repositoryRoot);
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const current = fs.existsSync(exclude)
    ? fs.readFileSync(exclude, 'utf8')
    : '';
  const lines = current.split(/\r?\n/);
  if (lines.includes(`${STATE_DIRECTORY}/`)) {
    return;
  }
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  writeFileAtomic(exclude, `${current}${separator}${STATE_DIRECTORY}/\n`);
}

export function openProject(repositoryRoot: string): ProjectState {
  const root = canonicalRoot(repositoryRoot);
  const stateRoot = statePath(root);
  assertDirectorySafe(stateRoot, false);
  for (const directory of DIRECTORIES) {
    assertDirectorySafe(path.join(stateRoot, directory), false);
  }
  const version = readSchemaVersion(root);
  if (version !== STATE_SCHEMA_VERSION) {
    throw new Error(
      `Project state schema ${version} is not supported; run stylex-migrate schema migrate`,
    );
  }
  const project = Object.freeze({
    repositoryRoot: root,
    stateRoot,
    schemaVersion: version,
  });
  readConfig(project);
  return project;
}

export function initializeProject({
  repositoryRoot,
  now = () => new Date().toISOString(),
}: {
  +repositoryRoot: string,
  +now?: () => string,
}): ProjectState {
  const root = canonicalRoot(repositoryRoot);
  const stateRoot = statePath(root);
  assertDirectorySafe(stateRoot, true);
  for (const directory of DIRECTORIES) {
    assertDirectorySafe(path.join(stateRoot, directory), true);
  }

  const schema = schemaPath(stateRoot);
  if (!fs.existsSync(schema)) {
    writeJsonAtomic(schema, schemaDocument(now()));
  } else if (readSchemaVersion(root) !== STATE_SCHEMA_VERSION) {
    throw new Error(
      'Existing project state uses another schema; run stylex-migrate schema migrate',
    );
  }

  const config = path.join(stateRoot, 'config.json');
  if (!fs.existsSync(config)) {
    writeConfig(
      { repositoryRoot: root, stateRoot, schemaVersion: STATE_SCHEMA_VERSION },
      DEFAULT_CONFIG,
      { now },
    );
  }
  ensureLocallyIgnored(root);
  return openProject(root);
}

function configIdentity(config: ProjectConfig): string {
  return hashString(
    canonicalJson({
      schemaVersion: STATE_SCHEMA_VERSION,
      kind: 'config',
      config,
    }),
  );
}

export function writeConfig(
  project: ProjectState,
  config: ProjectConfig,
  options?: { +now?: () => string },
): void {
  if (
    config.sourceGlobs.length === 0 ||
    config.sourceGlobs.some((glob) => glob.trim() === '')
  ) {
    throw new Error(
      'Project config requires at least one non-empty source glob',
    );
  }
  writeJsonAtomic(path.join(project.stateRoot, 'config.json'), {
    schemaVersion: STATE_SCHEMA_VERSION,
    kind: 'config',
    config,
    contentHash: configIdentity(config),
    writtenAt: (options?.now ?? (() => new Date().toISOString()))(),
  });
}

export function readConfig(project: ProjectState): ProjectConfig {
  const value = readObject(path.join(project.stateRoot, 'config.json'));
  const config = value.config;
  if (
    value.schemaVersion !== STATE_SCHEMA_VERSION ||
    value.kind !== 'config' ||
    typeof value.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.contentHash) ||
    config == null ||
    Array.isArray(config) ||
    typeof config !== 'object' ||
    !Array.isArray(config.sourceGlobs) ||
    config.sourceGlobs.some(
      (glob) => typeof glob !== 'string' || glob.trim() === '',
    )
  ) {
    throw new Error('Invalid project config');
  }
  const typedConfig: ProjectConfig = config as $FlowFixMe;
  if (value.contentHash !== configIdentity(typedConfig)) {
    throw new Error('Integrity check failed for project config');
  }
  return Object.freeze({
    sourceGlobs: Object.freeze([...typedConfig.sourceGlobs]),
  });
}

function recordIdentity(
  collection: string,
  id: string,
  payload: JsonValue,
): string {
  return hashString(
    canonicalJson({
      schemaVersion: STATE_SCHEMA_VERSION,
      collection,
      id,
      payload,
    }),
  );
}

function recordPath(
  project: ProjectState,
  collection: string,
  id: string,
): string {
  if (!RECORD_COLLECTIONS.includes(collection)) {
    throw new Error(`Unknown record collection: ${collection}`);
  }
  safeSegment(id, 'record id');
  assertDirectorySafe(path.join(project.stateRoot, collection), false);
  return path.join(project.stateRoot, collection, `${id}.json`);
}

export function writeRecord(
  project: ProjectState,
  collection: string,
  id: string,
  payload: JsonValue,
  options?: {
    +io?: AtomicWriteIO,
    +now?: () => string,
  },
): RecordEnvelope {
  const frozenPayload = immutableJson(payload);
  const contentHash = recordIdentity(collection, id, frozenPayload);
  const envelope: RecordEnvelope = Object.freeze({
    schemaVersion: STATE_SCHEMA_VERSION,
    collection,
    id,
    payload: frozenPayload,
    contentHash,
    writtenAt: (options?.now ?? (() => new Date().toISOString()))(),
  });
  writeJsonAtomic(recordPath(project, collection, id), envelope, {
    io: options?.io,
  });
  return envelope;
}

export function readRecord(
  project: ProjectState,
  collection: string,
  id: string,
): RecordEnvelope {
  const file = recordPath(project, collection, id);
  const value = readObject(file);
  if (
    value.schemaVersion !== STATE_SCHEMA_VERSION ||
    value.collection !== collection ||
    value.id !== id ||
    typeof value.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.contentHash) ||
    typeof value.writtenAt !== 'string' ||
    !('payload' in value)
  ) {
    throw new Error(`Invalid ${collection} record ${id}`);
  }
  const expected = recordIdentity(collection, id, value.payload);
  if (value.contentHash !== expected) {
    throw new Error(`Integrity check failed for ${collection} record ${id}`);
  }
  return immutableJson(value) as $FlowFixMe;
}

function artifactPath(
  project: ProjectState,
  hash: string,
  create: boolean,
): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Invalid artifact hash: ${hash}`);
  }
  const root = path.join(project.stateRoot, 'artifacts');
  assertDirectorySafe(root, false);
  const prefix = path.join(root, hash.slice(0, 2));
  assertDirectorySafe(prefix, create);
  return path.join(prefix, hash);
}

export function writeArtifact(
  project: ProjectState,
  contents: Buffer,
): ArtifactReference {
  const hash = hashBytes(contents);
  const file = artifactPath(project, hash, true);
  if (fs.existsSync(file)) {
    readArtifact(project, hash);
  } else {
    writeFileAtomic(file, contents);
  }
  return Object.freeze({ hash, size: contents.length });
}

export function readArtifact(project: ProjectState, hash: string): Buffer {
  const file = artifactPath(project, hash, false);
  const contents = fs.readFileSync(file);
  if (hashBytes(contents) !== hash) {
    throw new Error(`Integrity check failed for artifact ${hash}`);
  }
  return contents;
}

export function projectDirectories(): $ReadOnlyArray<string> {
  return DIRECTORIES;
}

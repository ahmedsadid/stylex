/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { createSnapshot, detectStaleFiles } from '../kernel/snapshot';
import { loadCurrentInventory } from '../planning/reports';
import { readRecord, writeRecord } from '../state/project';
import {
  TEST_ASSUMPTION_PROTOCOL_VERSION,
  createTestAssumption,
  validateTestAssumption,
} from './model';
import type { ProjectState } from '../state/project';
import type { TestAssumption } from './model';

function missing(error: mixed): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

export function loadTestAssumption(
  project: ProjectState,
  id: string,
): TestAssumption | null {
  try {
    const payload: $FlowFixMe = readRecord(project, 'decisions', id).payload;
    if (payload?.kind !== 'test-assumption') {
      throw new Error(`Invalid persisted test assumption ${id}`);
    }
    const assumption = validateTestAssumption(payload.assumption);
    if (assumption.id !== id) {
      throw new Error(`Test assumption record ${id} contains another artifact`);
    }
    return assumption;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export function assertCurrentTestAssumption(
  project: ProjectState,
  assumption: TestAssumption,
): void {
  const validated = validateTestAssumption(assumption);
  const inventory = loadCurrentInventory(project);
  if (inventory == null || inventory.id !== validated.inventoryId) {
    throw new Error(`Test assumption ${validated.id} names a stale inventory`);
  }
  const snapshot = createSnapshot({
    repositoryRoot: project.repositoryRoot,
    files: validated.declaredInputs.map((item) => item.path),
  });
  if (snapshot.gitCommit !== validated.baseCommit) {
    throw new Error(
      `Test assumption ${validated.id} names a stale base commit`,
    );
  }
  const stale = detectStaleFiles(snapshot);
  if (stale.length > 0) {
    throw new Error(
      `Test assumption ${validated.id} has dirty inputs: ${stale.join(', ')}`,
    );
  }
  for (const input of validated.declaredInputs) {
    if (
      snapshot.fileHashes[input.path] !== input.contentHash ||
      snapshot.fileModes[input.path] !== input.mode
    ) {
      throw new Error(
        `Test assumption ${validated.id} input changed: ${input.path}`,
      );
    }
  }
}

export function persistTestAssumption({
  project,
  input,
  authorKind,
  authoredBy,
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +input: mixed,
  +authorKind: 'agent' | 'human',
  +authoredBy: string,
  +now?: () => string,
}): TestAssumption {
  const inventory = loadCurrentInventory(project);
  if (inventory == null) {
    throw new Error('Run stylex-migrate scan before recording an assumption');
  }
  if (input == null || Array.isArray(input) || typeof input !== 'object') {
    throw new Error('Invalid test-assumption input');
  }
  const source: $FlowFixMe = input;
  if (!Array.isArray(source.facts) || source.facts.length === 0) {
    throw new Error('Test assumption requires facts');
  }
  const inputFiles = [
    ...new Set(
      source.facts.flatMap((fact) =>
        Array.isArray(fact?.inputFiles) ? fact.inputFiles : [],
      ),
    ),
  ];
  if (
    inputFiles.length === 0 ||
    inputFiles.some(
      (file) =>
        typeof file !== 'string' ||
        file === '' ||
        file.includes('\0') ||
        file.includes('\\') ||
        file.startsWith('/') ||
        file.split('/').some((segment) => segment === '' || segment === '..'),
    )
  ) {
    throw new Error('Test-assumption facts require repository input files');
  }
  const snapshot = createSnapshot({
    repositoryRoot: project.repositoryRoot,
    files: inputFiles,
  });
  const stale = detectStaleFiles(snapshot);
  if (stale.length > 0) {
    throw new Error(
      `Test-assumption inputs differ from HEAD: ${stale.join(', ')}`,
    );
  }
  const assumption = createTestAssumption({
    definition: {
      protocolVersion: TEST_ASSUMPTION_PROTOCOL_VERSION,
      inventoryId: inventory.id,
      baseCommit: snapshot.gitCommit,
      purpose: source.purpose,
      facts: source.facts,
      declaredInputs: inputFiles.map((file) => ({
        path: file,
        contentHash: snapshot.fileHashes[file],
        mode: snapshot.fileModes[file],
      })),
      scope: source.scope,
      rationale: source.rationale,
      alternatives: source.alternatives,
      limitations: source.limitations,
      authorKind,
      authoredBy,
    },
    now,
  });
  const existing = loadTestAssumption(project, assumption.id);
  if (existing == null) {
    writeRecord(
      project,
      'decisions',
      assumption.id,
      { kind: 'test-assumption', assumption } as $FlowFixMe,
      { now },
    );
  } else if (existing.artifactHash !== assumption.artifactHash) {
    throw new Error(`Test assumption identity collision for ${assumption.id}`);
  }
  return existing ?? assumption;
}

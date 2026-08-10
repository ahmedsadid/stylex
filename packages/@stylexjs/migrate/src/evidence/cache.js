/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { hashString } from '../kernel/hash';
import { canonicalJson } from '../state/json';
import {
  readArtifact,
  readRecord,
  writeArtifact,
  writeRecord,
} from '../state/project';
import { previewEvidenceOutput, repositoryEvidenceIdentity } from './command';
import type {
  CommandCacheProbe,
  CommandExecution,
  RepositoryEvidenceResult,
} from './command';
import type { EvidenceProviderConfig } from './config';
import type { RepositoryEvidenceSubject } from './subject';
import type { JsonValue } from '../state/json';
import type { ProjectState } from '../state/project';

export type EvidenceCacheInputs = {
  +subject: RepositoryEvidenceSubject,
  +provider: EvidenceProviderConfig,
  +probe: CommandCacheProbe,
};

function isMissing(error: mixed): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function object(value: mixed): boolean {
  return value != null && !Array.isArray(value) && typeof value === 'object';
}

export function evidenceCacheKey(inputs: EvidenceCacheInputs): string {
  return hashString(
    canonicalJson({
      subject: inputs.subject,
      provider: inputs.provider,
      probe: inputs.probe,
    } as $FlowFixMe),
  );
}

function recordId(key: string): string {
  return `repository-${key}`;
}

function parseCachedEvidence(value: mixed): RepositoryEvidenceResult {
  const evidence: $FlowFixMe = value;
  if (
    !object(evidence) ||
    typeof evidence.id !== 'string' ||
    typeof evidence.provider !== 'string' ||
    typeof evidence.providerVersion !== 'string' ||
    typeof evidence.check !== 'string' ||
    typeof evidence.checkVersion !== 'string' ||
    evidence.result !== 'pass' ||
    !object(evidence.subject) ||
    typeof evidence.subject.id !== 'string' ||
    !object(evidence.command) ||
    !object(evidence.platform) ||
    typeof evidence.startedAt !== 'string' ||
    typeof evidence.durationMs !== 'number' ||
    typeof evidence.outputHash !== 'string' ||
    typeof evidence.outputSize !== 'number' ||
    typeof evidence.outputPreview !== 'string' ||
    !Array.isArray(evidence.limitations)
  ) {
    throw new Error('Invalid cached repository evidence');
  }
  if (repositoryEvidenceIdentity(evidence) !== evidence.id) {
    throw new Error('Integrity check failed for cached evidence identity');
  }
  return evidence;
}

export function loadCachedExecution(
  project: ProjectState,
  inputs: EvidenceCacheInputs,
  outputPreviewBytes: number,
): CommandExecution | null {
  const key = evidenceCacheKey(inputs);
  let payload: JsonValue;
  try {
    payload = readRecord(project, 'evidence', recordId(key)).payload;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  const cache: $FlowFixMe = payload;
  if (
    !object(cache) ||
    cache.kind !== 'repository-evidence-cache' ||
    cache.key !== key ||
    !object(cache.artifact) ||
    typeof cache.artifact.hash !== 'string' ||
    typeof cache.artifact.size !== 'number'
  ) {
    throw new Error(`Invalid repository evidence cache record ${key}`);
  }
  const evidence = parseCachedEvidence(cache.evidence);
  if (
    evidence.subject.id !== inputs.subject.id ||
    evidence.provider !== inputs.provider.id ||
    evidence.providerVersion !== inputs.probe.providerVersion
  ) {
    throw new Error(`Repository evidence cache subject mismatch ${key}`);
  }
  const fullOutput = readArtifact(project, cache.artifact.hash);
  if (
    fullOutput.length !== cache.artifact.size ||
    evidence.outputHash !== cache.artifact.hash ||
    evidence.outputSize !== fullOutput.length
  ) {
    throw new Error(`Repository evidence cache artifact mismatch ${key}`);
  }
  return Object.freeze({
    evidence: Object.freeze({
      ...evidence,
      outputPreview: previewEvidenceOutput(fullOutput, outputPreviewBytes),
    }),
    fullOutput,
  });
}

export function saveCachedExecution(
  project: ProjectState,
  inputs: EvidenceCacheInputs,
  execution: CommandExecution,
  options?: { +now?: () => string, +outputPreviewBytes?: number },
): CommandExecution {
  if (execution.evidence.result !== 'pass') {
    throw new Error('Only passing repository evidence may be cached');
  }
  const existing = loadCachedExecution(
    project,
    inputs,
    options?.outputPreviewBytes ?? 8192,
  );
  if (existing != null) {
    return existing;
  }
  const key = evidenceCacheKey(inputs);
  const artifact = writeArtifact(project, execution.fullOutput);
  if (
    artifact.hash !== execution.evidence.outputHash ||
    artifact.size !== execution.evidence.outputSize
  ) {
    throw new Error('Repository evidence output does not match its artifact');
  }
  writeRecord(
    project,
    'evidence',
    recordId(key),
    {
      kind: 'repository-evidence-cache',
      key,
      evidence: execution.evidence,
      artifact,
    } as $FlowFixMe,
    { now: options?.now },
  );
  return execution;
}

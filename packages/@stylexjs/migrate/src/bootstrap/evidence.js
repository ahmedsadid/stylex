/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { inspectContextTask } from '../context/lifecycle';
import { normalizeEvidenceConfig } from '../evidence/config';
import {
  bootstrapRspackProviderId,
  RSPACK_SENTINEL_CHECK_VERSION,
  RSPACK_SENTINEL_LIMITATION,
} from './provider';
import type { VerificationCandidate } from '../evidence/candidates';
import type { EvidenceConfig, EvidenceSubjectKind } from '../evidence/config';
import type { ProjectState } from '../state/project';

export function withBootstrapEvidenceProviders({
  project,
  candidates,
  subject,
  config,
}: {
  +project: ProjectState,
  +candidates: $ReadOnlyArray<VerificationCandidate>,
  +subject: EvidenceSubjectKind,
  +config: EvidenceConfig,
}): EvidenceConfig {
  const generated = [];
  for (const candidate of candidates) {
    const taskId = candidate.candidate.proposer.taskId;
    if (taskId == null) continue;
    const inspection = inspectContextTask(project, taskId);
    const origin = inspection.task.origin;
    if (origin.kind !== 'bootstrap' || origin.integration !== 'rspack') {
      continue;
    }
    if (
      !candidate.staticEvidence.some(
        (result) =>
          result.check === 'stylex-bootstrap-wiring' &&
          result.result === 'pass',
      )
    ) {
      throw new Error(
        `Bootstrap candidate ${candidate.candidate.id} has no passing frozen wiring check`,
      );
    }
    generated.push({
      id: bootstrapRspackProviderId(origin.inspectionId),
      kind: 'bootstrap-rspack',
      check: 'build',
      checkVersion: RSPACK_SENTINEL_CHECK_VERSION,
      subject,
      cost: 'expensive',
      packageManager: origin.packageManager,
      packageRoot: origin.packageRoot,
      cwd: '.',
      allowedEnv: ['CI', 'PATH'],
      fileGlobs: inspection.task.scope.bootstrapPaths ?? [],
      limitations: [RSPACK_SENTINEL_LIMITATION],
      timeoutMs: 15 * 60 * 1000,
    });
  }
  if (generated.length === 0) return config;
  const existing = new Set(config.providers.map((provider) => provider.id));
  const collision = generated.find((provider) => existing.has(provider.id));
  if (collision != null) {
    throw new Error(
      `Repository evidence config uses reserved bootstrap provider id ${collision.id}`,
    );
  }
  return normalizeEvidenceConfig({
    ...config,
    providers: [...config.providers, ...generated],
  });
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import path from 'path';
import { inspectContextTask } from '../context/lifecycle';
import { normalizeEvidenceConfig } from '../evidence/config';
import { GENERATED_RUNTIME_COLLECTOR_VERSION } from './collector';
import type { VerificationCandidate } from '../evidence/candidates';
import type { EvidenceConfig, EvidenceSubjectKind } from '../evidence/config';
import type { ProjectState } from '../state/project';

function fromPackageRoot(packageRoot: string, file: string): string {
  const relative = path.posix.relative(
    packageRoot === '.' ? '' : packageRoot,
    file,
  );
  return relative === '' ? '.' : relative;
}

export function withGeneratedRuntimeProbeProviders({
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
  for (const record of candidates) {
    const taskId = record.candidate.proposer.taskId;
    if (taskId == null) continue;
    const inspection = inspectContextTask(project, taskId);
    const origin = inspection.task.origin;
    if (origin.kind !== 'evidence-surface') continue;
    for (const required of inspection.task.requiredOutputs) {
      const change = record.candidate.changes.find(
        (item) => item.path === required.path,
      );
      if (change == null || change.contentHash !== required.targetHash) {
        throw new Error(
          `Evidence-surface candidate ${record.candidate.id} does not contain locked ${required.role}`,
        );
      }
    }
    const retained = origin.baselineKind === 'retained-repository';
    const common = {
      id: `stylex-generated-runtime-${taskId}`,
      kind: retained ? 'runtime-command' : 'generated-runtime-probe',
      check: 'runtime-render',
      checkVersion: origin.protocolVersion,
      subject,
      cost: 'expensive',
      runtimeInterface: origin.runtimeInterface,
      argv: [
        process.execPath,
        fromPackageRoot(origin.packageRoot, origin.collectorPath),
        fromPackageRoot(origin.packageRoot, origin.configPath),
      ],
      versionArgv: [
        process.execPath,
        '-e',
        `process.stdout.write(${JSON.stringify(GENERATED_RUNTIME_COLLECTOR_VERSION)})`,
      ],
      cwd: origin.packageRoot,
      allowedEnv: ['CI', 'HOME', 'PATH'],
      fileGlobs: [
        ...new Set([
          origin.collectorPath,
          origin.configPath,
          ...(origin.supportPaths ?? []),
          ...origin.cases.flatMap((item) => item.changePaths),
        ]),
      ],
      limitations: [
        retained
          ? 'The harness is generated under a bound test assumption; its baseline is retained repository behavior, not owner-approved production-route coverage.'
          : 'Generated expectations are bound test assumptions, not retained repository behavior or owner approval.',
        ...origin.limitations,
      ],
      timeoutMs: 15 * 60 * 1000,
      cases: origin.cases,
    };
    generated.push(
      retained
        ? common
        : {
            ...common,
            assumptionArtifactHash: origin.assumptionArtifactHash,
            expectedObservations: origin.expectedObservations,
            syntheticCssExpectations: origin.syntheticCssExpectations ?? null,
          },
    );
  }
  if (generated.length === 0) return config;
  if (generated.length > 1) {
    throw new Error(
      'A candidate set may contain only one generated runtime evidence surface',
    );
  }
  const collision = config.providers.find(
    (provider) => provider.id === generated[0].id,
  );
  if (collision != null) {
    throw new Error(
      `Repository evidence config uses reserved runtime provider id ${collision.id}`,
    );
  }
  return normalizeEvidenceConfig({
    ...config,
    providers: [...config.providers, ...generated],
  });
}

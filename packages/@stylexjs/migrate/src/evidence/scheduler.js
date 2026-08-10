/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { hashString, shortHash } from '../kernel/hash';
import { canonicalJson } from '../state/json';
import { readRecord, writeArtifact, writeRecord } from '../state/project';
import { loadCachedExecution, saveCachedExecution } from './cache';
import { createEvidenceProviderRegistry } from './registry';
import type { CommandCacheProbe, RepositoryEvidenceResult } from './command';
import type {
  EvidenceConfig,
  EvidenceCost,
  EvidenceProviderConfig,
} from './config';
import type { RepositoryEvidenceSubject } from './subject';
import type { ArtifactReference, ProjectState } from '../state/project';
import type { EvidenceProviderRegistry } from './registry';

export type EvidenceScheduleItem = {
  +providerId: string,
  +cost: EvidenceCost,
  +estimatedDurationMs: number,
};

export type EvidenceSchedule = {
  +id: string,
  +subjectId: string,
  +configHash: string,
  +concurrency: number,
  +items: $ReadOnlyArray<EvidenceScheduleItem>,
  +ignoredProviderIds: $ReadOnlyArray<string>,
  +estimatedCommandRuns: number,
  +estimatedDurationMs: number,
};

export type EvidenceRunEntry = {
  +providerId: string,
  +cost: EvidenceCost,
  +cacheHit: boolean,
  +estimatedDurationMs: number,
  +elapsedMs: number,
  +evidence: RepositoryEvidenceResult,
  +outputArtifact: ArtifactReference,
};

export type EvidenceScheduleResult = {
  +schedule: EvidenceSchedule,
  +entries: $ReadOnlyArray<EvidenceRunEntry>,
  +skippedProviderIds: $ReadOnlyArray<string>,
  +actualDurationMs: number,
};

type ProviderHistory = {
  +kind: 'repository-evidence-history',
  +providerId: string,
  +sampleCount: number,
  +totalDurationMs: number,
  +averageDurationMs: number,
  +lastDurationMs: number,
  +updatedAt: string,
};

const COST_ORDER: $ReadOnlyArray<EvidenceCost> = [
  'cheap',
  'standard',
  'expensive',
];
const DEFAULT_ESTIMATE: { +[EvidenceCost]: number } = {
  cheap: 10000,
  standard: 60000,
  expensive: 300000,
};

function isMissing(error: mixed): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function providerHistoryId(provider: EvidenceProviderConfig): string {
  return `history-${hashString(canonicalJson(provider as $FlowFixMe))}`;
}

function readHistory(
  project: ProjectState,
  provider: EvidenceProviderConfig,
): ProviderHistory | null {
  let payload;
  try {
    payload = readRecord(
      project,
      'evidence',
      providerHistoryId(provider),
    ).payload;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  const history: {
    kind?: mixed,
    providerId?: mixed,
    sampleCount?: mixed,
    totalDurationMs?: mixed,
    averageDurationMs?: mixed,
    lastDurationMs?: mixed,
    updatedAt?: mixed,
  } = payload as $FlowFixMe;
  if (
    history == null ||
    Array.isArray(history) ||
    typeof history !== 'object' ||
    typeof history.kind !== 'string' ||
    history.kind !== 'repository-evidence-history' ||
    typeof history.providerId !== 'string' ||
    history.providerId !== provider.id ||
    typeof history.sampleCount !== 'number' ||
    !Number.isInteger(history.sampleCount) ||
    history.sampleCount < 1 ||
    typeof history.totalDurationMs !== 'number' ||
    typeof history.averageDurationMs !== 'number' ||
    typeof history.lastDurationMs !== 'number' ||
    typeof history.updatedAt !== 'string'
  ) {
    throw new Error(`Invalid evidence history for ${provider.id}`);
  }
  return history as $FlowFixMe;
}

function updateHistory(
  project: ProjectState,
  provider: EvidenceProviderConfig,
  durationMs: number,
  now: () => string,
): void {
  const current = readHistory(project, provider);
  const sampleCount = (current?.sampleCount ?? 0) + 1;
  const totalDurationMs = (current?.totalDurationMs ?? 0) + durationMs;
  writeRecord(
    project,
    'evidence',
    providerHistoryId(provider),
    {
      kind: 'repository-evidence-history',
      providerId: provider.id,
      sampleCount,
      totalDurationMs,
      averageDurationMs: Math.round(totalDurationMs / sampleCount),
      lastDurationMs: durationMs,
      updatedAt: now(),
    },
    { now },
  );
}

function estimateFor(
  project: ProjectState,
  provider: EvidenceProviderConfig,
): number {
  return (
    readHistory(project, provider)?.averageDurationMs ??
    DEFAULT_ESTIMATE[provider.cost]
  );
}

function estimatedWallTime(
  items: $ReadOnlyArray<EvidenceScheduleItem>,
  concurrency: number,
): number {
  let total = 0;
  for (const cost of COST_ORDER) {
    const lanes = Array(Math.min(concurrency, items.length)).fill(0);
    for (const item of items
      .filter((candidate) => candidate.cost === cost)
      .sort((a, b) => b.estimatedDurationMs - a.estimatedDurationMs)) {
      let lane = 0;
      for (let index = 1; index < lanes.length; index++) {
        if (lanes[index] < lanes[lane]) {
          lane = index;
        }
      }
      lanes[lane] += item.estimatedDurationMs;
    }
    total += lanes.length === 0 ? 0 : Math.max(...lanes);
  }
  return total;
}

export function createEvidenceSchedule({
  project,
  subject,
  config,
}: {
  +project: ProjectState,
  +subject: RepositoryEvidenceSubject,
  +config: EvidenceConfig,
}): EvidenceSchedule {
  const selected = config.providers.filter(
    (provider) => provider.subject === subject.kind,
  );
  const items = Object.freeze(
    selected.map((provider) =>
      Object.freeze({
        providerId: provider.id,
        cost: provider.cost,
        estimatedDurationMs: estimateFor(project, provider),
      }),
    ),
  );
  const ignoredProviderIds = Object.freeze(
    config.providers
      .filter((provider) => provider.subject !== subject.kind)
      .map((provider) => provider.id)
      .sort(),
  );
  const stable = {
    subjectId: subject.id,
    configHash: hashString(canonicalJson(config as $FlowFixMe)),
    concurrency: config.concurrency,
    items,
    ignoredProviderIds,
    estimatedCommandRuns: items.length,
    estimatedDurationMs: estimatedWallTime(items, config.concurrency),
  };
  return Object.freeze({
    id: shortHash(hashString(canonicalJson(stable as $FlowFixMe))),
    ...stable,
  });
}

async function parallelMap<T, R>(
  values: $ReadOnlyArray<T>,
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<$ReadOnlyArray<R>> {
  const output: Array<R> = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next++;
      output[index] = await operation(values[index]);
    }
  }
  await Promise.all(
    Array(Math.min(concurrency, values.length))
      .fill(null)
      .map(() => worker()),
  );
  return Object.freeze(output);
}

export async function runEvidenceSchedule({
  project,
  workspaceRoot,
  subject,
  config,
  registry = createEvidenceProviderRegistry(),
  environment,
  now = () => new Date().toISOString(),
  monotonicNow = () => Date.now(),
}: {
  +project: ProjectState,
  +workspaceRoot: string,
  +subject: RepositoryEvidenceSubject,
  +config: EvidenceConfig,
  +registry?: EvidenceProviderRegistry,
  +environment?: { +[string]: string | void },
  +now?: () => string,
  +monotonicNow?: () => number,
}): Promise<EvidenceScheduleResult> {
  const schedule = createEvidenceSchedule({ project, subject, config });
  const selected = new Map(
    config.providers
      .filter((provider) => provider.subject === subject.kind)
      .map((provider) => [provider.id, provider]),
  );
  const started = monotonicNow();
  const entries: Array<EvidenceRunEntry> = [];
  const skipped: Array<string> = [];
  let stop = false;

  for (const cost of COST_ORDER) {
    const tierItems = schedule.items.filter((item) => item.cost === cost);
    if (stop) {
      skipped.push(...tierItems.map((item) => item.providerId));
      continue;
    }
    const tierEntries = await parallelMap(
      tierItems,
      config.concurrency,
      async (item) => {
        const provider = selected.get(item.providerId);
        if (provider == null) {
          throw new Error(`Schedule lost provider ${item.providerId}`);
        }
        let cacheHit = false;
        let cacheProbe: CommandCacheProbe | null = null;
        const executionStarted = monotonicNow();
        const execution = await registry.get(provider.kind)(provider, {
          workspaceRoot,
          subject,
          environment,
          now,
          monotonicNow,
          outputPreviewBytes: config.outputPreviewBytes,
          lookupCached: async (probe) => {
            cacheProbe = probe;
            const cached = loadCachedExecution(
              project,
              { subject, provider, probe },
              config.outputPreviewBytes,
            );
            cacheHit = cached != null;
            return cached;
          },
        });
        const outputArtifact = writeArtifact(project, execution.fullOutput);
        if (
          outputArtifact.hash !== execution.evidence.outputHash ||
          outputArtifact.size !== execution.evidence.outputSize
        ) {
          throw new Error(`Output artifact mismatch for ${provider.id}`);
        }
        if (
          !cacheHit &&
          cacheProbe != null &&
          execution.evidence.result === 'pass'
        ) {
          saveCachedExecution(
            project,
            { subject, provider, probe: cacheProbe },
            execution,
            { now, outputPreviewBytes: config.outputPreviewBytes },
          );
        }
        if (!cacheHit) {
          updateHistory(project, provider, execution.evidence.durationMs, now);
        }
        return Object.freeze({
          providerId: provider.id,
          cost: provider.cost,
          cacheHit,
          estimatedDurationMs: item.estimatedDurationMs,
          elapsedMs: Math.max(0, monotonicNow() - executionStarted),
          evidence: execution.evidence,
          outputArtifact,
        });
      },
    );
    entries.push(...tierEntries);
    stop = tierEntries.some((entry) => entry.evidence.result === 'fail');
  }

  return Object.freeze({
    schedule,
    entries: Object.freeze(entries),
    skippedProviderIds: Object.freeze(skipped.sort()),
    actualDurationMs: Math.max(0, monotonicNow() - started),
  });
}

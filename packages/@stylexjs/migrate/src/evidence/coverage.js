/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { matchesGlob } from '../candidate/scope';
import type { EvidenceProviderConfig } from './config';
import type { RepositoryEvidenceResult } from './command';
import type { RepositoryEvidenceSubject } from './subject';

type CoverageEvidenceEntry = {
  +providerId: string,
  +evidence: RepositoryEvidenceResult,
  ...
};

export type CoverageStatus = 'covered' | 'partially-covered' | 'uncovered';

export type CoverageEntry = {
  +changePath: string,
  +siteIds: $ReadOnlyArray<string>,
  +checks: $ReadOnlyArray<string>,
  +claimsSupported: $ReadOnlyArray<'checks-passed'>,
  +status: CoverageStatus,
  +detail: string,
};

export type CoverageSummary = {
  +status: CoverageStatus,
  +entries: $ReadOnlyArray<CoverageEntry>,
  +counts: {
    +covered: number,
    +'partially-covered': number,
    +uncovered: number,
  },
};

function expandBraces(pattern: string): $ReadOnlyArray<string> {
  const match = /^(.*)\{([^{}]+)\}(.*)$/.exec(pattern);
  if (match == null) {
    return [pattern];
  }
  return match[2]
    .split(',')
    .flatMap((part) => expandBraces(`${match[1]}${part}${match[3]}`));
}

function relevant(provider: EvidenceProviderConfig, file: string): boolean {
  return provider.fileGlobs
    .flatMap(expandBraces)
    .some((pattern) => matchesGlob(pattern, file));
}

export function aggregateRepositoryCoverage({
  subject,
  providers,
  entries,
}: {
  +subject: RepositoryEvidenceSubject,
  +providers: $ReadOnlyArray<EvidenceProviderConfig>,
  +entries: $ReadOnlyArray<CoverageEvidenceEntry>,
}): CoverageSummary {
  const results = new Map(entries.map((entry) => [entry.providerId, entry]));
  const coverage = subject.changes.map((change) => {
    const applicable = providers.filter(
      (provider) =>
        provider.kind === 'command' &&
        provider.subject === subject.kind &&
        relevant(provider, change.path),
    );
    const observed = applicable
      .map((provider) => ({
        provider,
        entry: results.get(provider.id),
      }))
      .filter((item) => item.entry != null);
    const passed = observed.filter(
      (item) => item.entry?.evidence.result === 'pass',
    );
    let status: CoverageStatus;
    if (applicable.length > 0 && passed.length === applicable.length) {
      status = 'covered';
    } else if (passed.length > 0) {
      status = 'partially-covered';
    } else {
      status = 'uncovered';
    }
    const missing = applicable
      .filter((provider) => results.get(provider.id) == null)
      .map((provider) => provider.id);
    const nonPassing = observed
      .filter((item) => item.entry?.evidence.result !== 'pass')
      .map(
        (item) => `${item.provider.id}=${String(item.entry?.evidence.result)}`,
      );
    const detail =
      applicable.length === 0
        ? 'no configured repository check applies to this path'
        : status === 'covered'
          ? 'all configured repository checks for this path passed'
          : `repository coverage gaps: ${[...missing, ...nonPassing].join(', ')}`;
    return Object.freeze({
      changePath: change.path,
      siteIds: change.siteIds,
      checks: Object.freeze(observed.map((item) => item.provider.check).sort()),
      claimsSupported: Object.freeze(
        status === 'covered' ? ['checks-passed'] : [],
      ),
      status,
      detail,
    });
  });
  const counts = {
    covered: coverage.filter((entry) => entry.status === 'covered').length,
    'partially-covered': coverage.filter(
      (entry) => entry.status === 'partially-covered',
    ).length,
    uncovered: coverage.filter((entry) => entry.status === 'uncovered').length,
  };
  const status: CoverageStatus =
    counts.uncovered > 0
      ? 'uncovered'
      : counts['partially-covered'] > 0
        ? 'partially-covered'
        : 'covered';
  return Object.freeze({
    status,
    entries: Object.freeze(coverage),
    counts: Object.freeze(counts),
  });
}

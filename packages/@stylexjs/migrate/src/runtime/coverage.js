/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import type { BundleRepositoryEntry } from '../evidence/bundle';
import type {
  EvidenceProviderConfig,
  RuntimeInterface,
} from '../evidence/config';
import type { RepositoryEvidenceSubject } from '../evidence/subject';
import type {
  RuntimeDifference,
  RuntimeEnvironment,
  RuntimeViewport,
} from './model';

export type RuntimeCaseCoverageStatus =
  | 'matched'
  | 'different'
  | 'missing'
  | 'unavailable';

export type RuntimeCaseCoverageEntry = {
  +providerId: string,
  +runtimeInterface: RuntimeInterface,
  +caseId: string,
  +changePaths: $ReadOnlyArray<string>,
  +siteIds: $ReadOnlyArray<string>,
  +theme: string,
  +interaction: string,
  +viewport: RuntimeViewport,
  +status: RuntimeCaseCoverageStatus,
  +differences: $ReadOnlyArray<RuntimeDifference>,
  +detail: string,
};

export type RuntimeCoverageStatus =
  | 'matched'
  | 'different'
  | 'incomplete'
  | 'unavailable'
  | 'not-configured';

export type RuntimeCoverageSummary = {
  +status: RuntimeCoverageStatus,
  +entries: $ReadOnlyArray<RuntimeCaseCoverageEntry>,
  +environments: $ReadOnlyArray<{
    +providerId: string,
    +environment: RuntimeEnvironment,
  }>,
  +coveredPaths: $ReadOnlyArray<string>,
  +coveredSiteIds: $ReadOnlyArray<string>,
  +uncoveredPaths: $ReadOnlyArray<string>,
  +uncoveredSiteIds: $ReadOnlyArray<string>,
  +counts: {
    +matched: number,
    +different: number,
    +missing: number,
    +unavailable: number,
  },
};

export function aggregateRuntimeCoverage({
  subject,
  providers,
  entries,
}: {
  +subject: RepositoryEvidenceSubject,
  +providers: $ReadOnlyArray<EvidenceProviderConfig>,
  +entries: $ReadOnlyArray<BundleRepositoryEntry>,
}): RuntimeCoverageSummary {
  const runtimeProviders = providers.filter(
    (provider) =>
      (provider.kind === 'runtime-command' ||
        provider.kind === 'generated-runtime-probe') &&
      provider.subject === subject.kind,
  );
  const evidenceByProvider = new Map(
    entries.map((entry) => [entry.providerId, entry.evidence]),
  );
  const environments = [];
  const caseEntries: Array<RuntimeCaseCoverageEntry> = [];
  for (const provider of runtimeProviders) {
    if (
      provider.kind !== 'runtime-command' &&
      provider.kind !== 'generated-runtime-probe'
    ) {
      continue;
    }
    const evidence = evidenceByProvider.get(provider.id);
    const comparison = evidence?.runtime?.comparison;
    if (comparison?.environment != null) {
      environments.push(
        Object.freeze({
          providerId: provider.id,
          environment: comparison.environment,
        }),
      );
    }
    const comparisonById = new Map(
      (comparison?.cases ?? []).map((runtimeCase) => [
        runtimeCase.id,
        runtimeCase,
      ]),
    );
    for (const definition of provider.cases) {
      const compared = comparisonById.get(definition.id);
      const status: RuntimeCaseCoverageStatus =
        compared == null ? 'unavailable' : compared.result;
      const detail =
        status === 'matched'
          ? 'baseline and candidate observations matched'
          : status === 'different'
            ? 'baseline and candidate observations differed'
            : status === 'missing'
              ? 'the baseline or candidate did not report this case'
              : (evidence?.detail ?? 'runtime evidence was not available');
      caseEntries.push(
        Object.freeze({
          providerId: provider.id,
          runtimeInterface: provider.runtimeInterface,
          caseId: definition.id,
          changePaths: definition.changePaths,
          siteIds: definition.siteIds,
          theme: definition.theme,
          interaction: definition.interaction,
          viewport: definition.viewport,
          status,
          differences: compared?.differences ?? Object.freeze([]),
          detail,
        }),
      );
    }
  }
  const counts = Object.freeze({
    matched: caseEntries.filter((entry) => entry.status === 'matched').length,
    different: caseEntries.filter((entry) => entry.status === 'different')
      .length,
    missing: caseEntries.filter((entry) => entry.status === 'missing').length,
    unavailable: caseEntries.filter((entry) => entry.status === 'unavailable')
      .length,
  });
  let status: RuntimeCoverageStatus;
  if (runtimeProviders.length === 0) {
    status = 'not-configured';
  } else if (counts.different > 0) {
    status = 'different';
  } else if (counts.missing > 0) {
    status = 'incomplete';
  } else if (counts.unavailable > 0 || counts.matched === 0) {
    status = 'unavailable';
  } else {
    status = 'matched';
  }
  const matched = caseEntries.filter((entry) => entry.status === 'matched');
  const coveredPaths = [
    ...new Set(matched.flatMap((entry) => entry.changePaths)),
  ].sort();
  const coveredSiteIds = [
    ...new Set(matched.flatMap((entry) => entry.siteIds)),
  ].sort();
  const allPaths = subject.changes.map((change) => change.path);
  const allSiteIds = subject.changes.flatMap((change) => change.siteIds);
  return Object.freeze({
    status,
    entries: Object.freeze(caseEntries),
    environments: Object.freeze(environments),
    coveredPaths: Object.freeze(coveredPaths),
    coveredSiteIds: Object.freeze(coveredSiteIds),
    uncoveredPaths: Object.freeze(
      allPaths.filter((changePath) => !coveredPaths.includes(changePath)),
    ),
    uncoveredSiteIds: Object.freeze(
      allSiteIds.filter((siteId) => !coveredSiteIds.includes(siteId)),
    ),
    counts,
  });
}

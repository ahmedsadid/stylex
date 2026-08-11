/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import type { Fact, Inventory } from '../inventory/model';

export type ThemeConsumerCandidate = {
  +file: string,
  +definitionNames: $ReadOnlyArray<string>,
  +definitionCount: number,
  +themePaths: $ReadOnlyArray<string>,
  +localProviderReady: boolean,
  +bridgeReady: boolean,
  +reasons: $ReadOnlyArray<string>,
};

export type ThemeConsumerCandidateReport = {
  +inventoryId: string,
  +counts: {
    +files: number,
    +definitions: number,
    +localProviderReadyFiles: number,
    +bridgeReadyFiles: number,
    +bridgeReadyDefinitions: number,
  },
  +candidates: $ReadOnlyArray<ThemeConsumerCandidate>,
  +limitations: $ReadOnlyArray<string>,
};

function fileOf(fact: Fact): string | null {
  return fact.provenance.find((item) => item.file != null)?.file ?? null;
}

export function themeConsumerCandidates(
  inventory: Inventory,
): ThemeConsumerCandidateReport {
  const grouped = new Map<
    string,
    { +grammars: Array<Fact>, +reads: Array<Fact> },
  >();
  for (const fact of inventory.facts) {
    if (
      fact.kind !== 'emotion-styled-theme-template-grammar' &&
      fact.kind !== 'theme-read'
    ) {
      continue;
    }
    const file = fileOf(fact);
    if (file == null) continue;
    const existing = grouped.get(file) ?? { grammars: [], reads: [] };
    if (fact.kind === 'theme-read') existing.reads.push(fact);
    else existing.grammars.push(fact);
    grouped.set(file, existing);
  }
  const candidates = [];
  for (const [file, group] of grouped) {
    if (group.grammars.length === 0) continue;
    const supported = group.grammars.filter((fact) => {
      const value: $FlowFixMe = fact.value;
      return value.supported === true;
    });
    const themePaths = new Set<string>();
    for (const fact of supported) {
      const value: $FlowFixMe = fact.value;
      for (const declaration of value.declarations ?? []) {
        if (typeof declaration.sourcePath === 'string') {
          themePaths.add(declaration.sourcePath);
        }
      }
    }
    const reasons = [];
    const unsupportedCount = group.grammars.length - supported.length;
    if (unsupportedCount > 0) {
      reasons.push(
        `${String(unsupportedCount)} styled theme definition(s) are outside the exact grammar`,
      );
    }
    const unresolvedReads = group.reads.filter(
      (fact) => fact.status !== 'known',
    );
    if (unresolvedReads.length > 0) {
      reasons.push(
        `${String(unresolvedReads.length)} theme read(s) are not known`,
      );
    }
    const unmappedReads = group.reads.filter((fact) => {
      const value: $FlowFixMe = fact.value;
      return (
        typeof value.sourcePath !== 'string' ||
        !themePaths.has(value.sourcePath)
      );
    });
    if (unmappedReads.length > 0) {
      reasons.push(
        `${String(unmappedReads.length)} theme read(s) are outside converted declarations`,
      );
    }
    if (supported.length === 0) {
      reasons.push('no styled theme definition is inside the exact grammar');
    }
    const bridgeReady = reasons.length === 0;
    const localProviderReady =
      bridgeReady &&
      supported.every((fact) => {
        const value: $FlowFixMe = fact.value;
        return value.providerScoped === true;
      });
    candidates.push(
      Object.freeze({
        file,
        definitionNames: Object.freeze(
          supported
            .map((fact) => {
              const value: $FlowFixMe = fact.value;
              return String(value.name);
            })
            .sort(),
        ),
        definitionCount: supported.length,
        themePaths: Object.freeze([...themePaths].sort()),
        localProviderReady,
        bridgeReady,
        reasons: Object.freeze(reasons.sort()),
      }),
    );
  }
  candidates.sort((left, right) => left.file.localeCompare(right.file));
  const bridgeReady = candidates.filter((candidate) => candidate.bridgeReady);
  return Object.freeze({
    inventoryId: inventory.id,
    counts: Object.freeze({
      files: candidates.length,
      definitions: candidates.reduce(
        (sum, candidate) => sum + candidate.definitionCount,
        0,
      ),
      localProviderReadyFiles: candidates.filter(
        (candidate) => candidate.localProviderReady,
      ).length,
      bridgeReadyFiles: bridgeReady.length,
      bridgeReadyDefinitions: bridgeReady.reduce(
        (sum, candidate) => sum + candidate.definitionCount,
        0,
      ),
    }),
    candidates: Object.freeze(candidates),
    limitations: Object.freeze([
      'bridge-ready is a closed same-file syntax and usage result, not proof that a repository bridge exists or covers the file',
      'candidate proposal, StyleX compile/lint, repository checks, and configured runtime cases remain required',
    ]),
  });
}

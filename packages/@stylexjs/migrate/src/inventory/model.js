/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { hashFields, hashString, shortHash } from '../kernel/hash';
import { canonicalJson, immutableJson } from '../state/json';
import type { JsonValue } from '../state/json';

export type FactStatus = 'known' | 'inferred' | 'unknown' | 'resolution-failed';

export type Classification =
  | 'mechanical'
  | 'repeatable-contextual'
  | 'bespoke-contextual'
  | 'owner-decision';

export type FactProvenance = {
  +kind: 'source' | 'config' | 'resolver' | 'parser' | 'filesystem',
  +file: string | null,
  +detail: string,
};

export type Fact = {
  +id: string,
  +kind: string,
  +status: FactStatus,
  +value: JsonValue,
  +provenance: $ReadOnlyArray<FactProvenance>,
  +inputFiles: $ReadOnlyArray<string>,
};

export type SourceSpan = {
  +start: number,
  +end: number,
};

export type Site = {
  +id: string,
  +adapter: string,
  +kind: string,
  +file: string,
  +span: SourceSpan,
  +sourceHash: string,
  +syntax: 'supported' | 'refused',
  +refusalReason: string | null,
  +factIds: $ReadOnlyArray<string>,
  +classification: Classification,
  +routingReasons: $ReadOnlyArray<string>,
};

export type InventoryFile = {
  +path: string,
  +sourceHash: string | null,
  +status: 'scanned' | 'parse-failed' | 'read-failed',
  +siteIds: $ReadOnlyArray<string>,
  +factIds: $ReadOnlyArray<string>,
};

export type InventoryDiagnostic = {
  +file: string,
  +kind: 'read' | 'parse',
  +detail: string,
  +factId: string,
};

export type Inventory = {
  +id: string,
  +repositoryRoot: string,
  +sourceGlobs: $ReadOnlyArray<string>,
  +files: $ReadOnlyArray<InventoryFile>,
  +sites: $ReadOnlyArray<Site>,
  +facts: $ReadOnlyArray<Fact>,
  +diagnostics: $ReadOnlyArray<InventoryDiagnostic>,
  +configInputs: $ReadOnlyArray<string>,
  +scannedAt: string,
};

export function createFact({
  kind,
  status,
  value,
  provenance,
  inputFiles,
}: {
  +kind: string,
  +status: FactStatus,
  +value: JsonValue,
  +provenance: $ReadOnlyArray<FactProvenance>,
  +inputFiles: $ReadOnlyArray<string>,
}): Fact {
  const stableInputs = [...new Set(inputFiles)].sort();
  const stableProvenance = [...provenance].sort((a, b) =>
    canonicalJson(a) < canonicalJson(b) ? -1 : 1,
  );
  const frozenValue = immutableJson(value);
  const id = shortHash(
    hashString(
      canonicalJson({
        kind,
        status,
        value: frozenValue,
        provenance: stableProvenance,
        inputFiles: stableInputs,
      }),
    ),
  );
  return Object.freeze({
    id,
    kind,
    status,
    value: frozenValue,
    provenance: Object.freeze(
      stableProvenance.map((item) => Object.freeze({ ...item })),
    ),
    inputFiles: Object.freeze(stableInputs),
  });
}

export function siteIdentity({
  adapter,
  kind,
  file,
  span,
  sourceHash,
}: {
  +adapter: string,
  +kind: string,
  +file: string,
  +span: SourceSpan,
  +sourceHash: string,
}): string {
  return shortHash(
    hashFields([
      adapter,
      kind,
      file,
      String(span.start),
      String(span.end),
      sourceHash,
    ]),
  );
}

export function inventoryIdentity(inventory: {
  +repositoryRoot: string,
  +sourceGlobs: $ReadOnlyArray<string>,
  +files: $ReadOnlyArray<InventoryFile>,
  +sites: $ReadOnlyArray<Site>,
  +facts: $ReadOnlyArray<Fact>,
  +diagnostics: $ReadOnlyArray<InventoryDiagnostic>,
  +configInputs: $ReadOnlyArray<string>,
}): string {
  return shortHash(hashString(canonicalJson(inventory as $FlowFixMe)));
}

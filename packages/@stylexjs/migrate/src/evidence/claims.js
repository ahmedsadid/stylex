/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

/**
 * The claims vocabulary.
 *
 * Every result names exactly one of these, and nothing in this package is
 * allowed to describe output as proven, safe, verified, or equivalent without
 * one. A claim that does not say what was checked is not a claim, and the last
 * generation of this tool shipped a README that promised checks its own write
 * path never ran.
 */

import { VERSION } from '../version';

export type Claim =
  // Source and generated CSS are equal under a named, versioned model.
  | 'static-equivalent'
  // The listed commands passed, at the listed versions.
  | 'checks-passed'
  // Named runtime cases matched, for named states, in a recorded environment.
  | 'runtime-matched'
  // A human accepted one candidate hash and its stated limitations.
  | 'approved'
  // Information, support, or evidence that policy requires is missing.
  | 'blocked';

export type CheckOutcome = 'pass' | 'fail' | 'unavailable' | 'not-applicable';

export type EvidenceResult = {
  +check: string,
  +provider: string,
  +providerVersion: string,
  +scope: $ReadOnlyArray<string>,
  +result: CheckOutcome,
  +detail?: string,
  +limitations: $ReadOnlyArray<string>,
};

function versionOf(manifest: $FlowFixMe): string {
  const version = manifest?.version;
  return typeof version === 'string' ? version : 'unknown';
}

/**
 * Provider versions are read from the packages themselves, so evidence records
 * what actually ran rather than what this package was written against. A
 * result that does not say which version produced it cannot be reproduced.
 */
const PROVIDER_VERSIONS: { +[string]: string } = {
  'stylex-migrate': VERSION,
  // $FlowFixMe[cannot-resolve-module] Manifests are read for provenance only.
  '@stylexjs/babel-plugin': versionOf(
    require('@stylexjs/babel-plugin/package.json'),
  ),
  // $FlowFixMe[cannot-resolve-module] Manifests are read for provenance only.
  '@emotion/serialize': versionOf(require('@emotion/serialize/package.json')),
};

export function packageVersion(name: string): string {
  return PROVIDER_VERSIONS[name] ?? 'unknown';
}

export function evidence({
  check,
  provider,
  scope,
  result,
  detail,
  limitations = [],
}: {
  +check: string,
  +provider: string,
  +scope: $ReadOnlyArray<string>,
  +result: CheckOutcome,
  +detail?: string,
  +limitations?: $ReadOnlyArray<string>,
}): EvidenceResult {
  return Object.freeze({
    check,
    provider,
    providerVersion: packageVersion(provider),
    scope: Object.freeze([...scope]),
    result,
    ...(detail == null ? {} : { detail }),
    limitations: Object.freeze([...limitations]),
  });
}

export function allPassed(results: $ReadOnlyArray<EvidenceResult>): boolean {
  return results.every(
    (result) => result.result === 'pass' || result.result === 'not-applicable',
  );
}

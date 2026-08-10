/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { VERSION } from '../version';
import { makeEvidence } from '../kernel/evidence';
import type {
  CheckOutcome,
  EvidenceResult,
  EvidenceSubject,
} from '../kernel/evidence';

/**
 * Who produced a piece of evidence, and at what version.
 *
 * The contract itself lives in the kernel; this layer knows the actual tools.
 * Versions are read from the packages that ran rather than written down here,
 * because a result that does not say which version produced it cannot be
 * reproduced — and a version recorded as `unknown` is a gap in the same
 * promise.
 */

function versionOf(manifest: $FlowFixMe): string {
  const version = manifest?.version;
  return typeof version === 'string' ? version : 'unknown';
}

const PROVIDER_VERSIONS: { +[string]: string } = {
  'stylex-migrate': VERSION,
  // $FlowFixMe[cannot-resolve-module] Manifests are read for provenance only.
  '@stylexjs/babel-plugin': versionOf(
    require('@stylexjs/babel-plugin/package.json'),
  ),
  // $FlowFixMe[cannot-resolve-module] Manifests are read for provenance only.
  '@emotion/serialize': versionOf(require('@emotion/serialize/package.json')),
  // $FlowFixMe[cannot-resolve-module] Manifests are read for provenance only.
  '@stylexjs/eslint-plugin': versionOf(
    require('@stylexjs/eslint-plugin/package.json'),
  ),
  // $FlowFixMe[cannot-resolve-module] Manifests are read for provenance only.
  eslint: versionOf(require('eslint/package.json')),
  // $FlowFixMe[cannot-resolve-module] Manifests are read for provenance only.
  'hermes-eslint': versionOf(require('hermes-eslint/package.json')),
  // $FlowFixMe[cannot-resolve-module] Manifests are read for provenance only.
  '@typescript-eslint/parser': versionOf(
    require('@typescript-eslint/parser/package.json'),
  ),
  postcss: versionOf(require('postcss/package.json')),
};

export function packageVersion(name: string): string {
  return PROVIDER_VERSIONS[name] ?? 'unknown';
}

/**
 * Record a result, filling in the provider's version from what is installed.
 */
export function evidence({
  check,
  provider,
  subject,
  scope,
  result,
  detail,
  limitations = [],
}: {
  +check: string,
  +provider: string,
  +subject: EvidenceSubject,
  +scope: $ReadOnlyArray<string>,
  +result: CheckOutcome,
  +detail?: string,
  +limitations?: $ReadOnlyArray<string>,
}): EvidenceResult {
  return makeEvidence({
    check,
    provider,
    providerVersion: packageVersion(provider),
    subject,
    scope,
    result,
    ...(detail == null ? {} : { detail }),
    limitations,
  });
}

export { allPassed, makeEvidence } from '../kernel/evidence';
export type {
  Claim,
  CheckOutcome,
  EvidenceResult,
  EvidenceSubject,
} from '../kernel/evidence';

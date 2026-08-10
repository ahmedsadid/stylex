/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

/**
 * The evidence contract.
 *
 * This is the shape of a result and the rule for reading a set of them. It
 * knows nothing about which tools produce evidence — that belongs to the
 * providers, which arrive with the checks themselves. The kernel needs the
 * contract because a commit plan has to decide whether a candidate's evidence
 * permits a write, and it must be able to do that without depending on any
 * particular checker existing.
 *
 * The claim vocabulary lives here for the same reason: it is what the system is
 * allowed to say, not what any one tool reports.
 */

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

/**
 * What a check looked at.
 *
 * Evidence that does not name the exact bytes it examined cannot be tied to
 * anything later: a result recorded for "this file" says nothing once the file
 * changes. Both hashes travel with every result so that a candidate can be
 * required to contain precisely the code that was checked.
 */
export type EvidenceSubject = {
  // Hash of the source the proposal was derived from.
  +sourceHash: string,
  // Hash of the generated code the check ran against.
  +targetHash: string,
  // The named comparison model, where one applies.
  +model?: string,
};

export type EvidenceResult = {
  +check: string,
  +provider: string,
  +providerVersion: string,
  +subject: EvidenceSubject,
  +scope: $ReadOnlyArray<string>,
  +result: CheckOutcome,
  +detail?: string,
  +limitations: $ReadOnlyArray<string>,
};

export function makeEvidence({
  check,
  provider,
  providerVersion,
  subject,
  scope,
  result,
  detail,
  limitations = [],
}: {
  +check: string,
  +provider: string,
  +providerVersion: string,
  +subject: EvidenceSubject,
  +scope: $ReadOnlyArray<string>,
  +result: CheckOutcome,
  +detail?: string,
  +limitations?: $ReadOnlyArray<string>,
}): EvidenceResult {
  return Object.freeze({
    check,
    provider,
    providerVersion,
    subject: Object.freeze({ ...subject }),
    scope: Object.freeze([...scope]),
    result,
    ...(detail == null ? {} : { detail }),
    limitations: Object.freeze([...limitations]),
  });
}

/**
 * `unavailable` is not a pass. A check that could not run has established
 * nothing, and treating it as success is how a green summary comes to mean
 * less than it appears to.
 */
export function allPassed(results: $ReadOnlyArray<EvidenceResult>): boolean {
  return results.every(
    (result) => result.result === 'pass' || result.result === 'not-applicable',
  );
}

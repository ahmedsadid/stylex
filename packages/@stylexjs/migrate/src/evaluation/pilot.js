/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { hashString, shortHash } from '../kernel/hash';
import { canonicalJson, immutableJson } from '../state/json';
import type { JsonValue } from '../state/json';

export const PILOT_PROTOCOL_VERSION = 'stylex-migrate-pilot-v1';

export type PilotArm = 'ordinary-agent' | 'control-plane';
export type PilotLane = 'mechanical' | 'theme' | 'contextual';
export type PilotOutcome = 'accepted' | 'rejected' | 'blocked';
export type Availability = 'pass' | 'fail' | 'unavailable' | 'not-applicable';

export type NumericObservation =
  | { +status: 'observed', +value: number, +provenance: string }
  | { +status: 'unavailable' | 'not-applicable', +reason: string };

export type MutationObservation =
  | {
      +status: 'observed',
      +killed: number,
      +total: number,
      +provenance: string,
    }
  | { +status: 'unavailable' | 'not-applicable', +reason: string };

export type PilotObservation = {
  +id: string,
  +protocolVersion: string,
  +caseId: string,
  +arm: PilotArm,
  +lane: PilotLane,
  +repository: string,
  +revision: string,
  +scope: string,
  +outcome: PilotOutcome,
  +claims: $ReadOnlyArray<string>,
  +evidence: {
    +staticComparison: Availability,
    +repositoryChecks: Availability,
    +runtimeEvidence: Availability,
  },
  +metrics: {
    +humanMinutes: NumericObservation,
    +attempts: NumericObservation,
    +wallTimeMs: NumericObservation,
    +inputTokens: NumericObservation,
    +outputTokens: NumericObservation,
    +tokenCostUsd: NumericObservation,
    +reviewerInterventions: NumericObservation,
    +postAcceptanceRegressions: NumericObservation,
    +mutationScore: MutationObservation,
  },
  +acceptedWarnings: $ReadOnlyArray<{
    +warning: string,
    +rationale: string,
    +regressionObserved: 'yes' | 'no' | 'unknown',
  }>,
  +notes: $ReadOnlyArray<string>,
};

type MetricName =
  | 'humanMinutes'
  | 'attempts'
  | 'wallTimeMs'
  | 'inputTokens'
  | 'outputTokens'
  | 'tokenCostUsd'
  | 'reviewerInterventions'
  | 'postAcceptanceRegressions';

type EvidenceName = 'staticComparison' | 'repositoryChecks' | 'runtimeEvidence';

export type MetricSummary = {
  +observed: number,
  +unavailable: number,
  +notApplicable: number,
  +median: number | null,
};

export type PilotComparison = {
  +protocolVersion: string,
  +observationIds: $ReadOnlyArray<string>,
  +pairedCaseIds: $ReadOnlyArray<string>,
  +unpaired: {
    +'ordinary-agent': $ReadOnlyArray<string>,
    +'control-plane': $ReadOnlyArray<string>,
  },
  +repositories: $ReadOnlyArray<string>,
  +arms: {
    +'ordinary-agent': {
      +observations: number,
      +outcomes: { +accepted: number, +rejected: number, +blocked: number },
      +evidenceBackedAccepted: number,
      +evidence: { +[string]: { +[string]: number } },
      +metrics: { +[MetricName]: MetricSummary },
      +mutationScore: MetricSummary,
    },
    +'control-plane': {
      +observations: number,
      +outcomes: { +accepted: number, +rejected: number, +blocked: number },
      +evidenceBackedAccepted: number,
      +evidence: { +[string]: { +[string]: number } },
      +metrics: { +[MetricName]: MetricSummary },
      +mutationScore: MetricSummary,
    },
  },
  +pairedMedianDelta: { +[MetricName]: MetricSummary },
  +acceptedWarnings: {
    +total: number,
    +withRegression: number,
    +withoutRegression: number,
    +unknownOutcome: number,
  },
  +readiness: {
    +status: 'ready-for-scope-decision' | 'insufficient-evidence',
    +reasons: $ReadOnlyArray<string>,
  },
  +limitations: $ReadOnlyArray<string>,
};

const ARMS: $ReadOnlyArray<PilotArm> = Object.freeze([
  'ordinary-agent',
  'control-plane',
]);
const METRICS: $ReadOnlyArray<MetricName> = Object.freeze([
  'humanMinutes',
  'attempts',
  'wallTimeMs',
  'inputTokens',
  'outputTokens',
  'tokenCostUsd',
  'reviewerInterventions',
  'postAcceptanceRegressions',
]);
const EVIDENCE_FIELDS: $ReadOnlyArray<EvidenceName> = Object.freeze([
  'staticComparison',
  'repositoryChecks',
  'runtimeEvidence',
]);
const AVAILABILITY = new Set(['pass', 'fail', 'unavailable', 'not-applicable']);

function object(value: mixed): boolean {
  return value != null && !Array.isArray(value) && typeof value === 'object';
}

function nonEmpty(value: mixed, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Pilot ${field} must be a non-empty string`);
  }
  return value;
}

function strings(value: mixed, field: string): $ReadOnlyArray<string> {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Pilot ${field} must be an array of strings`);
  }
  const items: Array<string> = (value as $FlowFixMe).map((item) => item);
  return Object.freeze([...new Set(items)].sort());
}

function numeric(value: mixed, field: string): NumericObservation {
  const input: $FlowFixMe = value;
  if (!object(input)) {
    throw new Error(`Pilot metric ${field} must be an object`);
  }
  if (input.status === 'observed') {
    if (
      typeof input.value !== 'number' ||
      !Number.isFinite(input.value) ||
      input.value < 0
    ) {
      throw new Error(
        `Pilot metric ${field} must be a finite non-negative number`,
      );
    }
    return Object.freeze({
      status: 'observed',
      value: input.value,
      provenance: nonEmpty(input.provenance, `${field} provenance`),
    });
  }
  if (input.status === 'unavailable' || input.status === 'not-applicable') {
    return Object.freeze({
      status: input.status,
      reason: nonEmpty(input.reason, `${field} reason`),
    });
  }
  throw new Error(`Pilot metric ${field} has an invalid status`);
}

function mutation(value: mixed): MutationObservation {
  const input: $FlowFixMe = value;
  if (!object(input)) {
    throw new Error('Pilot mutationScore must be an object');
  }
  if (input.status !== 'observed') {
    if (input.status !== 'unavailable' && input.status !== 'not-applicable') {
      throw new Error('Pilot mutationScore has an invalid status');
    }
    return Object.freeze({
      status: input.status,
      reason: nonEmpty(input.reason, 'mutationScore reason'),
    });
  }
  if (
    !Number.isInteger(input.killed) ||
    !Number.isInteger(input.total) ||
    input.killed < 0 ||
    input.total <= 0 ||
    input.killed > input.total
  ) {
    throw new Error('Pilot mutationScore requires 0 <= killed <= total');
  }
  return Object.freeze({
    status: 'observed',
    killed: input.killed,
    total: input.total,
    provenance: nonEmpty(input.provenance, 'mutationScore provenance'),
  });
}

function availability(value: mixed, field: string): Availability {
  if (typeof value !== 'string' || !AVAILABILITY.has(value)) {
    throw new Error(`Pilot evidence ${field} has an invalid status`);
  }
  return value as $FlowFixMe;
}

export function createPilotObservation(value: mixed): PilotObservation {
  const input: $FlowFixMe = value;
  if (!object(input) || !object(input.evidence) || !object(input.metrics)) {
    throw new Error('Pilot observation must contain evidence and metrics');
  }
  if (input.protocolVersion !== PILOT_PROTOCOL_VERSION) {
    throw new Error(`Pilot protocol must be ${PILOT_PROTOCOL_VERSION}`);
  }
  if (!ARMS.includes(input.arm)) {
    throw new Error('Pilot arm must be ordinary-agent or control-plane');
  }
  if (!['mechanical', 'theme', 'contextual'].includes(input.lane)) {
    throw new Error('Pilot lane must be mechanical, theme, or contextual');
  }
  if (!['accepted', 'rejected', 'blocked'].includes(input.outcome)) {
    throw new Error('Pilot outcome must be accepted, rejected, or blocked');
  }
  const metrics: { [MetricName]: NumericObservation } = {} as $FlowFixMe;
  for (const name of METRICS) {
    metrics[name] = numeric(input.metrics[name], name);
  }
  if (!Array.isArray(input.acceptedWarnings)) {
    throw new Error('Pilot acceptedWarnings must be an array');
  }
  const acceptedWarnings = input.acceptedWarnings.map((entry, index) => {
    if (
      !object(entry) ||
      !['yes', 'no', 'unknown'].includes(entry.regressionObserved)
    ) {
      throw new Error(`Pilot acceptedWarnings[${index}] is invalid`);
    }
    return Object.freeze({
      warning: nonEmpty(entry.warning, `acceptedWarnings[${index}].warning`),
      rationale: nonEmpty(
        entry.rationale,
        `acceptedWarnings[${index}].rationale`,
      ),
      regressionObserved: entry.regressionObserved,
    });
  });
  const stable: $FlowFixMe = {
    protocolVersion: PILOT_PROTOCOL_VERSION,
    caseId: nonEmpty(input.caseId, 'caseId'),
    arm: input.arm,
    lane: input.lane,
    repository: nonEmpty(input.repository, 'repository'),
    revision: nonEmpty(input.revision, 'revision'),
    scope: nonEmpty(input.scope, 'scope'),
    outcome: input.outcome,
    claims: strings(input.claims, 'claims'),
    evidence: Object.freeze({
      staticComparison: availability(
        input.evidence.staticComparison,
        'staticComparison',
      ),
      repositoryChecks: availability(
        input.evidence.repositoryChecks,
        'repositoryChecks',
      ),
      runtimeEvidence: availability(
        input.evidence.runtimeEvidence,
        'runtimeEvidence',
      ),
    }),
    metrics: Object.freeze({
      ...metrics,
      mutationScore: mutation(input.metrics.mutationScore),
    }),
    acceptedWarnings: Object.freeze(acceptedWarnings),
    notes: strings(input.notes, 'notes'),
  };
  const frozen = immutableJson(stable as JsonValue);
  return Object.freeze({
    id: shortHash(hashString(canonicalJson(frozen))),
    ...(frozen as $FlowFixMe),
  });
}

function median(values: $ReadOnlyArray<number>): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function metricSummary(
  observations: $ReadOnlyArray<NumericObservation>,
): MetricSummary {
  const values = observations.flatMap((item) =>
    item.status === 'observed' ? [item.value] : [],
  );
  return Object.freeze({
    observed: values.length,
    unavailable: observations.filter((item) => item.status === 'unavailable')
      .length,
    notApplicable: observations.filter(
      (item) => item.status === 'not-applicable',
    ).length,
    median: median(values),
  });
}

function armSummary(
  observations: $ReadOnlyArray<PilotObservation>,
): $FlowFixMe {
  const outcomes = { accepted: 0, rejected: 0, blocked: 0 };
  const evidence: { [EvidenceName]: { [string]: number } } = {
    staticComparison: {},
    repositoryChecks: {},
    runtimeEvidence: {},
  };
  for (const observation of observations) {
    outcomes[observation.outcome]++;
    for (const field of EVIDENCE_FIELDS) {
      const status = observation.evidence[field];
      evidence[field][status] = (evidence[field][status] ?? 0) + 1;
    }
  }
  const metrics: { [MetricName]: MetricSummary } = {} as $FlowFixMe;
  for (const name of METRICS) {
    metrics[name] = metricSummary(
      observations.map((observation) => observation.metrics[name]),
    );
  }
  const mutationValues: Array<NumericObservation> = observations.map(
    (observation): NumericObservation => {
      const item = observation.metrics.mutationScore;
      return item.status === 'observed'
        ? Object.freeze({
            status: 'observed',
            value: item.killed / item.total,
            provenance: item.provenance,
          })
        : item;
    },
  );
  return Object.freeze({
    observations: observations.length,
    outcomes: Object.freeze(outcomes),
    evidenceBackedAccepted: observations.filter(
      (item) =>
        item.outcome === 'accepted' &&
        item.claims.length > 0 &&
        item.evidence.repositoryChecks === 'pass',
    ).length,
    evidence: immutableJson(evidence as $FlowFixMe),
    metrics: Object.freeze(metrics),
    mutationScore: metricSummary(mutationValues),
  });
}

export function comparePilotObservations(
  values: $ReadOnlyArray<mixed>,
): PilotComparison {
  const observations = values.map(createPilotObservation);
  if (observations.length === 0) {
    throw new Error('Pilot comparison requires at least one observation');
  }
  if (
    new Set(observations.map((item) => item.id)).size !== observations.length
  ) {
    throw new Error('Pilot comparison contains duplicate observations');
  }
  const byCase = new Map<string, Map<PilotArm, PilotObservation>>();
  for (const observation of observations) {
    const arms = byCase.get(observation.caseId) ?? new Map();
    if (arms.has(observation.arm)) {
      throw new Error(
        `Pilot case ${observation.caseId} has two ${observation.arm} observations`,
      );
    }
    arms.set(observation.arm, observation);
    byCase.set(observation.caseId, arms);
  }
  const pairs: Array<{
    +'ordinary-agent': PilotObservation,
    +'control-plane': PilotObservation,
  }> = [];
  const unpaired: { [PilotArm]: Array<string> } = {
    'ordinary-agent': [],
    'control-plane': [],
  };
  for (const [caseId, arms] of byCase) {
    const ordinary = arms.get('ordinary-agent');
    const control = arms.get('control-plane');
    if (ordinary == null || control == null) {
      unpaired[ordinary == null ? 'control-plane' : 'ordinary-agent'].push(
        caseId,
      );
      continue;
    }
    const pins = [
      ['lane', ordinary.lane, control.lane],
      ['repository', ordinary.repository, control.repository],
      ['revision', ordinary.revision, control.revision],
      ['scope', ordinary.scope, control.scope],
    ];
    for (const [field, ordinaryValue, controlValue] of pins) {
      if (ordinaryValue !== controlValue) {
        throw new Error(
          `Pilot case ${caseId} does not pin the same ${field} in both arms`,
        );
      }
    }
    pairs.push({ 'ordinary-agent': ordinary, 'control-plane': control });
  }

  const pairedMedianDelta: { [MetricName]: MetricSummary } = {} as $FlowFixMe;
  for (const name of METRICS) {
    const deltas: Array<NumericObservation> = pairs.map((pair) => {
      const ordinary = pair['ordinary-agent'].metrics[name];
      const control = pair['control-plane'].metrics[name];
      return ordinary.status === 'observed' && control.status === 'observed'
        ? {
            status: 'observed',
            value: control.value - ordinary.value,
            provenance: 'paired control-plane minus ordinary-agent',
          }
        : {
            status: 'unavailable',
            reason: 'one or both paired observations are unavailable',
          };
    });
    // Deltas may be negative, unlike raw duration and count observations.
    const values = deltas.flatMap((item) =>
      item.status === 'observed' ? [item.value] : [],
    );
    pairedMedianDelta[name] = Object.freeze({
      observed: values.length,
      unavailable: deltas.length - values.length,
      notApplicable: 0,
      median: median(values),
    });
  }

  const warnings = observations.flatMap((item) => item.acceptedWarnings);
  const reasons = [];
  const repositories = [
    ...new Set(pairs.map((pair) => pair['control-plane'].repository)),
  ].sort();
  if (pairs.length < 2) reasons.push('fewer than two paired cases');
  if (repositories.length < 2)
    reasons.push('fewer than two pinned repositories');
  const requiredPairedMetrics: $ReadOnlyArray<MetricName> = [
    'humanMinutes',
    'attempts',
    'wallTimeMs',
    'reviewerInterventions',
  ];
  for (const name of requiredPairedMetrics) {
    if (pairedMedianDelta[name].observed !== pairs.length) {
      reasons.push(`${name} is unavailable for one or more paired cases`);
    }
  }
  for (const arm of ARMS) {
    if (
      observations.filter(
        (item) =>
          item.arm === arm &&
          item.outcome === 'accepted' &&
          item.claims.length > 0 &&
          item.evidence.repositoryChecks === 'pass',
      ).length === 0
    ) {
      reasons.push(`${arm} has no evidence-backed accepted case`);
    }
  }

  return Object.freeze({
    protocolVersion: PILOT_PROTOCOL_VERSION,
    observationIds: Object.freeze(observations.map((item) => item.id).sort()),
    pairedCaseIds: Object.freeze(
      pairs.map((pair) => pair['control-plane'].caseId).sort(),
    ),
    unpaired: Object.freeze({
      'ordinary-agent': Object.freeze(unpaired['ordinary-agent'].sort()),
      'control-plane': Object.freeze(unpaired['control-plane'].sort()),
    }),
    repositories: Object.freeze(repositories),
    arms: Object.freeze({
      'ordinary-agent': armSummary(
        observations.filter((item) => item.arm === 'ordinary-agent'),
      ),
      'control-plane': armSummary(
        observations.filter((item) => item.arm === 'control-plane'),
      ),
    }),
    pairedMedianDelta: Object.freeze(pairedMedianDelta),
    acceptedWarnings: Object.freeze({
      total: warnings.length,
      withRegression: warnings.filter(
        (item) => item.regressionObserved === 'yes',
      ).length,
      withoutRegression: warnings.filter(
        (item) => item.regressionObserved === 'no',
      ).length,
      unknownOutcome: warnings.filter(
        (item) => item.regressionObserved === 'unknown',
      ).length,
    }),
    readiness: Object.freeze({
      status:
        reasons.length === 0
          ? 'ready-for-scope-decision'
          : 'insufficient-evidence',
      reasons: Object.freeze(reasons),
    }),
    limitations: Object.freeze([
      'paired deltas are control-plane minus ordinary-agent; negative values favor the control plane for cost and time metrics',
      'missing measurements remain unavailable and are never imputed as zero',
      'evidence-backed means the observation records at least one claim and passing repository checks; it does not imply equivalence',
      'this comparison reports observations and does not choose the product direction',
    ]),
  });
}

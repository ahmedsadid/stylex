/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  comparePilotObservations,
  createPilotObservation,
  PILOT_PROTOCOL_VERSION,
} from '../src/evaluation/pilot';

const observed = (value: number) => ({
  status: 'observed',
  value,
  provenance: 'timed pilot log',
});

function input({
  caseId = 'button-flat',
  arm = 'control-plane',
  repository = 'https://example.test/repo-a',
  revision = 'abc123',
  humanMinutes = 4,
  wallTimeMs = 30000,
  warnings = [],
}: $FlowFixMe = {}): $FlowFixMe {
  return {
    protocolVersion: PILOT_PROTOCOL_VERSION,
    caseId,
    arm,
    lane: 'mechanical',
    repository,
    revision,
    scope: 'src/Button.jsx#css-prop',
    outcome: 'accepted',
    claims: ['checks-passed', 'static-css-matched'],
    evidence: {
      staticComparison: arm === 'control-plane' ? 'pass' : 'not-applicable',
      repositoryChecks: 'pass',
      runtimeEvidence: 'unavailable',
    },
    metrics: {
      humanMinutes: observed(humanMinutes),
      attempts: observed(1),
      wallTimeMs: observed(wallTimeMs),
      inputTokens: {
        status: 'unavailable',
        reason: 'runner did not expose usage',
      },
      outputTokens: {
        status: 'unavailable',
        reason: 'runner did not expose usage',
      },
      tokenCostUsd: {
        status: 'unavailable',
        reason: 'runner did not expose billing',
      },
      reviewerInterventions: observed(1),
      postAcceptanceRegressions: observed(0),
      mutationScore:
        arm === 'control-plane'
          ? {
              status: 'observed',
              killed: 9,
              total: 9,
              provenance: 'mutation suite run',
            }
          : {
              status: 'not-applicable',
              reason: 'ordinary agent arm has no independent verifier',
            },
    },
    acceptedWarnings: warnings,
    notes: [],
  };
}

describe('M10 pilot evaluation', () => {
  test('creates stable observations and preserves unavailable measurements', () => {
    const first = createPilotObservation(input());
    const second = createPilotObservation(input());

    expect(first).toEqual(second);
    expect(first.id).toHaveLength(16);
    expect(first.metrics.inputTokens).toEqual({
      status: 'unavailable',
      reason: 'runner did not expose usage',
    });
    expect(first.metrics.inputTokens).not.toHaveProperty('value');
  });

  test('compares paired arms without inventing missing costs', () => {
    const warning = {
      warning: 'no runtime evidence was configured',
      rationale: 'local literal declaration covered by static comparison',
      regressionObserved: 'unknown',
    };
    const comparison = comparePilotObservations([
      input({
        caseId: 'repo-a-flat',
        arm: 'ordinary-agent',
        humanMinutes: 10,
        wallTimeMs: 20000,
      }),
      input({
        caseId: 'repo-a-flat',
        humanMinutes: 3,
        wallTimeMs: 30000,
        warnings: [warning],
      }),
      input({
        caseId: 'repo-b-flat',
        arm: 'ordinary-agent',
        repository: 'https://example.test/repo-b',
        revision: 'def456',
        humanMinutes: 8,
        wallTimeMs: 18000,
      }),
      input({
        caseId: 'repo-b-flat',
        repository: 'https://example.test/repo-b',
        revision: 'def456',
        humanMinutes: 2,
        wallTimeMs: 28000,
      }),
    ]);

    expect(comparison.pairedCaseIds).toEqual(['repo-a-flat', 'repo-b-flat']);
    expect(comparison.repositories).toEqual([
      'https://example.test/repo-a',
      'https://example.test/repo-b',
    ]);
    expect(comparison.pairedMedianDelta.humanMinutes).toEqual({
      observed: 2,
      unavailable: 0,
      notApplicable: 0,
      median: -6.5,
    });
    expect(comparison.pairedMedianDelta.wallTimeMs.median).toBe(10000);
    expect(comparison.pairedMedianDelta.tokenCostUsd).toEqual({
      observed: 0,
      unavailable: 2,
      notApplicable: 0,
      median: null,
    });
    expect(comparison.arms['control-plane'].mutationScore).toEqual({
      observed: 2,
      unavailable: 0,
      notApplicable: 0,
      median: 1,
    });
    expect(comparison.acceptedWarnings).toEqual({
      total: 1,
      withRegression: 0,
      withoutRegression: 0,
      unknownOutcome: 1,
    });
    expect(comparison.readiness).toEqual({
      status: 'ready-for-scope-decision',
      reasons: [],
    });
    expect(comparison.limitations).toContain(
      'missing measurements remain unavailable and are never imputed as zero',
    );
  });

  test('reports why a partial pilot cannot support a scope decision', () => {
    const comparison = comparePilotObservations([input()]);

    expect(comparison.readiness.status).toBe('insufficient-evidence');
    expect(comparison.readiness.reasons).toEqual(
      expect.arrayContaining([
        'fewer than two paired cases',
        'fewer than two pinned repositories',
        'ordinary-agent has no evidence-backed accepted case',
      ]),
    );
    expect(comparison.unpaired['control-plane']).toEqual(['button-flat']);
  });

  test('rejects invalid measurements and mismatched paired scopes', () => {
    const invalid = input();
    invalid.metrics.humanMinutes = observed(-1);
    expect(() => createPilotObservation(invalid)).toThrow(
      'must be a finite non-negative number',
    );

    const mismatched = input({ arm: 'ordinary-agent' });
    mismatched.scope = 'src/Other.jsx#css-prop';
    expect(() => comparePilotObservations([mismatched, input()])).toThrow(
      'does not pin the same scope',
    );
  });
});

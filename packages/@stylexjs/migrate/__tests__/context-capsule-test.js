/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  CONTEXT_MAX_ATTEMPTS,
  CONTEXT_PROTOCOL_VERSION,
  createContextAttemptCapsule,
  createContextTaskCapsule,
  createFact,
  validateContextAttemptCapsule,
  validateContextTaskCapsule,
} from '../src/index';

function task(): $FlowFixMe {
  const fact = createFact({
    kind: 'project-activation',
    status: 'known',
    value: { active: true },
    provenance: [{ kind: 'config', file: 'babel.config.js', detail: 'plugin' }],
    inputFiles: ['babel.config.js'],
  });
  return createContextTaskCapsule({
    goal: 'Convert this cluster without changing its public behavior.',
    inventoryId: 'inventory-1',
    planId: 'plan-1',
    cluster: {
      id: 'cluster-1',
      siteIds: ['site-1'],
      changeFiles: ['src/card.js'],
      couplingFiles: ['src/tokens.js'],
      declaredInputs: ['babel.config.js', 'src/card.js', 'src/tokens.js'],
      factIds: [fact.id],
      classification: 'repeatable-contextual',
      routingReasons: ['theme values require repository context'],
      state: 'planned',
      blockedReasons: [],
    },
    repositoryRoot: '/repo',
    commit: 'a'.repeat(40),
    snapshotHash: 'b'.repeat(64),
    configHash: 'c'.repeat(64),
    declaredInputs: [
      { path: 'src/card.js', contentHash: 'd'.repeat(64), mode: '100644' },
      { path: 'babel.config.js', contentHash: 'e'.repeat(64), mode: '100644' },
    ],
    facts: [fact],
    scope: {
      allowedPaths: ['src/card.js'],
      protectedPaths: ['babel.config.js', '.stylex-migrate/**'],
      allowedDeletions: [],
      ownerDecisionPaths: [],
    },
    requiredChecks: [
      {
        id: 'repo-test',
        check: 'focused-test',
        checkVersion: 'v1',
        subject: 'candidate',
        limitations: ['does not render a browser'],
      },
    ],
    limitations: ['No runtime-matched claim is available in M7.'],
    stopConditions: ['Stop when a required fact is unknown.'],
    now: () => '2026-08-10T00:00:00.000Z',
  });
}

describe('M7 contextual task capsules', () => {
  test('binds facts, input hashes, scope, checks and the kernel attempt limit', () => {
    const capsule = task();
    expect(capsule.protocolVersion).toBe(CONTEXT_PROTOCOL_VERSION);
    expect(capsule.maxAttempts).toBe(CONTEXT_MAX_ATTEMPTS);
    expect(capsule.origin).toEqual({
      kind: 'plan-cluster',
      clusterId: 'cluster-1',
    });
    expect(capsule.requiredOutputs).toEqual([]);
    expect(capsule.declaredInputs.map((input) => input.path)).toEqual([
      'babel.config.js',
      'src/card.js',
    ]);
    expect(capsule.facts[0].status).toBe('known');
    expect(validateContextTaskCapsule(capsule)).toEqual(capsule);
  });

  test('detects changes to any task field', () => {
    const capsule = task();
    const changed = JSON.parse(JSON.stringify(capsule));
    changed.facts[0].status = 'unknown';
    expect(() => validateContextTaskCapsule(changed)).toThrow(
      'integrity check failed',
    );
  });

  test('binds dynamic strategies to the exact plan cluster', () => {
    const base = task();
    const capsule = createContextTaskCapsule({
      ...base,
      origin: {
        kind: 'dynamic-strategy',
        strategyId: 'dynamic-strategy-1',
        definitionHash: '7'.repeat(64),
        clusterId: base.cluster.id,
      },
      decisionArtifactHashes: ['7'.repeat(64)],
    });
    expect(capsule.origin).toEqual({
      kind: 'dynamic-strategy',
      strategyId: 'dynamic-strategy-1',
      definitionHash: '7'.repeat(64),
      clusterId: 'cluster-1',
    });
    expect(capsule.decisionArtifactHashes).toEqual(['7'.repeat(64)]);
    expect(() =>
      createContextTaskCapsule({
        ...base,
        origin: {
          kind: 'dynamic-strategy',
          strategyId: 'dynamic-strategy-1',
          definitionHash: '7'.repeat(64),
          clusterId: 'another-cluster',
        },
      }),
    ).toThrow('Invalid dynamic-strategy task origin');
  });

  test('binds bootstrap authority to exact task paths', () => {
    const base = task();
    const paths = ['package.json', 'pnpm-lock.yaml', 'rspack.config.ts'];
    const capsule = createContextTaskCapsule({
      ...base,
      origin: {
        kind: 'bootstrap',
        inspectionId: 'bootstrap-1',
        packageRoot: '',
        packageManager: 'pnpm',
        integration: 'rspack',
      },
      cluster: {
        ...base.cluster,
        id: 'bootstrap-work-1',
        changeFiles: paths,
      },
      scope: {
        allowedPaths: paths,
        protectedPaths: ['.stylex-migrate/**'],
        allowedDeletions: [],
        ownerDecisionPaths: [],
        bootstrapPaths: paths,
      },
    });

    expect(capsule.origin).toEqual({
      kind: 'bootstrap',
      inspectionId: 'bootstrap-1',
      packageRoot: '',
      packageManager: 'pnpm',
      integration: 'rspack',
    });
    expect(capsule.scope.bootstrapPaths).toEqual(paths);

    expect(() =>
      createContextTaskCapsule({
        ...base,
        scope: {
          ...base.scope,
          bootstrapPaths: ['package.json'],
        },
      }),
    ).toThrow('Only bootstrap tasks may authorize bootstrap paths');
    expect(() =>
      createContextTaskCapsule({
        ...base,
        origin: {
          kind: 'bootstrap',
          inspectionId: 'bootstrap-1',
          packageRoot: '',
          packageManager: 'pnpm',
          integration: 'rspack',
        },
        scope: {
          ...base.scope,
          bootstrapPaths: ['**/package.json'],
        },
      }),
    ).toThrow('Bootstrap tasks require exact allowed bootstrap paths');
  });

  test('binds attempt workspaces and prior failures', () => {
    const first = createContextAttemptCapsule({
      task: task(),
      attemptNumber: 1,
      workspacePath: '/tmp/attempt-1',
      now: () => '2026-08-10T00:01:00.000Z',
    });
    expect(validateContextAttemptCapsule(first)).toEqual(first);
    expect(first.requiredOutputs).toEqual([]);

    const second = createContextAttemptCapsule({
      task: task(),
      attemptNumber: 2,
      workspacePath: '/tmp/attempt-2',
      previousCandidateId: 'candidate-1',
      priorFailures: [
        {
          attemptId: first.id,
          outcome: 'rejected',
          reasons: ['repository test failed'],
          candidateId: 'candidate-1',
          verdictId: 'verdict-1',
        },
      ],
    });
    expect(second.priorFailures).toHaveLength(1);
    expect(() =>
      createContextAttemptCapsule({
        task: task(),
        attemptNumber: 3,
        workspacePath: '/tmp/attempt-3',
        priorFailures: second.priorFailures,
      }),
    ).toThrow('Invalid contextual attempt');
  });

  test('binds workflow origins and immutable generated outputs', () => {
    const base = task();
    const capsule = createContextTaskCapsule({
      ...base,
      origin: {
        kind: 'theme-bridge',
        draftId: 'theme-draft-1',
        definitionHash: 'f'.repeat(64),
        targetModule: 'src/theme.stylex.ts',
      },
      cluster: {
        ...base.cluster,
        id: 'theme-bridge-work-1',
        changeFiles: ['src/Provider.jsx', 'src/theme.stylex.ts'],
      },
      scope: {
        ...base.scope,
        allowedPaths: ['src/Provider.jsx', 'src/theme.stylex.ts'],
      },
      requiredOutputs: [
        {
          path: 'src/theme.stylex.ts',
          targetHash: '9'.repeat(64),
          role: 'generated-theme-module',
          mutable: false,
        },
      ],
    });
    expect(capsule.origin.kind).toBe('theme-bridge');
    expect(capsule.requiredOutputs).toEqual([
      expect.objectContaining({
        path: 'src/theme.stylex.ts',
        mutable: false,
      }),
    ]);
    const attempt = createContextAttemptCapsule({
      task: capsule,
      attemptNumber: 1,
      workspacePath: '/tmp/theme-bridge',
    });
    expect(attempt.requiredOutputs).toEqual(capsule.requiredOutputs);

    const changed = JSON.parse(JSON.stringify(capsule));
    changed.requiredOutputs[0].targetHash = '8'.repeat(64);
    expect(() => validateContextTaskCapsule(changed)).toThrow(
      'integrity check failed',
    );
  });

  test('refuses required outputs outside mutable task scope', () => {
    const base = task();
    expect(() =>
      createContextTaskCapsule({
        ...base,
        requiredOutputs: [
          {
            path: 'src/theme.stylex.ts',
            targetHash: '9'.repeat(64),
            role: 'generated-theme-module',
            mutable: false,
          },
        ],
      }),
    ).toThrow('Invalid contextual required output');
  });
});

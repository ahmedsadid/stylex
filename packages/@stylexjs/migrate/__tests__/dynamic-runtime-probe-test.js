/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import fs from 'fs';
import {
  DYNAMIC_RUNTIME_PROBE_PROTOCOL_VERSION,
  initializeProject,
  openDynamicRuntimeProbeTask,
  persistDynamicStrategyDraft,
  persistTestAssumption,
  saveInventory,
  savePlan,
  scanRepository,
  submitContextAttempt,
} from '../src/index';
import { createPlan } from '../src/planning/plan';
import { createTempDir, createTempRepo, removeTempDir } from './utils/tempRepo';

describe('dynamic runtime probe generation', () => {
  let repo;
  let workspaceRoot;

  beforeEach(() => {
    repo = createTempRepo({
      'package.json': JSON.stringify({ private: true }),
      'src/Card.tsx': `import styled from '@emotion/styled';
export function Card({active}) { return <Root active={active}>card</Root>; }
const Root = styled('div')\`display: \${p => p.active ? 'block' : 'none'};\`;
`,
    });
    workspaceRoot = createTempDir('stylex-migrate-dynamic-probe-');
  });

  afterEach(() => {
    removeTempDir(workspaceRoot);
    removeTempDir(repo);
  });

  test('locks a generated retained-baseline component surface', () => {
    const project = initializeProject({ repositoryRoot: repo });
    const inventory = scanRepository({ repositoryRoot: repo });
    saveInventory(project, inventory);
    const plan = createPlan({ inventory });
    savePlan(project, plan);
    const site = inventory.sites.find(
      (item) => item.kind === 'styled-dynamic-intrinsic',
    );
    const cluster = plan.clusters.find((item) =>
      item.siteIds.includes(site?.id ?? ''),
    );
    const dynamicFact = inventory.facts.find(
      (item) => item.kind === 'emotion-styled-dynamic-value',
    );
    if (site == null || cluster == null || dynamicFact == null) {
      throw new Error('Fixture dynamic site was not discovered');
    }
    const dynamic = dynamicFact.value as $FlowFixMe;
    const strategy = persistDynamicStrategyDraft({
      project,
      definition: {
        protocolVersion: 'stylex-migrate-dynamic-strategy-v1',
        inventoryId: inventory.id,
        clusterId: cluster.id,
        entries: [
          {
            definitionFactId: dynamic.definitionFactId,
            propPath: 'active',
            strategy: 'stylex-variants',
            rationale: 'Boolean literal display branch.',
            evidenceRequirements: ['Retained browser comparison.'],
          },
        ],
      },
      authorKind: 'agent',
      authoredBy: 'fixture-agent',
    });
    const assumption = persistTestAssumption({
      project,
      input: {
        purpose: 'Render the exact Card export with bounded props.',
        facts: [
          {
            statement: 'The fixture accepts the declared boolean props.',
            status: 'known',
            inputFiles: ['src/Card.tsx'],
            detail: 'Declared by the fixture source.',
          },
        ],
        scope: { files: ['src/Card.tsx'], cases: ['active', 'inactive'] },
        rationale: 'Exercise both finite branches.',
        alternatives: ['Repository-owned component test.'],
        limitations: ['Generated test host.'],
      },
      authorKind: 'agent',
      authoredBy: 'fixture-agent',
    });
    const opened = openDynamicRuntimeProbeTask({
      project,
      strategyId: strategy.id,
      assumptionId: assumption.id,
      value: {
        protocolVersion: DYNAMIC_RUNTIME_PROBE_PROTOCOL_VERSION,
        packageRoot: '.',
        playwrightPackage: 'playwright',
        nativeSurfaceDisposition: 'known-insufficient',
        consumer: { file: 'src/Card.tsx', exportName: 'Card' },
        siteIds: [site.id],
        cases: [
          {
            id: 'active',
            props: { active: true },
            theme: 'none',
            interaction: 'initial',
          },
          {
            id: 'inactive',
            props: { active: false },
            theme: 'none',
            interaction: 'initial',
          },
        ],
        targets: [
          {
            id: 'card',
            selector: '[data-stylex-migrate-dynamic-root] > *',
            computedProperties: ['display'],
            attributes: ['active'],
            observeDom: true,
            observeRef: true,
          },
        ],
        viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
        rationale: 'Compare retained and candidate component behavior.',
        limitations: ['Generated host.'],
      },
      goal: 'Generate the retained dynamic comparison.',
      workspaceRoot,
    });
    if (!opened.ok) throw new Error(opened.reasons.join('\n'));
    expect(opened.task.origin).toMatchObject({
      kind: 'evidence-surface',
      baselineKind: 'retained-repository',
      expectedObservations: null,
      syntheticCssExpectations: null,
    });
    expect(opened.task.requiredOutputs.map((item) => item.path)).toEqual([
      '.stylex-migrate-probes/dynamic-probe-entry.js',
      '.stylex-migrate-probes/dynamic-probe-rspack.cjs',
      '.stylex-migrate-probes/dynamic-probe-server.cjs',
      '.stylex-migrate-probes/runtime-collector.cjs',
      '.stylex-migrate-probes/runtime-probe.json',
    ]);
    expect(
      fs.readFileSync(
        `${opened.attempt.workspace.path}/.stylex-migrate-probes/dynamic-probe-entry.js`,
        'utf8',
      ),
    ).toContain('import {Card as ProbeConsumer}');
    expect(
      fs.readFileSync(
        `${opened.attempt.workspace.path}/.stylex-migrate-probes/dynamic-probe-rspack.cjs`,
        'utf8',
      ),
    ).toContain('require.resolve(name, {paths: moduleSearchPaths})');
    const submitted = submitContextAttempt({
      project,
      taskId: opened.task.id,
      proposerKind: 'agent',
      proposerVersion: 'fixture-v1',
    });
    expect(submitted).toMatchObject({
      ok: true,
      state: 'awaiting-verification',
    });
  });

  test('rejects consumer paths that can escape or inject generated source', () => {
    const project = initializeProject({ repositoryRoot: repo });
    const inventory = scanRepository({ repositoryRoot: repo });
    saveInventory(project, inventory);
    const plan = createPlan({ inventory });
    savePlan(project, plan);
    const site = inventory.sites.find(
      (item) => item.kind === 'styled-dynamic-intrinsic',
    );
    const cluster = plan.clusters.find((item) =>
      item.siteIds.includes(site?.id ?? ''),
    );
    const dynamicFact = inventory.facts.find(
      (item) => item.kind === 'emotion-styled-dynamic-value',
    );
    if (site == null || cluster == null || dynamicFact == null) {
      throw new Error('Fixture dynamic site was not discovered');
    }
    const dynamic = dynamicFact.value as $FlowFixMe;
    const strategy = persistDynamicStrategyDraft({
      project,
      definition: {
        protocolVersion: 'stylex-migrate-dynamic-strategy-v1',
        inventoryId: inventory.id,
        clusterId: cluster.id,
        entries: [
          {
            definitionFactId: dynamic.definitionFactId,
            propPath: 'active',
            strategy: 'stylex-variants',
            rationale: 'Boolean literal display branch.',
            evidenceRequirements: ['Retained browser comparison.'],
          },
        ],
      },
      authorKind: 'agent',
      authoredBy: 'fixture-agent',
    });
    const assumption = persistTestAssumption({
      project,
      input: {
        purpose: 'Reject an unsafe generated import.',
        facts: [
          {
            statement: 'The fixture component is the intended probe consumer.',
            status: 'known',
            inputFiles: ['src/Card.tsx'],
            detail: 'Declared by the fixture source.',
          },
        ],
        scope: { files: ['src/Card.tsx'], cases: ['invalid'] },
        rationale: 'Generated imports must stay inside the repository.',
        alternatives: [],
        limitations: [],
      },
      authorKind: 'agent',
      authoredBy: 'fixture-agent',
    });
    expect(() =>
      openDynamicRuntimeProbeTask({
        project,
        strategyId: strategy.id,
        assumptionId: assumption.id,
        value: {
          protocolVersion: DYNAMIC_RUNTIME_PROBE_PROTOCOL_VERSION,
          packageRoot: '.',
          playwrightPackage: 'playwright',
          nativeSurfaceDisposition: 'known-insufficient',
          consumer: { file: "../Card.tsx';alert(1)//", exportName: 'Card' },
          siteIds: [site.id],
          cases: [
            {
              id: 'invalid',
              props: {},
              theme: 'none',
              interaction: 'initial',
            },
          ],
          targets: [
            {
              id: 'card',
              selector: 'main > *',
              computedProperties: ['display'],
              attributes: [],
              observeDom: false,
              observeRef: false,
            },
          ],
          viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
          rationale: 'Invalid fixture.',
          limitations: [],
        },
        goal: 'Reject the unsafe path.',
        workspaceRoot,
      }),
    ).toThrow('Invalid dynamic runtime-probe input');
  });
});

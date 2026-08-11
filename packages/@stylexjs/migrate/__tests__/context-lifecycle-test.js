/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import fs from 'fs';
import path from 'path';
import {
  abandonContextTask,
  createPlan,
  initializeProject,
  inspectContextTask,
  openContextRetry,
  openContextTask,
  persistDynamicStrategyDraft,
  saveInventory,
  savePlan,
  scanRepository,
  submitContextAttempt,
  verifyPersistedCandidates,
  writeConfig,
} from '../src/index';
import type { ProjectState } from '../src/index';
import {
  createTempDir,
  createTempRepo,
  readFile,
  removeTempDir,
  writeFiles,
} from './utils/tempRepo';

describe('M7 contextual task lifecycle', () => {
  let repo: string;
  let workspaceRoot: string;
  let project: ProjectState;
  let clusterId: string;

  beforeEach(() => {
    repo = createTempRepo({
      'package.json':
        '{"private":true,"babel":{"presets":["@emotion/babel-preset-css-prop"]}}\n',
      'src/Contextual.jsx':
        'export const Contextual = () => <Button css={{ color: value }} />;\n',
    });
    workspaceRoot = createTempDir('stylex-migrate-context-');
    project = initializeProject({ repositoryRoot: repo });
    const inventory = scanRepository({ repositoryRoot: repo });
    const plan = createPlan({ inventory });
    const cluster = plan.clusters.find(
      (item) => item.classification === 'repeatable-contextual',
    );
    if (cluster == null) {
      throw new Error('Fixture did not produce a contextual cluster');
    }
    clusterId = cluster.id;
    saveInventory(project, inventory);
    savePlan(project, plan);
  });

  afterEach(() => {
    removeTempDir(workspaceRoot);
    removeTempDir(repo);
  });

  test('opens from persisted facts and submits immutable candidate bytes', () => {
    writeFiles(repo, { 'notes.txt': 'unrelated dirty file\n' });
    const opened = openContextTask({
      project,
      clusterId,
      goal: 'Convert the component while preserving its public contract.',
      workspaceRoot,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      throw new Error(opened.reasons.join('\n'));
    }
    expect(opened.task.declaredInputs.map((input) => input.path)).toContain(
      'package.json',
    );
    expect(opened.task.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'emotion-jsx-activation',
          status: 'known',
          value: expect.objectContaining({ source: 'project-config' }),
        }),
      ]),
    );
    expect(opened.attempt.workspace.path.startsWith(workspaceRoot)).toBe(true);

    const converted = `import * as stylex from '@stylexjs/stylex';
const styles = stylex.create({root: {color: 'red'}});
export const Contextual = () => <Button {...stylex.props(styles.root)} />;
`;
    writeFiles(opened.attempt.workspace.path, {
      'src/Contextual.jsx': converted,
    });
    const submitted = submitContextAttempt({
      project,
      taskId: opened.task.id,
      proposerKind: 'agent',
      proposerName: 'fixture-agent',
      proposerVersion: 'fixture-v1',
      skillVersion: 'stylex-migrate-context-v1',
    });
    expect(submitted).toMatchObject({
      ok: true,
      state: 'awaiting-verification',
    });
    expect(fs.existsSync(opened.attempt.workspace.path)).toBe(false);
    expect(readFile(repo, 'src/Contextual.jsx')).toContain(
      'css={{ color: value }}',
    );
    expect(readFile(repo, 'notes.txt')).toBe('unrelated dirty file\n');
    expect(inspectContextTask(project, opened.task.id)).toMatchObject({
      state: 'awaiting-verification',
      stateData: { candidateId: submitted.ok ? submitted.candidateId : null },
    });
  });

  test('counts patch scope violations against the two-attempt budget', () => {
    const first = openContextTask({
      project,
      clusterId,
      goal: 'Convert only the planned component.',
      workspaceRoot,
    });
    if (!first.ok) {
      throw new Error(first.reasons.join('\n'));
    }
    writeFiles(first.attempt.workspace.path, {
      'package.json': '{"private":false}\n',
    });
    const firstFailure = submitContextAttempt({
      project,
      taskId: first.task.id,
      proposerKind: 'agent',
      proposerVersion: 'fixture-v1',
    });
    expect(firstFailure).toMatchObject({
      ok: false,
      state: 'needs-replan',
      reasons: expect.arrayContaining([
        expect.stringContaining('forbidden-path'),
      ]),
    });

    const second = openContextRetry({
      project,
      taskId: first.task.id,
      workspaceRoot,
    });
    if (!second.ok) {
      throw new Error(second.reasons.join('\n'));
    }
    expect(second.attempt.attemptNumber).toBe(2);
    expect(second.attempt.priorFailures).toHaveLength(1);
    writeFiles(second.attempt.workspace.path, {
      'package.json': '{"private":false}\n',
    });
    expect(
      submitContextAttempt({
        project,
        taskId: first.task.id,
        proposerKind: 'human',
        proposerVersion: 'fixture-v1',
      }),
    ).toMatchObject({ ok: false, state: 'blocked' });
    expect(
      openContextRetry({
        project,
        taskId: first.task.id,
        workspaceRoot,
      }),
    ).toMatchObject({ ok: false, state: 'blocked' });
  });

  test('moves a passing contextual verdict to review eligibility', async () => {
    writeConfig(project, {
      sourceGlobs: ['src/**/*.jsx'],
      evidence: {
        concurrency: 1,
        outputPreviewBytes: 1024,
        providers: [
          {
            id: 'fixture-test',
            kind: 'command',
            check: 'focused-test',
            checkVersion: 'fixture-v1',
            subject: 'candidate',
            cost: 'cheap',
            argv: [process.execPath, '-e', 'process.exit(0)'],
            versionArgv: [
              process.execPath,
              '-e',
              "process.stdout.write('fixture-v1')",
            ],
            cwd: '.',
            allowedEnv: ['PATH'],
            fileGlobs: ['src/**'],
            limitations: ['fixture check only'],
            timeoutMs: 5000,
          },
        ],
      },
    });
    const opened = openContextTask({
      project,
      clusterId,
      goal: 'Produce a candidate that repository checks can review.',
      workspaceRoot,
    });
    if (!opened.ok) {
      throw new Error(opened.reasons.join('\n'));
    }
    writeFiles(opened.attempt.workspace.path, {
      'src/Contextual.jsx': 'export const Contextual = () => <Button />;\n',
    });
    const submitted = submitContextAttempt({
      project,
      taskId: opened.task.id,
      proposerKind: 'agent',
      proposerVersion: 'fixture-v1',
    });
    if (!submitted.ok) {
      throw new Error(submitted.reasons.join('\n'));
    }
    const verified = await verifyPersistedCandidates({
      project,
      candidateIds: [submitted.candidateId],
      workspaceRoot,
    });
    expect(verified.verdict.outcome).toBe('eligible-for-review');
    expect(inspectContextTask(project, opened.task.id)).toMatchObject({
      state: 'eligible-for-review',
      stateData: { verdictId: verified.verdict.id },
    });
    const repeated = await verifyPersistedCandidates({
      project,
      candidateIds: [submitted.candidateId],
      workspaceRoot,
    });
    expect(repeated.verdict.id).toBe(verified.verdict.id);
    expect(inspectContextTask(project, opened.task.id).state).toBe(
      'eligible-for-review',
    );
  });

  test('reports missing evidence as an owner decision, not a pass', async () => {
    const opened = openContextTask({
      project,
      clusterId,
      goal: 'Demonstrate an evidence gap.',
      workspaceRoot,
    });
    if (!opened.ok) {
      throw new Error(opened.reasons.join('\n'));
    }
    writeFiles(opened.attempt.workspace.path, {
      'src/Contextual.jsx': 'export const Contextual = () => <Button />;\n',
    });
    const submitted = submitContextAttempt({
      project,
      taskId: opened.task.id,
      proposerKind: 'human',
      proposerVersion: 'fixture-v1',
    });
    if (!submitted.ok) {
      throw new Error(submitted.reasons.join('\n'));
    }
    const verified = await verifyPersistedCandidates({
      project,
      candidateIds: [submitted.candidateId],
      workspaceRoot,
    });
    expect(verified.verdict.outcome).toBe('blocked');
    expect(inspectContextTask(project, opened.task.id).state).toBe(
      'needs-owner-decision',
    );
  });

  test('abandon removes the external workspace and records a terminal state', () => {
    const opened = openContextTask({
      project,
      clusterId,
      goal: 'Open then stop.',
      workspaceRoot,
    });
    if (!opened.ok) {
      throw new Error(opened.reasons.join('\n'));
    }
    const workspace = opened.attempt.workspace.path;
    expect(abandonContextTask({ project, taskId: opened.task.id }).state).toBe(
      'abandoned',
    );
    expect(fs.existsSync(workspace)).toBe(false);
  });

  test('blocks a dirty declared input but allows unrelated dirt', () => {
    fs.writeFileSync(
      path.join(repo, 'src/Contextual.jsx'),
      'export const changed = true;\n',
      'utf8',
    );
    expect(
      openContextTask({
        project,
        clusterId,
        goal: 'Do not absorb local edits.',
        workspaceRoot,
      }),
    ).toMatchObject({
      ok: false,
      state: 'blocked',
      reasons: expect.arrayContaining([
        expect.stringContaining('differs from HEAD'),
      ]),
    });
  });

  test('opens dynamic styled clusters with strategy-specific facts and stops', () => {
    const dynamicRepo = createTempRepo({
      'package.json': '{}\n',
      'tsconfig.json': '{}\n',
      'src/Meter.tsx': `import styled from '@emotion/styled';
const MeterRoot = styled.div<{active: boolean; width: number}>\`
  color: \${p => (p.active ? 'red' : 'blue')};
  width: \${p => p.width}px;
\`;
export function Meter({active, width}: {active: boolean; width: number}) {
  return <MeterRoot active={active} width={width} />;
}
`,
      'src/Unrelated.tsx': `export function Unrelated() {
  return <div />;
}
`,
    });
    const dynamicWorkspaceRoot = createTempDir(
      'stylex-migrate-dynamic-context-',
    );
    try {
      const dynamicProject = initializeProject({
        repositoryRoot: dynamicRepo,
      });
      const inventory = scanRepository({ repositoryRoot: dynamicRepo });
      const dynamicPlan = createPlan({ inventory });
      const dynamicSite = inventory.sites.find(
        (site) => site.kind === 'styled-dynamic-intrinsic',
      );
      const dynamicCluster = dynamicPlan.clusters.find((item) =>
        item.siteIds.includes(dynamicSite?.id ?? ''),
      );
      if (dynamicCluster == null) {
        throw new Error('Fixture did not produce a dynamic styled cluster');
      }
      saveInventory(dynamicProject, inventory);
      savePlan(dynamicProject, dynamicPlan);
      expect(
        openContextTask({
          project: dynamicProject,
          clusterId: dynamicCluster.id,
          goal: 'Do not guess a dynamic strategy.',
          workspaceRoot: dynamicWorkspaceRoot,
        }),
      ).toMatchObject({
        ok: false,
        state: 'blocked',
        reasons: [expect.stringContaining('dynamic strategy draft')],
      });
      const dynamicFact = inventory.facts.find(
        (fact) => fact.kind === 'emotion-styled-dynamic-value',
      );
      if (dynamicFact == null) throw new Error('Missing dynamic value fact');
      const dynamic: $FlowFixMe = dynamicFact.value;
      const propPaths = [
        ...new Set(dynamic.callbacks.flatMap((callback) => callback.propPaths)),
      ];
      const strategy = persistDynamicStrategyDraft({
        project: dynamicProject,
        definition: {
          protocolVersion: 'stylex-migrate-dynamic-strategy-v1',
          inventoryId: inventory.id,
          clusterId: dynamicCluster.id,
          entries: propPaths.map((propPath) => ({
            definitionFactId: dynamic.definitionFactId,
            propPath,
            strategy:
              propPath === 'active' ? 'stylex-variants' : 'css-variable',
            rationale: `Fixture strategy for ${propPath}.`,
            evidenceRequirements: [`Runtime case for ${propPath}.`],
          })),
        },
        authorKind: 'agent',
        authoredBy: 'fixture-agent',
      });
      const opened = openContextTask({
        project: dynamicProject,
        clusterId: dynamicCluster.id,
        goal: 'Choose and implement a bounded runtime-value strategy.',
        workspaceRoot: dynamicWorkspaceRoot,
      });
      if (!opened.ok) throw new Error(opened.reasons.join('\n'));
      expect(opened.task.origin).toEqual({
        kind: 'dynamic-strategy',
        strategyId: strategy.id,
        definitionHash: strategy.definitionHash,
        clusterId: dynamicCluster.id,
      });
      expect(opened.task.decisionArtifactHashes).toEqual([
        strategy.definitionHash,
      ]);
      expect(opened.task.scope.allowedPaths).toEqual(['src/Meter.tsx']);
      expect(opened.task.facts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'emotion-styled-dynamic-value',
            status: 'known',
            value: expect.objectContaining({
              model: 'emotion-styled-dynamic-value-v1',
              name: 'MeterRoot',
            }),
          }),
          expect.objectContaining({
            kind: 'dynamic-strategy-decision',
            status: 'known',
            value: expect.objectContaining({ id: strategy.id }),
          }),
        ]),
      );
      expect(
        opened.task.facts.some((fact) =>
          fact.inputFiles.includes('src/Unrelated.tsx'),
        ),
      ).toBe(false);
      expect(opened.task.limitations.join(' ')).toContain(
        'runtime value domains',
      );
      expect(opened.task.stopConditions.join(' ')).toContain('Do not hoist');
      expect(opened.task.stopConditions.join(' ')).toContain(
        'Retain the Emotion boundary',
      );
      expect(
        abandonContextTask({
          project: dynamicProject,
          taskId: opened.task.id,
        }).state,
      ).toBe('abandoned');
    } finally {
      removeTempDir(dynamicWorkspaceRoot);
      removeTempDir(dynamicRepo);
    }
  });
});

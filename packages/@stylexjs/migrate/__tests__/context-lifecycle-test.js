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
  saveInventory,
  savePlan,
  scanRepository,
  submitContextAttempt,
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
});

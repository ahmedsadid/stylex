/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import fs from 'fs';
import { runCli } from '../src/cli';
import { createTempRepo, removeTempDir, writeFiles } from './utils/tempRepo';

type Result = {
  +code: number,
  +json: $FlowFixMe,
  +stderr: string,
};

function command(repo: string, args: $ReadOnlyArray<string>): Result {
  let stdout = '';
  let stderr = '';
  const code = runCli([...args, '--json'], {
    cwd: repo,
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  return {
    code,
    json: stdout === '' ? null : JSON.parse(stdout),
    stderr,
  };
}

describe('M7 contextual protocol CLI', () => {
  let repo: string;

  beforeEach(() => {
    repo = createTempRepo({
      'package.json':
        '{"private":true,"babel":{"presets":["@emotion/babel-preset-css-prop"]}}\n',
      'src/Contextual.jsx':
        'export const Contextual = () => <Button css={{ color: value }} />;\n',
    });
    expect(command(repo, ['init']).code).toBe(0);
    expect(command(repo, ['scan']).code).toBe(0);
    expect(command(repo, ['plan']).code).toBe(0);
  });

  afterEach(() => {
    removeTempDir(repo);
  });

  test('open, inspect and submit survive process-style project reopen', () => {
    const plan = command(repo, ['status']);
    const explained = command(repo, ['explain', plan.json.plan.id]);
    const contextual = explained.json.detail.clusters.find(
      (cluster) => cluster.classification === 'repeatable-contextual',
    );

    const opened = command(repo, [
      'context',
      'open',
      contextual.id,
      'Convert the planned component.',
    ]);
    expect(opened).toMatchObject({
      code: 0,
      json: {
        command: 'context open',
        state: 'open',
        taskId: expect.stringMatching(/^task-/),
      },
    });
    const taskId = opened.json.taskId;
    const workspace = opened.json.workspace;
    expect(command(repo, ['context', 'inspect', taskId])).toMatchObject({
      code: 0,
      json: { state: 'open', task: { id: taskId } },
    });

    writeFiles(workspace, {
      'src/Contextual.jsx': 'export const Contextual = () => <Button />;\n',
    });
    const submitted = command(repo, [
      'context',
      'submit',
      taskId,
      'agent',
      'fixture-agent',
      'fixture-v1',
      'stylex-migrate-context-v1',
    ]);
    expect(submitted).toMatchObject({
      code: 0,
      json: {
        state: 'awaiting-verification',
        candidateId: expect.stringMatching(/^[a-f0-9]{16}$/),
      },
    });
    expect(fs.existsSync(workspace)).toBe(false);
    expect(command(repo, ['context', 'inspect', taskId])).toMatchObject({
      code: 0,
      json: { state: 'awaiting-verification' },
    });
  });

  test('abandon is exposed through the same restart-safe state', () => {
    const current: $FlowFixMe = command(repo, ['status']).json;
    const plan = command(repo, ['explain', current.plan.id]).json.detail;
    const cluster = plan.clusters.find(
      (item) => item.classification === 'repeatable-contextual',
    );
    const opened = command(repo, [
      'context',
      'open',
      cluster.id,
      'Open and then abandon this task.',
    ]);
    const abandoned = command(repo, ['context', 'abandon', opened.json.taskId]);
    expect(abandoned).toMatchObject({
      code: 0,
      json: { state: 'abandoned' },
    });
    expect(fs.existsSync(opened.json.workspace)).toBe(false);
  });
});

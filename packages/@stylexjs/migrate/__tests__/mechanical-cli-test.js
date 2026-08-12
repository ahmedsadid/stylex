/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { runCli } from '../src/cli';
import {
  loadCurrentPlan,
  loadVerificationCandidate,
  openProject,
} from '../src/index';
import { createTempRepo, readFile, removeTempDir } from './utils/tempRepo';

type Result = {
  +code: number,
  +stdout: string,
  +stderr: string,
  +json: $FlowFixMe,
};

function run(
  repo: string,
  args: $ReadOnlyArray<string>,
  json: boolean = true,
): Result {
  let stdout = '';
  let stderr = '';
  const code = runCli(json ? [...args, '--json'] : args, {
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
    stdout,
    stderr,
    json: json && stdout !== '' ? JSON.parse(stdout) : null,
  };
}

describe('mechanical CLI', () => {
  let repo: string;

  beforeEach(() => {
    repo = createTempRepo({
      'src/Button.jsx': `/** @jsxImportSource @emotion/react */
export const Button = () => <button css={{ color: 'red' }} />;
`,
    });
  });

  afterEach(() => {
    removeTempDir(repo);
  });

  test('proposes a planned cluster and exports the exact frozen patch', () => {
    expect(run(repo, ['init']).code).toBe(0);
    expect(run(repo, ['scan']).code).toBe(0);
    expect(run(repo, ['plan']).code).toBe(0);
    const project = openProject(repo);
    const cluster = loadCurrentPlan(project)?.clusters[0];
    if (cluster == null) throw new Error('No planned cluster');
    const source = readFile(repo, 'src/Button.jsx');

    const proposed = run(repo, ['mechanical', 'propose', cluster.id]);

    expect(proposed.code).toBe(0);
    expect(proposed.json).toMatchObject({
      command: 'mechanical propose',
      state: 'frozen',
      clusterId: cluster.id,
      changedFiles: ['src/Button.jsx'],
      candidateId: expect.any(String),
      models: expect.any(Array),
      limitations: expect.arrayContaining([
        'no runtime evidence: nothing was rendered',
      ]),
    });
    expect(readFile(repo, 'src/Button.jsx')).toBe(source);

    const record = loadVerificationCandidate(
      project,
      proposed.json.candidateId,
    );
    if (record == null) throw new Error('No frozen candidate');
    const plain = run(repo, ['candidate', 'diff', record.candidate.id], false);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe(record.candidate.patchText);
    expect(plain.stdout).toContain('stylex.create');

    const machine = run(repo, ['candidate', 'diff', record.candidate.id]);
    expect(machine.code).toBe(0);
    expect(machine.json).toEqual({
      command: 'candidate diff',
      candidateId: record.candidate.id,
      patchHash: record.candidate.patchHash,
      files: ['src/Button.jsx'],
      patchText: record.candidate.patchText,
    });
  });

  test('uses distinct refusal and missing-candidate exits', () => {
    expect(run(repo, ['init']).code).toBe(0);
    expect(run(repo, ['scan']).code).toBe(0);
    expect(run(repo, ['plan']).code).toBe(0);
    const missing = run(repo, ['candidate', 'diff', '0000000000000000']);
    expect(missing).toMatchObject({
      code: 2,
      json: {
        error: 'No persisted candidate found for 0000000000000000',
        id: '0000000000000000',
      },
    });
    const refused = run(repo, ['mechanical', 'propose', '0000000000000000']);
    expect(refused.code).toBe(1);
    expect(refused.json.error).toContain('No current cluster found');
  });
});

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
  createPlan,
  initializeProject,
  loadCurrentPlan,
  loadVerificationCandidate,
  openProject,
  proposeStyledCandidate,
  saveInventory,
  savePlan,
  scanRepository,
} from '../src/index';
import {
  createTempDir,
  createTempRepo,
  readFile,
  removeTempDir,
  writeFiles,
} from './utils/tempRepo';

const SOURCE = `import styled from '@emotion/styled';
export function Example() { return <Pre>text</Pre>; }
const Pre = styled.pre\`margin: 0; overflow: auto;\`;
`;

function run(repo: string, args: $ReadOnlyArray<string>): $FlowFixMe {
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
    stderr,
    json: stdout === '' ? null : JSON.parse(stdout),
  };
}

describe('styled candidate lifecycle', () => {
  let repo: string;
  let workspaceRoot: string;

  afterEach(() => {
    removeTempDir(repo);
    removeTempDir(workspaceRoot);
  });

  function prepare() {
    repo = createTempRepo({ 'src/example.tsx': SOURCE });
    workspaceRoot = createTempDir('stylex-migrate-styled-ws-');
    const project = initializeProject({ repositoryRoot: repo });
    const inventory = scanRepository({ repositoryRoot: repo });
    saveInventory(project, inventory);
    const plan = createPlan({ inventory });
    savePlan(project, plan);
    const cluster = plan.clusters[0];
    if (cluster == null) throw new Error('missing styled cluster');
    return { project, inventory, plan, cluster };
  }

  test('freezes checked bytes without touching the source checkout', () => {
    const { project, cluster } = prepare();
    expect(cluster).toMatchObject({
      classification: 'repeatable-contextual',
      state: 'planned',
    });

    const result = proposeStyledCandidate({
      project,
      clusterId: cluster.id,
      workspaceRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.record).toMatchObject({
      classification: 'repeatable-contextual',
      candidate: {
        clusterIds: [cluster.id],
        proposer: {
          kind: 'deterministic',
          version: 'emotion-styled-flat-v1',
        },
      },
    });
    expect(result.record.siteIdsByFile['src/example.tsx']).toEqual(
      cluster.siteIds,
    );
    expect(result.record.staticEvidence.map((item) => item.result)).toEqual([
      'pass',
      'pass',
      'pass',
      'pass',
    ]);
    expect(result.record.candidate.patchText).toContain(
      '<pre {...stylex.props(styles.pre)}>',
    );
    expect(readFile(repo, 'src/example.tsx')).toBe(SOURCE);
    expect(
      loadVerificationCandidate(project, result.record.candidate.id),
    ).toEqual(result.record);
  });

  test('refuses stale planned input bytes', () => {
    const { project, cluster } = prepare();
    writeFiles(repo, {
      'src/example.tsx': SOURCE.replace('overflow: auto', 'overflow: clip'),
    });
    expect(() =>
      proposeStyledCandidate({
        project,
        clusterId: cluster.id,
        workspaceRoot,
      }),
    ).toThrow('Styled candidate inputs differ from HEAD: src/example.tsx');
  });

  test('ships the read-only CLI proposal and candidate diff workflow', () => {
    repo = createTempRepo({ 'src/example.tsx': SOURCE });
    workspaceRoot = createTempDir('stylex-migrate-styled-unused-');
    expect(run(repo, ['init']).code).toBe(0);
    expect(run(repo, ['scan']).code).toBe(0);
    expect(run(repo, ['plan']).code).toBe(0);
    const project = openProject(repo);
    const cluster = loadCurrentPlan(project)?.clusters[0];
    if (cluster == null) throw new Error('missing styled cluster');

    const proposed = run(repo, ['styled', 'propose', cluster.id]);

    expect(proposed).toMatchObject({
      code: 0,
      json: {
        command: 'styled propose',
        state: 'frozen',
        clusterId: cluster.id,
        candidateId: expect.any(String),
        model: 'emotion-styled-flat-intrinsic-v1',
        limitations: expect.arrayContaining([
          expect.stringContaining('repository build'),
        ]),
      },
    });
    expect(readFile(repo, 'src/example.tsx')).toBe(SOURCE);
    const diff = run(repo, ['candidate', 'diff', proposed.json.candidateId]);
    expect(diff.code).toBe(0);
    expect(diff.json.patchText).toContain('stylex.create');
  });
});

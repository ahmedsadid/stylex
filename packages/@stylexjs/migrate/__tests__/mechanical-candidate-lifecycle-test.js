/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { execFileSync } from 'child_process';
import {
  createPlan,
  initializeProject,
  loadVerificationCandidate,
  proposeMechanicalCandidate,
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

function status(repo: string): string {
  return String(
    execFileSync('git', ['status', '--porcelain'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe',
    }),
  );
}

describe('mechanical candidate lifecycle', () => {
  let repo: string;
  let workspaceRoot: string;

  afterEach(() => {
    removeTempDir(repo);
    removeTempDir(workspaceRoot);
  });

  function prepare(source: string) {
    repo = createTempRepo({ 'src/Button.jsx': source });
    workspaceRoot = createTempDir('stylex-migrate-mechanical-ws-');
    const project = initializeProject({ repositoryRoot: repo });
    const inventory = scanRepository({ repositoryRoot: repo });
    saveInventory(project, inventory);
    const plan = createPlan({ inventory });
    savePlan(project, plan);
    return { project, inventory, plan };
  }

  test('freezes exact checked bytes without touching the source checkout', () => {
    const source = `/** @jsxImportSource @emotion/react */
export const Button = () => <button css={{ color: 'red' }} />;
`;
    const { project, plan } = prepare(source);
    const cluster = plan.clusters[0];
    writeFiles(repo, { 'notes/unrelated.txt': 'developer work\n' });

    const result = proposeMechanicalCandidate({
      project,
      clusterId: cluster.id,
      workspaceRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.record.classification).toBe('mechanical');
    expect(result.record.candidate.clusterIds).toEqual([cluster.id]);
    expect(result.record.candidate.proposer).toEqual({
      kind: 'deterministic',
      version: 'emotion-static-v1',
    });
    expect(result.record.siteIdsByFile['src/Button.jsx']).toEqual(
      cluster.siteIds,
    );
    expect(result.record.staticEvidence.length).toBeGreaterThan(0);
    expect(
      result.record.staticEvidence.every((entry) => entry.result === 'pass'),
    ).toBe(true);
    expect(result.record.candidate.patchText).toContain(
      "import * as stylex from '@stylexjs/stylex'",
    );
    expect(readFile(repo, 'src/Button.jsx')).toBe(source);
    expect(readFile(repo, 'notes/unrelated.txt')).toBe('developer work\n');
    expect(status(repo)).toBe('?? notes/\n');
    expect(
      loadVerificationCandidate(project, result.record.candidate.id),
    ).toEqual(result.record);
  });

  test('refuses a contextual cluster instead of bypassing its route', () => {
    const { project, plan } = prepare(`/** @jsxImportSource @emotion/react */
const color = 'red';
export const Button = () => <button css={{ color }} />;
`);
    const cluster = plan.clusters[0];
    expect(cluster.classification).not.toBe('mechanical');

    const result = proposeMechanicalCandidate({
      project,
      clusterId: cluster.id,
      workspaceRoot,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining(
        'use the contextual or decision workflow',
      ),
      file: null,
    });
  });

  test('refuses a declared input that differs from the planned commit', () => {
    const source = `/** @jsxImportSource @emotion/react */
export const Button = () => <button css={{ color: 'red' }} />;
`;
    const { project, plan } = prepare(source);
    writeFiles(repo, {
      'src/Button.jsx': source.replace("'red'", "'blue'"),
    });

    expect(() =>
      proposeMechanicalCandidate({
        project,
        clusterId: plan.clusters[0].id,
        workspaceRoot,
      }),
    ).toThrow('Mechanical candidate inputs differ from HEAD: src/Button.jsx');
  });

  test('uses a known project activation fact and binds its config input', () => {
    const source = `export const Button = () => <button css={{ color: 'red' }} />;
`;
    repo = createTempRepo({
      'src/Button.jsx': source,
      'tsconfig.json': JSON.stringify({
        compilerOptions: { jsxImportSource: '@emotion/react' },
      }),
    });
    workspaceRoot = createTempDir('stylex-migrate-mechanical-ws-');
    const project = initializeProject({ repositoryRoot: repo });
    const inventory = scanRepository({ repositoryRoot: repo });
    saveInventory(project, inventory);
    const plan = createPlan({ inventory });
    savePlan(project, plan);
    const cluster = plan.clusters[0];
    expect(cluster.classification).toBe('mechanical');

    const result = proposeMechanicalCandidate({
      project,
      clusterId: cluster.id,
      workspaceRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.record.snapshot.fileHashes['tsconfig.json']).toEqual(
      expect.any(String),
    );
    expect(result.record.staticEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'emotion-jsx-activation',
          result: 'pass',
          scope: ['src/Button.jsx', 'tsconfig.json'],
        }),
      ]),
    );
    expect(result.record.candidate.patchText).toContain('stylex.create');
    expect(readFile(repo, 'src/Button.jsx')).toBe(source);
  });

  test('makes a project activation configuration edit stale', () => {
    repo = createTempRepo({
      'src/Button.jsx':
        "export const Button = () => <button css={{ color: 'red' }} />;\n",
      'tsconfig.json': JSON.stringify({
        compilerOptions: { jsxImportSource: '@emotion/react' },
      }),
    });
    workspaceRoot = createTempDir('stylex-migrate-mechanical-ws-');
    const project = initializeProject({ repositoryRoot: repo });
    const inventory = scanRepository({ repositoryRoot: repo });
    saveInventory(project, inventory);
    const plan = createPlan({ inventory });
    savePlan(project, plan);
    writeFiles(repo, {
      'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
    });

    expect(() =>
      proposeMechanicalCandidate({
        project,
        clusterId: plan.clusters[0].id,
        workspaceRoot,
      }),
    ).toThrow('Mechanical candidate inputs differ from HEAD: tsconfig.json');
  });
});

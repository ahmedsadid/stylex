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
import { execFileSync } from 'child_process';
import { runCli } from '../src/cli';
import {
  loadCurrentInventory,
  loadCurrentPlan,
  openProject,
} from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

type Result = {
  +code: number,
  +stdout: string,
  +stderr: string,
  +json: $FlowFixMe,
};

function git(repo: string, args: $ReadOnlyArray<string>): string {
  return String(
    execFileSync('git', [...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe',
    }),
  ).trim();
}

function run(repo: string, args: $ReadOnlyArray<string>): Result {
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
    stdout,
    stderr,
    json: stdout === '' ? null : JSON.parse(stdout),
  };
}

describe('M4 inventory and planning CLI', () => {
  let repo: string;

  beforeEach(() => {
    repo = createTempRepo({
      'src/App.jsx': `/** @jsxImportSource @emotion/react */
import {missing} from './missing';
export const App = () => <div css={{ color: 'red' }}>{missing}</div>;
`,
      'src/Simple.jsx': `/** @jsxImportSource @emotion/react */
export const Simple = () => <div css={{ color: 'blue' }} />;
`,
      'src/Context.jsx': `/** @jsxImportSource @emotion/react */
export const Context = () => <Button css={{ color: value }} />;
`,
      'src/Broken.jsx': 'export const = ;\n',
    });
  });

  afterEach(() => {
    removeTempDir(repo);
  });

  test('scan, plan, status, and explain use durable reports', () => {
    const head = git(repo, ['rev-parse', 'HEAD']);
    expect(run(repo, ['init']).code).toBe(0);

    const scan = run(repo, ['scan']);
    expect(scan.code).toBe(0);
    expect(scan.json).toMatchObject({
      command: 'scan',
      counts: {
        files: { scanned: 3, 'parse-failed': 1, 'read-failed': 0 },
        sites: {
          mechanical: 1,
          'repeatable-contextual': 1,
          'bespoke-contextual': 0,
          'owner-decision': 1,
        },
        diagnostics: 1,
      },
    });

    const planned = run(repo, ['plan']);
    expect(planned.code).toBe(0);
    expect(planned.json).toMatchObject({
      command: 'plan',
      clusters: 3,
      conflicts: 0,
      stale: false,
      counts: {
        classification: {
          mechanical: 1,
          'repeatable-contextual': 1,
          'bespoke-contextual': 0,
          'owner-decision': 1,
        },
        state: { planned: 2, blocked: 1 },
      },
    });

    const reopened = openProject(repo);
    const inventory = loadCurrentInventory(reopened);
    const plan = loadCurrentPlan(reopened);
    const blockedSite = inventory?.sites.find(
      (site) => site.file === 'src/App.jsx',
    );
    const blockedCluster = plan?.clusters.find((cluster) =>
      cluster.siteIds.includes(blockedSite?.id ?? ''),
    );

    const siteExplanation = run(repo, ['explain', blockedSite?.id ?? '']);
    expect(siteExplanation.code).toBe(0);
    expect(siteExplanation.json).toMatchObject({
      kind: 'site',
      detail: {
        site: {
          classification: 'owner-decision',
          routingReasons: [
            'one or more local dependencies could not be resolved',
          ],
        },
      },
    });
    const clusterExplanation = run(repo, ['explain', blockedCluster?.id ?? '']);
    expect(clusterExplanation.code).toBe(0);
    expect(clusterExplanation.json).toMatchObject({
      kind: 'cluster',
      detail: { cluster: { state: 'blocked' } },
    });
    expect(run(repo, ['explain', plan?.id ?? '']).json.kind).toBe('plan');

    const status = run(repo, ['status']);
    expect(status.code).toBe(0);
    expect(status.json).toMatchObject({
      command: 'status',
      inventory: { id: inventory?.id },
      plan: { id: plan?.id, stale: false },
    });
    expect(JSON.stringify(status.json)).not.toContain('percentage');
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(head);
  });

  test('a new scan makes an older current plan visibly stale', () => {
    expect(run(repo, ['init']).code).toBe(0);
    expect(run(repo, ['scan']).code).toBe(0);
    expect(run(repo, ['plan']).code).toBe(0);
    fs.writeFileSync(
      path.join(repo, 'src/Simple.jsx'),
      `/** @jsxImportSource @emotion/react */
export const Simple = () => <div css={{ color: 'green' }} />;
`,
      'utf8',
    );
    expect(run(repo, ['scan']).code).toBe(0);
    expect(run(repo, ['status']).json.plan.stale).toBe(true);
  });

  test('plan requires a scan and explain has a distinct not-found exit', () => {
    expect(run(repo, ['init']).code).toBe(0);
    const plan = run(repo, ['plan']);
    expect(plan.code).toBe(1);
    expect(plan.json.error).toContain('stylex-migrate scan');

    const missing = run(repo, ['explain', '0000000000000000']);
    expect(missing.code).toBe(2);
    expect(missing.json).toEqual({
      error: 'No migration entity found for 0000000000000000',
      id: '0000000000000000',
    });
  });
});

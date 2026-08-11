/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  initializeProject,
  loadVerificationCandidate,
  openBootstrapTask,
  saveInventory,
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

describe('StyleX repository bootstrap tasks', () => {
  let repo: string;
  let workspaceRoot: string;
  let project: ProjectState;
  let originalManifest: string;
  let originalConfig: string;

  beforeEach(() => {
    originalManifest = `${JSON.stringify(
      {
        name: 'rspack-app',
        private: true,
        packageManager: 'pnpm@10.30.2',
        scripts: { build: 'rspack --config rspack.config.ts' },
        devDependencies: { '@rspack/core': '^1.0.0' },
      },
      null,
      2,
    )}\n`;
    originalConfig = `import {rspack} from '@rspack/core';
export default {plugins: [new rspack.DefinePlugin({})]};
`;
    repo = createTempRepo({
      'package.json': originalManifest,
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'rspack.config.ts': originalConfig,
      'src/App.tsx': 'export const App = () => null;\n',
    });
    workspaceRoot = createTempDir('stylex-migrate-bootstrap-task-');
    project = initializeProject({ repositoryRoot: repo });
    saveInventory(project, scanRepository({ repositoryRoot: repo }));
  });

  afterEach(() => {
    removeTempDir(workspaceRoot);
    removeTempDir(repo);
  });

  test('freezes a bounded Rspack wiring candidate without editing source', () => {
    const opened = openBootstrapTask({
      project,
      goal: 'Install StyleX and connect its Rspack adapter.',
      workspaceRoot,
    });
    if (!opened.ok) throw new Error(opened.reasons.join('\n'));
    expect(opened.task).toMatchObject({
      origin: {
        kind: 'bootstrap',
        packageRoot: '',
        packageManager: 'pnpm',
        integration: 'rspack',
      },
      scope: {
        allowedPaths: ['package.json', 'pnpm-lock.yaml', 'rspack.config.ts'],
        bootstrapPaths: ['package.json', 'pnpm-lock.yaml', 'rspack.config.ts'],
      },
    });

    const manifest = JSON.parse(originalManifest);
    manifest.dependencies = { '@stylexjs/stylex': '^0.19.0' };
    manifest.devDependencies['@stylexjs/unplugin'] = '^0.19.0';
    writeFiles(opened.attempt.workspace.path, {
      'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
      'pnpm-lock.yaml': 'lockfileVersion: 9\n# StyleX packages resolved\n',
      'rspack.config.ts': `import {rspack} from '@rspack/core';
import stylexPlugin from '@stylexjs/unplugin';
export default {
  plugins: [stylexPlugin.rspack(), new rspack.DefinePlugin({})],
};
`,
    });

    const submitted = submitContextAttempt({
      project,
      taskId: opened.task.id,
      proposerKind: 'agent',
      proposerVersion: 'fixture-v1',
    });
    if (!submitted.ok) throw new Error(submitted.reasons.join('\n'));
    expect(
      loadVerificationCandidate(project, submitted.candidateId),
    ).toMatchObject({
      classification: 'repeatable-contextual',
      staticEvidence: [
        {
          check: 'stylex-bootstrap-wiring',
          result: 'pass',
          subject: { model: 'stylex-bootstrap-wiring-v1' },
        },
      ],
    });
    expect(readFile(repo, 'package.json')).toBe(originalManifest);
    expect(readFile(repo, 'rspack.config.ts')).toBe(originalConfig);
  });

  test('rejects dependencies without an active Rspack adapter', () => {
    const opened = openBootstrapTask({
      project,
      goal: 'Attempt incomplete StyleX wiring.',
      workspaceRoot,
    });
    if (!opened.ok) throw new Error(opened.reasons.join('\n'));
    const manifest = JSON.parse(originalManifest);
    manifest.dependencies = {
      '@stylexjs/stylex': '^0.19.0',
      '@stylexjs/unplugin': '^0.19.0',
    };
    writeFiles(opened.attempt.workspace.path, {
      'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
      'pnpm-lock.yaml': 'lockfileVersion: 9\n# StyleX packages resolved\n',
      'rspack.config.ts': `import stylexPlugin from '@stylexjs/unplugin';
export default {plugins: []};
`,
    });

    expect(
      submitContextAttempt({
        project,
        taskId: opened.task.id,
        proposerKind: 'agent',
        proposerVersion: 'fixture-v1',
      }),
    ).toMatchObject({
      ok: false,
      state: 'needs-replan',
      reasons: [expect.stringContaining('invokes its rspack adapter')],
    });
  });
});

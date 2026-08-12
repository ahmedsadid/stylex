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
  readConfig,
  saveInventory,
  scanRepository,
  submitContextAttempt,
} from '../src/index';
import { withBootstrapEvidenceProviders } from '../src/bootstrap/evidence';
import { runCli } from '../src/cli';
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
      'packages/tool/package.json': '{"name":"nested-tool"}\n',
      'packages/tool/src/index.ts': 'export const tool = true;\n',
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
        dependencies: [
          {
            name: '@stylexjs/stylex',
            section: 'dependencies',
            spec: '0.19.0',
          },
          {
            name: '@stylexjs/unplugin',
            section: 'devDependencies',
            spec: '0.19.0',
          },
          {
            name: 'unplugin',
            section: 'devDependencies',
            spec: '^2.3.11',
          },
        ],
        installCommands: [
          [
            'corepack',
            'pnpm',
            '-w',
            'add',
            '--save-exact',
            '@stylexjs/stylex@0.19.0',
          ],
          [
            'corepack',
            'pnpm',
            '-w',
            'add',
            '--save-exact',
            '--save-dev',
            '@stylexjs/unplugin@0.19.0',
            'unplugin@^2.3.11',
          ],
        ],
        buildCommand: ['corepack', 'pnpm', 'run', 'build'],
      },
      scope: {
        allowedPaths: ['package.json', 'pnpm-lock.yaml', 'rspack.config.ts'],
        bootstrapPaths: ['package.json', 'pnpm-lock.yaml', 'rspack.config.ts'],
      },
      requiredChecks: [
        expect.objectContaining({
          id: expect.stringContaining('stylex-bootstrap-rspack-'),
          checkVersion: 'stylex-rspack-emitted-css-v2',
        }),
      ],
    });

    const manifest = JSON.parse(originalManifest);
    manifest.dependencies = { '@stylexjs/stylex': '0.19.0' };
    manifest.devDependencies['@stylexjs/unplugin'] = '0.19.0';
    manifest.devDependencies.unplugin = '^2.3.11';
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
    const candidate = loadVerificationCandidate(project, submitted.candidateId);
    expect(candidate).toMatchObject({
      classification: 'repeatable-contextual',
      staticEvidence: [
        {
          check: 'stylex-bootstrap-wiring',
          result: 'pass',
          subject: { model: 'stylex-bootstrap-wiring-v2' },
        },
      ],
    });
    if (candidate == null) throw new Error('candidate was not persisted');
    expect(
      withBootstrapEvidenceProviders({
        project,
        candidates: [candidate],
        subject: 'candidate',
        config: readConfig(project).evidence,
      }).providers,
    ).toEqual([
      expect.objectContaining({
        kind: 'bootstrap-rspack',
        packageManager: 'pnpm',
        fileGlobs: ['package.json', 'pnpm-lock.yaml', 'rspack.config.ts'],
      }),
    ]);
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
      '@stylexjs/stylex': '0.19.0',
      '@stylexjs/unplugin': '0.19.0',
      unplugin: '^2.3.11',
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
      reasons: expect.arrayContaining([
        expect.stringContaining('invokes its rspack adapter'),
      ]),
    });
  });

  test('rejects a dependency source that differs from task intent', () => {
    const opened = openBootstrapTask({
      project,
      goal: 'Attempt to substitute a dependency source.',
      workspaceRoot,
    });
    if (!opened.ok) throw new Error(opened.reasons.join('\n'));
    const manifest = JSON.parse(originalManifest);
    manifest.dependencies = {
      '@stylexjs/stylex': 'file:/unreviewed/local/stylex',
    };
    manifest.devDependencies['@stylexjs/unplugin'] = '0.19.0';
    manifest.devDependencies.unplugin = '^2.3.11';
    writeFiles(opened.attempt.workspace.path, {
      'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
      'pnpm-lock.yaml': 'lockfileVersion: 9\n# StyleX packages resolved\n',
      'rspack.config.ts': `import stylexPlugin from '@stylexjs/unplugin';
export default {plugins: [stylexPlugin.rspack()]};
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
      reasons: expect.arrayContaining([
        expect.stringContaining('@stylexjs/stylex must be "0.19.0"'),
      ]),
    });
  });

  test('rejects unrelated manifest and Rspack configuration edits', () => {
    const opened = openBootstrapTask({
      project,
      goal: 'Attempt to widen a bootstrap patch.',
      workspaceRoot,
    });
    if (!opened.ok) throw new Error(opened.reasons.join('\n'));
    const manifest = JSON.parse(originalManifest);
    manifest.scripts.unrelated = 'node unexpected.js';
    manifest.dependencies = { '@stylexjs/stylex': '0.19.0' };
    manifest.devDependencies['@stylexjs/unplugin'] = '0.19.0';
    manifest.devDependencies.unplugin = '^2.3.11';
    writeFiles(opened.attempt.workspace.path, {
      'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
      'pnpm-lock.yaml': 'lockfileVersion: 9\n# StyleX packages resolved\n',
      'rspack.config.ts': `import stylexPlugin from '@stylexjs/unplugin';
export default {
  mode: 'production',
  plugins: [stylexPlugin.rspack()],
};
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
      reasons: expect.arrayContaining([
        expect.stringContaining('required StyleX dependency entries'),
        expect.stringContaining('direct rspack adapter entries'),
      ]),
    });
  });

  test('exposes bootstrap discovery and task opening through the CLI', () => {
    let inspected = '';
    expect(
      runCli(['bootstrap', 'inspect', '--json'], {
        cwd: repo,
        writeStdout: (text) => {
          inspected += text;
        },
      }),
    ).toBe(0);
    expect(JSON.parse(inspected)).toMatchObject({
      command: 'bootstrap inspect',
      inspection: {
        packageManager: { name: 'pnpm' },
        integrations: [expect.objectContaining({ kind: 'rspack' })],
      },
    });

    let opened = '';
    expect(
      runCli(
        [
          'bootstrap',
          'open',
          'Install StyleX and wire the discovered Rspack build.',
          '--json',
        ],
        {
          cwd: repo,
          writeStdout: (text) => {
            opened += text;
          },
        },
      ),
    ).toBe(0);
    const output = JSON.parse(opened);
    expect(output).toMatchObject({
      command: 'bootstrap open',
      state: 'open',
      origin: { kind: 'bootstrap', integration: 'rspack' },
      allowedPaths: ['package.json', 'pnpm-lock.yaml', 'rspack.config.ts'],
      requiredChecks: [
        expect.objectContaining({
          checkVersion: 'stylex-rspack-emitted-css-v2',
        }),
      ],
    });
    expect(
      runCli(['context', 'abandon', output.taskId, '--json'], {
        cwd: repo,
        writeStdout: () => {},
      }),
    ).toBe(0);
  });
});

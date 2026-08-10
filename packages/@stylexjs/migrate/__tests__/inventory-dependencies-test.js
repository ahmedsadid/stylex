/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { scanRepository } from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

describe('M4 activation and dependency facts', () => {
  let repo: string;

  afterEach(() => {
    removeTempDir(repo);
  });

  test('confirmed project JSX configuration provides known activation', () => {
    repo = createTempRepo({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { jsxImportSource: '@emotion/react' },
      }),
      'src/App.tsx':
        "export const App = () => <div css={{ color: 'red' }} />;\n",
    });
    const inventory = scanRepository({ repositoryRoot: repo });
    expect(inventory.configInputs).toEqual(['tsconfig.json']);
    expect(inventory.sites[0].classification).toBe('mechanical');
    const activation = inventory.facts.find(
      (fact) => fact.id === inventory.sites[0].factIds[0],
    );
    expect(activation).toMatchObject({
      kind: 'emotion-jsx-activation',
      status: 'known',
      value: { source: 'project-config', config: 'tsconfig.json' },
    });
    expect(activation?.inputFiles).toEqual(['src/App.tsx', 'tsconfig.json']);
  });

  test('resolved imports and re-exports become declared dependency facts', () => {
    repo = createTempRepo({
      'src/App.jsx': `/** @jsxImportSource @emotion/react */
import type {Theme} from './theme';
export {shared} from './shared';
export const App = () => <div css={{ color: 'red' }} />;
`,
      'src/theme.ts': 'export type Theme = {color: string};\n',
      'src/shared/index.js': 'export const shared = 1;\n',
    });
    const inventory = scanRepository({ repositoryRoot: repo });
    const app = inventory.files.find((file) => file.path === 'src/App.jsx');
    expect(app?.dependencies).toEqual([
      expect.objectContaining({
        specifier: './shared',
        status: 'known',
        resolvedPath: 'src/shared/index.js',
      }),
      expect.objectContaining({
        specifier: './theme',
        status: 'known',
        resolvedPath: 'src/theme.ts',
      }),
    ]);
    for (const dependency of app?.dependencies ?? []) {
      const fact = inventory.facts.find(
        (candidate) => candidate.id === dependency.factId,
      );
      expect(fact?.status).toBe('known');
      expect(fact?.inputFiles).toContain(dependency.resolvedPath);
    }
  });

  test('failed local resolution remains visible and blocks mechanical routing', () => {
    repo = createTempRepo({
      'src/App.jsx': `/** @jsxImportSource @emotion/react */
import {missing} from './missing';
export const App = () => <div css={{ color: 'red' }} />;
`,
    });
    const inventory = scanRepository({ repositoryRoot: repo });
    const app = inventory.files.find((file) => file.path === 'src/App.jsx');
    expect(app?.dependencies[0]).toMatchObject({
      specifier: './missing',
      status: 'resolution-failed',
      resolvedPath: null,
    });
    expect(inventory.sites[0].classification).toBe('owner-decision');
    expect(inventory.sites[0].routingReasons).toContain(
      'one or more local dependencies could not be resolved',
    );
  });

  test('unreadable project activation is resolution-failed, not false', () => {
    repo = createTempRepo({
      '.babelrc': '{not valid json',
      'src/App.jsx':
        "export const App = () => <div css={{ color: 'red' }} />;\n",
      'src/Local.jsx': `/** @jsxImportSource @emotion/react */
export const Local = () => <div css={{ color: 'blue' }} />;
`,
    });
    const inventory = scanRepository({ repositoryRoot: repo });
    const app = inventory.sites.find((site) => site.file === 'src/App.jsx');
    const local = inventory.sites.find((site) => site.file === 'src/Local.jsx');
    const appActivation = inventory.facts.find(
      (fact) => fact.id === app?.factIds[0],
    );
    expect(appActivation?.status).toBe('resolution-failed');
    expect(app?.classification).toBe('owner-decision');
    expect(local?.classification).toBe('mechanical');
  });
});

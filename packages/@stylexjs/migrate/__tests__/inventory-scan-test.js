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

describe('M4 repository inventory', () => {
  let repo: string;

  afterEach(() => {
    removeTempDir(repo);
  });

  test('discovers configured source files and records all four routes', () => {
    repo = createTempRepo({
      'src/Mechanical.jsx': `/** @jsxImportSource @emotion/react */
export const Mechanical = () => <div css={{ color: 'red' }} />;
`,
      'src/Owner.jsx': `import {jsx} from '@emotion/react';
export const Owner = () => <div css={{ color: 'red' }} />;
`,
      'src/Repeatable.jsx': `/** @jsxImportSource @emotion/react */
export const Repeatable = () => <Button css={{ color: value }} />;
`,
      'src/Bespoke.jsx': `/** @jsxImportSource @emotion/react */
export const Bespoke = () => <div className="existing" css={{ color: 'red' }} />;
`,
      'src/TypeOnly.jsx': `import type {Theme} from '@emotion/react';
export const TypeOnly = () => <div css={{ color: 'red' }} />;
`,
      'src/Broken.jsx': 'export const Broken = <div css={{color: }} />;\n',
      'node_modules/ignored.jsx': `/** @jsxImportSource @emotion/react */
export const Ignored = () => <div css={{ color: 'red' }} />;
`,
      'src/not-scanned.txt': '<div css={{ color: red }} />\n',
    });

    const inventory = scanRepository({
      repositoryRoot: repo,
      sourceGlobs: ['src/**/*.{js,jsx}'],
      now: () => '2026-08-10T00:00:00.000Z',
    });

    expect(inventory.files.map((file) => file.path)).toEqual([
      'src/Bespoke.jsx',
      'src/Broken.jsx',
      'src/Mechanical.jsx',
      'src/Owner.jsx',
      'src/Repeatable.jsx',
      'src/TypeOnly.jsx',
    ]);
    expect(new Set(inventory.sites.map((site) => site.classification))).toEqual(
      new Set([
        'mechanical',
        'repeatable-contextual',
        'bespoke-contextual',
        'owner-decision',
      ]),
    );
    expect(inventory.diagnostics).toHaveLength(1);
    expect(inventory.diagnostics[0]).toMatchObject({
      file: 'src/Broken.jsx',
      kind: 'parse',
    });
    const failedFact = inventory.facts.find(
      (fact) => fact.id === inventory.diagnostics[0].factId,
    );
    expect(failedFact?.status).toBe('resolution-failed');
    const typeOnly = inventory.sites.find(
      (site) => site.file === 'src/TypeOnly.jsx',
    );
    expect(typeOnly?.classification).toBe('owner-decision');
    const typeOnlyFact = inventory.facts.find(
      (fact) => fact.id === typeOnly?.factIds[0],
    );
    expect(typeOnlyFact?.status).toBe('unknown');
  });

  test('content identity is stable across scan timestamps', () => {
    repo = createTempRepo({
      'src/App.jsx': `/** @jsxImportSource @emotion/react */
export const App = () => <div css={{ color: 'red' }} />;
`,
    });
    const first = scanRepository({
      repositoryRoot: repo,
      now: () => '2026-08-10T00:00:00.000Z',
    });
    const second = scanRepository({
      repositoryRoot: repo,
      now: () => '2026-08-11T00:00:00.000Z',
    });
    expect(second.id).toBe(first.id);
    expect(second.scannedAt).not.toBe(first.scannedAt);
    expect(second.sites[0].id).toBe(first.sites[0].id);
  });
});

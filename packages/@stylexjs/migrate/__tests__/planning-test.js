/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  createPlan,
  detectClusterConflicts,
  scanRepository,
  suggestClusters,
} from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

describe('M4 dependency-aware planning', () => {
  let repo: string;

  beforeEach(() => {
    repo = createTempRepo({
      'src/A.jsx': `/** @jsxImportSource @emotion/react */
import {shared} from './shared';
export const A = () => <>
  <div css={{ color: 'red' }}>{shared}</div>
  <span css={{ color: 'green' }} />
</>;
`,
      'src/B.jsx': `/** @jsxImportSource @emotion/react */
import {shared} from './shared';
export const B = () => <div css={{ color: 'blue' }}>{shared}</div>;
`,
      'src/shared.js': "export {deep as shared} from './deep';\n",
      'src/deep.js': 'export const deep = 1;\n',
      'src/Contextual.jsx': `/** @jsxImportSource @emotion/react */
export const Contextual = () => <Button css={{ color: value }} />;
`,
      'src/Missing.jsx': `/** @jsxImportSource @emotion/react */
import {missing} from './does-not-exist';
export const Missing = () => <div css={{ color: 'black' }}>{missing}</div>;
`,
    });
  });

  afterEach(() => {
    removeTempDir(repo);
  });

  test('merges overlapping change ownership and retains transitive inputs', () => {
    const inventory = scanRepository({ repositoryRoot: repo });
    const suggestions = suggestClusters(inventory);
    expect(suggestions).toHaveLength(5);

    const plan = createPlan({
      inventory,
      now: () => '2026-08-10T00:00:00.000Z',
    });
    expect(plan.clusters).toHaveLength(4);
    expect(plan.conflicts).toEqual([]);

    const app = plan.clusters.find((cluster) =>
      cluster.changeFiles.includes('src/A.jsx'),
    );
    expect(app).toMatchObject({
      classification: 'mechanical',
      state: 'planned',
    });
    expect(app?.siteIds).toHaveLength(2);
    expect(app?.declaredInputs).toEqual([
      'src/A.jsx',
      'src/deep.js',
      'src/shared.js',
    ]);

    const component = plan.clusters.find((cluster) =>
      cluster.changeFiles.includes('src/B.jsx'),
    );
    expect(component?.declaredInputs).toEqual([
      'src/B.jsx',
      'src/deep.js',
      'src/shared.js',
    ]);

    const missing = plan.clusters.find((cluster) =>
      cluster.changeFiles.includes('src/Missing.jsx'),
    );
    expect(missing?.classification).toBe('owner-decision');
    expect(missing?.state).toBe('blocked');
    expect(missing?.blockedReasons.join('\n')).toContain(
      'could not resolve ./does-not-exist',
    );
    expect(plan.counts).toEqual({
      classification: {
        mechanical: 2,
        'repeatable-contextual': 1,
        'bespoke-contextual': 0,
        'owner-decision': 1,
      },
      state: { planned: 3, blocked: 1 },
    });
  });

  test('plan identity excludes generation time', () => {
    const inventory = scanRepository({ repositoryRoot: repo });
    const first = createPlan({
      inventory,
      now: () => '2026-08-10T00:00:00.000Z',
    });
    const second = createPlan({
      inventory,
      now: () => '2026-08-11T00:00:00.000Z',
    });
    expect(second.id).toBe(first.id);
    expect(second.generatedAt).not.toBe(first.generatedAt);
  });

  test('conflict detection names competing change owners', () => {
    const inventory = scanRepository({ repositoryRoot: repo });
    const cluster = createPlan({ inventory }).clusters[0];
    const competing = { ...cluster, id: 'competing-cluster' };
    const conflicts = detectClusterConflicts([
      cluster,
      competing as $FlowFixMe,
    ]);
    expect(conflicts).toEqual(
      cluster.changeFiles.map((file) => ({
        path: file,
        clusterIds: [cluster.id, 'competing-cluster'].sort(),
      })),
    );
  });
});

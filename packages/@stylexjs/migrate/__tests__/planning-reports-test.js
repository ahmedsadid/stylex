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
  initializeProject,
  loadCurrentInventory,
  loadCurrentPlan,
  openProject,
  saveInventory,
  savePlan,
  scanRepository,
  writeRecord,
} from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

describe('M4 persisted inventory and plans', () => {
  let repo: string;

  beforeEach(() => {
    repo = createTempRepo({
      'src/App.jsx': `/** @jsxImportSource @emotion/react */
export const App = () => <div css={{ color: 'red' }} />;
`,
    });
  });

  afterEach(() => {
    removeTempDir(repo);
  });

  test('content-addressed reports survive a project reopen', () => {
    const project = initializeProject({ repositoryRoot: repo });
    const inventory = scanRepository({ repositoryRoot: repo });
    const plan = createPlan({ inventory });
    saveInventory(project, inventory);
    savePlan(project, plan);

    const reopened = openProject(repo);
    expect(loadCurrentInventory(reopened)).toEqual(inventory);
    expect(loadCurrentPlan(reopened)).toEqual(plan);
  });

  test('a current pointer can advance without overwriting immutable content', () => {
    const project = initializeProject({ repositoryRoot: repo });
    const first = scanRepository({
      repositoryRoot: repo,
      now: () => '2026-08-10T00:00:00.000Z',
    });
    const second = scanRepository({
      repositoryRoot: repo,
      now: () => '2026-08-11T00:00:00.000Z',
    });
    expect(first.id).toBe(second.id);

    saveInventory(project, first);
    saveInventory(project, second);
    expect(loadCurrentInventory(project)?.scannedAt).toBe(
      '2026-08-11T00:00:00.000Z',
    );
  });

  test('runtime validation rejects a structurally invalid report envelope', () => {
    const project = initializeProject({ repositoryRoot: repo });
    writeRecord(project, 'reports', 'inventory-bad', {
      kind: 'inventory',
      inventory: { id: 'bad' },
    });
    writeRecord(project, 'reports', 'inventory-current', {
      kind: 'inventory-pointer',
      id: 'bad',
      timestamp: '2026-08-10T00:00:00.000Z',
    });
    expect(() => loadCurrentInventory(project)).toThrow(
      'Invalid persisted inventory',
    );
  });
});

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import path from 'path';
import { runCli } from '../src/cli';
import {
  TEST_ASSUMPTION_PROTOCOL_VERSION,
  assertCurrentTestAssumption,
  initializeProject,
  loadTestAssumption,
  persistTestAssumption,
  saveInventory,
  scanRepository,
} from '../src/index';
import type { ProjectState } from '../src/index';
import {
  createTempDir,
  createTempRepo,
  removeTempDir,
  writeFiles,
} from './utils/tempRepo';

describe('test assumptions', () => {
  let repo: string;
  let inputRoot: string;
  let project: ProjectState;

  beforeEach(() => {
    repo = createTempRepo({
      'src/theme.ts': "export const themeClass = 'theme-dark';\n",
      'src/portal.tsx': 'export const portalHost = () => document.body;\n',
    });
    inputRoot = createTempDir('stylex-migrate-assumption-');
    project = initializeProject({ repositoryRoot: repo });
    saveInventory(project, scanRepository({ repositoryRoot: repo }));
  });

  afterEach(() => {
    removeTempDir(inputRoot);
    removeTempDir(repo);
  });

  function input(): $FlowFixMe {
    return {
      purpose: 'Exercise light and dark body-portal theme cases.',
      facts: [
        {
          statement: 'The test theme host is document.body.',
          status: 'inferred',
          inputFiles: ['src/theme.ts', 'src/portal.tsx'],
          detail: 'Theme classes and the selected portal share document.body.',
        },
      ],
      scope: {
        files: ['src/theme.ts', 'src/portal.tsx'],
        cases: ['light-root', 'dark-root', 'light-portal', 'dark-portal'],
      },
      rationale: 'This matches the observed same-document test topology.',
      alternatives: ['Use a semantic wrapper after owner review.'],
      limitations: [
        'Does not cover nested themes, secondary windows, SSR, or hydration.',
      ],
    };
  }

  test('persists a content-addressed, explicitly non-approved artifact', () => {
    const assumption = persistTestAssumption({
      project,
      input: input(),
      authorKind: 'agent',
      authoredBy: 'fixture-agent',
      now: () => '2026-08-12T00:00:00.000Z',
    });
    expect(assumption).toMatchObject({
      id: expect.stringMatching(/^test-assumption-/),
      protocolVersion: TEST_ASSUMPTION_PROTOCOL_VERSION,
      authorKind: 'agent',
      authoredBy: 'fixture-agent',
    });
    expect(assumption).not.toHaveProperty('approvedBy');
    expect(loadTestAssumption(project, assumption.id)).toEqual(assumption);
    expect(() =>
      assertCurrentTestAssumption(project, assumption),
    ).not.toThrow();
  });

  test('becomes stale when an exact input or inventory changes', () => {
    const assumption = persistTestAssumption({
      project,
      input: input(),
      authorKind: 'human',
      authoredBy: 'fixture-developer',
    });
    writeFiles(repo, {
      'src/theme.ts': "export const themeClass = 'theme-light';\n",
    });
    expect(() => assertCurrentTestAssumption(project, assumption)).toThrow(
      'dirty inputs',
    );
  });

  test('records and inspects assumptions through a warning-heavy CLI', () => {
    const file = path.join(inputRoot, 'assumption.json');
    writeFiles(inputRoot, { 'assumption.json': JSON.stringify(input()) });
    let stdout = '';
    expect(
      runCli(
        ['assumption', 'record', file, 'agent', 'fixture-agent', '--json'],
        { cwd: repo, writeStdout: (text) => (stdout += text) },
      ),
    ).toBe(0);
    const recorded = JSON.parse(stdout);
    expect(recorded).toMatchObject({
      command: 'assumption record',
      state: 'test-only',
      warnings: expect.arrayContaining([
        expect.stringContaining('not repository intent'),
      ]),
    });
    stdout = '';
    expect(
      runCli(['assumption', 'inspect', recorded.assumption.id, '--json'], {
        cwd: repo,
        writeStdout: (text) => (stdout += text),
      }),
    ).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      command: 'assumption inspect',
      state: 'current',
    });
  });
});

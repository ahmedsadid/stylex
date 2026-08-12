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
import {
  THEME_DECISION_PROTOCOL_VERSION,
  THEME_RUNTIME_PROBE_PROTOCOL_VERSION,
  createThemeRuntimeProbeDefinition,
  initializeProject,
  openThemeRuntimeProbeTask,
  persistTestAssumption,
  persistThemeDecisionDraft,
  saveInventory,
  scanRepository,
} from '../src/index';
import { runCli } from '../src/cli';
import type {
  ProjectState,
  TestAssumption,
  ThemeDecisionDraft,
} from '../src/index';
import { createTempDir, createTempRepo, removeTempDir } from './utils/tempRepo';

const CASES = [
  'theme-dark-portal',
  'theme-dark-root',
  'theme-light-portal',
  'theme-light-root',
];

describe('theme runtime probe generation', () => {
  let repo: string;
  let workspaceRoot: string;
  let project: ProjectState;
  let draft: ThemeDecisionDraft;
  let assumption: TestAssumption;

  beforeEach(() => {
    repo = createTempRepo({
      'package.json': JSON.stringify({ private: true }),
      'src/theme.ts': `export const lightTheme = {colors: {foreground: '#111'}};
export const darkTheme = {colors: {foreground: '#eee'}};
`,
      'src/Card.tsx': `import styled from '@emotion/styled';
export const Card = styled.div\`color: \${p => p.theme.colors.foreground};\`;
`,
      'src/App.tsx': 'export const App = ({children}) => children;\n',
      'scripts/serve.cjs': 'require("http").createServer().listen(4173);\n',
    });
    workspaceRoot = createTempDir('stylex-migrate-theme-probe-');
    project = initializeProject({ repositoryRoot: repo });
    const inventory = scanRepository({ repositoryRoot: repo });
    saveInventory(project, inventory);
    draft = persistThemeDecisionDraft({
      project,
      draftedBy: 'fixture-agent',
      definition: {
        protocolVersion: THEME_DECISION_PROTOCOL_VERSION,
        inventoryId: inventory.id,
        targetModule: 'src/tokens.stylex.ts',
        varsExport: 'themeVars',
        defaultVariant: 'light',
        variants: [
          {
            name: 'light',
            exportName: 'lightTheme',
            sourceFile: 'src/theme.ts',
          },
          { name: 'dark', exportName: 'darkTheme', sourceFile: 'src/theme.ts' },
        ],
        tokens: [
          {
            sourcePath: 'colors.foreground',
            targetName: 'colorsForeground',
            values: { light: '#111', dark: '#eee' },
            existingCssVariable: null,
          },
        ],
        sourceFiles: ['src/theme.ts'],
        consumerFiles: ['src/Card.tsx'],
        bridge: { coverageGlobs: ['src/**'], boundaryFiles: ['src/App.tsx'] },
      },
    });
    assumption = persistTestAssumption({
      project,
      input: {
        purpose: 'Test the inferred root and body-portal theme host.',
        facts: [
          {
            statement: 'The fixture route renders root and portal targets.',
            status: 'inferred',
            inputFiles: ['scripts/serve.cjs'],
            detail: 'Disposable test wiring, not repository intent.',
          },
        ],
        scope: {
          files: ['src/App.tsx', 'src/Card.tsx', 'src/tokens.stylex.ts'],
          cases: CASES,
        },
        rationale: 'Exercise the standard matrix without owner approval.',
        alternatives: ['Add a repository-owned Playwright test.'],
        limitations: ['Does not cover nested providers.'],
      },
      authorKind: 'agent',
      authoredBy: 'fixture-agent',
    });
  });

  afterEach(() => {
    removeTempDir(workspaceRoot);
    removeTempDir(repo);
  });

  function input(): $FlowFixMe {
    const activation = (variant: 'light' | 'dark') => [
      {
        id: `activate-${variant}`,
        kind: 'set-attribute',
        selector: 'body',
        name: 'data-theme',
        value: variant,
      },
    ];
    return {
      protocolVersion: THEME_RUNTIME_PROBE_PROTOCOL_VERSION,
      packageRoot: '.',
      playwrightPackage: 'playwright',
      nativeSurfaceDisposition: 'none-known',
      server: {
        argv: ['node', 'scripts/serve.cjs'],
        cwd: '.',
        inputFiles: ['scripts/serve.cjs'],
        url: 'http://127.0.0.1:4173/',
        timeoutMs: 5000,
      },
      path: '/theme-probe',
      testedConsumerFiles: ['src/Card.tsx'],
      siteIds: [],
      viewport: { width: 1024, height: 768, deviceScaleFactor: 1 },
      activation: { light: activation('light'), dark: activation('dark') },
      targets: {
        root: {
          selector: '[data-theme-probe="root"]',
          properties: [
            { sourcePath: 'colors.foreground', cssProperty: 'color' },
          ],
        },
        portal: {
          selector: '[data-theme-probe="portal"]',
          properties: [
            { sourcePath: 'colors.foreground', cssProperty: 'color' },
          ],
        },
      },
      rationale: 'Use the inferred body host for this disposable run.',
      limitations: ['Covers only the selected foreground token.'],
    };
  }

  test('derives the exact light/dark root/portal matrix from the theme draft', () => {
    const generated = createThemeRuntimeProbeDefinition({
      draft,
      value: input(),
    });
    expect(generated.cases.map((item) => item.id)).toEqual(CASES);
    expect(generated.cases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'theme-light-root',
          changePaths: ['src/App.tsx', 'src/Card.tsx', 'src/tokens.stylex.ts'],
          targets: [
            expect.objectContaining({
              id: 'root',
              computedProperties: ['color'],
              observeDom: false,
              observeRef: false,
            }),
          ],
        }),
      ]),
    );
    expect(generated.syntheticCssExpectations).toMatchObject({
      source: { id: draft.id, definitionHash: draft.definitionHash },
      cases: [
        {
          id: 'theme-dark-portal',
          computedStyles: { portal: { color: '#eee' } },
        },
        { id: 'theme-dark-root', computedStyles: { root: { color: '#eee' } } },
        {
          id: 'theme-light-portal',
          computedStyles: { portal: { color: '#111' } },
        },
        { id: 'theme-light-root', computedStyles: { root: { color: '#111' } } },
      ],
    });
  });

  test('opens locked output through the API', () => {
    const opened = openThemeRuntimeProbeTask({
      project,
      draftId: draft.id,
      assumptionId: assumption.id,
      value: input(),
      goal: 'Generate the standard theme runtime matrix.',
      workspaceRoot,
    });
    if (!opened.ok) throw new Error(opened.reasons.join('\n'));
    expect(opened.task).toMatchObject({
      decisionArtifactHashes: [draft.definitionHash],
      assumptionArtifactHashes: [assumption.artifactHash],
      origin: {
        kind: 'evidence-surface',
        syntheticCssExpectations: { source: { id: draft.id } },
      },
    });
  });

  test('opens through the stable CLI', () => {
    fs.writeFileSync(
      path.join(repo, 'theme-probe.json'),
      JSON.stringify(input()),
    );
    let stdout = '';
    const code = runCli(
      [
        'theme',
        'probe',
        'open',
        draft.id,
        assumption.id,
        'theme-probe.json',
        'Generate the standard theme runtime matrix.',
        '--json',
      ],
      { cwd: repo, writeStdout: (text) => (stdout += text) },
    );
    if (code !== 0) throw new Error(stdout);
    expect(JSON.parse(stdout)).toMatchObject({
      command: 'theme probe open',
      state: 'open',
      cases: CASES,
    });
  });

  test('refuses tokens outside the draft and numeric values without CSS serialization', () => {
    const unknown = input();
    unknown.targets.root.properties[0].sourcePath = 'colors.missing';
    expect(() =>
      createThemeRuntimeProbeDefinition({ draft, value: unknown }),
    ).toThrow('is not in');

    const numericDraft: ThemeDecisionDraft = {
      ...draft,
      tokens: [
        {
          ...draft.tokens[0],
          values: { light: 8, dark: 12 },
        },
      ],
    } as any;
    expect(() =>
      createThemeRuntimeProbeDefinition({
        draft: numericDraft,
        value: input(),
      }),
    ).toThrow('requires explicit numberSerialization');
  });
});

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { runCli } from '../src/cli';
import {
  initializeProject,
  inventoryReadiness,
  saveInventory,
  scanRepository,
} from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

function run(repo: string, args: $ReadOnlyArray<string>): $FlowFixMe {
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
    stderr,
    json: stdout === '' ? null : JSON.parse(stdout),
  };
}

describe('real-repository readiness inventory', () => {
  let repo: string;

  beforeEach(() => {
    repo = createTempRepo({
      'src/styled.tsx': `import sx from '@emotion/styled';
const Base = () => null;
export const Box = sx.div({color: 'red'});
export const Link = sx('a')\`color: red;\`;
export const Card = sx(Base, {shouldForwardProp: (name) => name !== 'active'})(({theme, active}) => ({color: active ? theme.colors.active : theme.colors.text}));
`,
      'src/theme.tsx': `import {ThemeProvider} from '@emotion/react';
export const lightTheme = {colors: {text: '#111', active: '#00f'}};
export const App = ({children}) => <ThemeProvider theme={lightTheme}>{children}</ThemeProvider>;
`,
      'src/css-prop.tsx': `/** @jsxImportSource @emotion/react */
export const Plain = () => <div css={{color: 'red'}} />;
`,
      'src/shadowed.tsx': `import styled from '@emotion/styled';
export function factory(styled) {
  return styled.div({color: 'red'});
}
`,
    });
  });

  afterEach(() => {
    removeTempDir(repo);
  });

  test('records styled shapes without pretending they are planned sites', () => {
    const project = initializeProject({ repositoryRoot: repo });
    const inventory = scanRepository({ repositoryRoot: repo });
    saveInventory(project, inventory);
    const summary = inventoryReadiness(inventory);

    expect(summary.styled).toEqual({
      definitions: 3,
      files: 1,
      plannedSites: 0,
      targets: { intrinsic: 2, component: 1, unknown: 0 },
      syntax: { call: 2, 'tagged-template': 1 },
      styleForms: {
        callback: 1,
        object: 1,
        'tagged-template': 1,
      },
      closedTemplates: 1,
      intrinsicClosedTemplates: 1,
      componentClosedTemplates: 0,
      callbacks: 1,
      themeDependent: 1,
      propDependent: 1,
      withOptions: 1,
      withShouldForwardProp: 1,
      usageGraphs: 3,
      firstSliceEligible: 0,
      themeSliceEligible: 0,
      directJsxConsumers: 0,
      withEscapes: 0,
      blockedReasons: {
        'exported-definition': 3,
        'no-direct-jsx-consumers': 3,
        'non-intrinsic-target': 1,
        'open-or-unsupported-style-form': 2,
        'runtime-style-input': 1,
        'styled-options': 1,
      },
      themeBlockedReasons: {
        'exported-definition': 3,
        'no-direct-jsx-consumers': 3,
        'non-intrinsic-target': 1,
        'not-a-theme-template': 3,
        'not-theme-only-runtime-input': 3,
        'styled-options': 1,
      },
      templateGrammarFacts: 0,
      flatTemplateGrammarEligible: 0,
      templateGrammarBlockedReasons: {},
      themeTemplateGrammarFacts: 0,
      flatThemeTemplateGrammarEligible: 0,
      providerScopedThemeEligible: 0,
      themeTemplateGrammarBlockedReasons: {},
      plannedThemeSites: 0,
    });
    expect(summary.theme).toMatchObject({
      definitions: 1,
      providers: 1,
    });
    expect(summary.cssProps).toMatchObject({
      total: 1,
      classification: { mechanical: 1 },
    });
    expect(summary.samples.map((sample) => sample.name)).toEqual([
      'Box',
      'Card',
      'Link',
    ]);
    expect(summary.limitations.join(' ')).toContain(
      'not convertible sites or semantic claims',
    );
    expect(
      inventory.facts.some(
        (fact) =>
          fact.kind === 'emotion-styled-readiness' &&
          fact.inputFiles.includes('src/shadowed.tsx'),
      ),
    ).toBe(false);
  });

  test('exposes compact scan counts and detailed readiness samples', () => {
    expect(run(repo, ['init']).code).toBe(0);
    const scan = run(repo, ['scan']);
    expect(scan.code).toBe(0);
    expect(scan.json.readiness.styled).toMatchObject({
      definitions: 3,
      plannedSites: 0,
    });
    expect(scan.json.readiness.samples).toEqual([]);

    const readiness = run(repo, ['readiness']);
    expect(readiness.code).toBe(0);
    expect(readiness.json).toMatchObject({
      command: 'readiness',
      inventoryId: scan.json.inventoryId,
      readiness: { styled: { definitions: 3 } },
    });
    expect(readiness.json.readiness.samples).toHaveLength(3);
  });

  test('requires a durable scan before readiness reporting', () => {
    expect(run(repo, ['init']).code).toBe(0);
    const result = run(repo, ['readiness']);
    expect(result.code).toBe(1);
    expect(result.json.error).toContain('stylex-migrate scan');
  });
});

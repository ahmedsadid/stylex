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
  approvePersistedThemeDecision,
  assertActiveThemeCandidateDecisions,
  createCandidateEvidenceSubject,
  initializeProject,
  persistThemeDecisionDraft,
  persistTestAssumption,
  proposeThemeDecisionCandidate,
  proposeThemeExperimentCandidate,
  saveInventory,
  scanRepository,
  verifyPersistedCandidates,
} from '../src/index';
import {
  createTempDir,
  createTempRepo,
  readFile,
  removeTempDir,
  writeFiles,
} from './utils/tempRepo';

function definition(
  inventoryId: string,
  consumerFile: string,
  targetName: string = 'foreground',
  bridge: $FlowFixMe = null,
) {
  return {
    protocolVersion: THEME_DECISION_PROTOCOL_VERSION,
    inventoryId,
    targetModule: 'src/theme/tokens.stylex.ts',
    varsExport: 'themeVars',
    defaultVariant: 'lightTheme',
    variants: [
      { name: 'lightTheme', exportName: 'lightTheme' },
      { name: 'darkTheme', exportName: 'darkTheme' },
    ],
    tokens: [
      {
        sourcePath: 'colors.foreground',
        targetName,
        values: { lightTheme: '#111', darkTheme: '#eee' },
        existingCssVariable: null,
      },
    ],
    sourceFiles: ['src/theme/themes.ts'],
    consumerFiles: [consumerFile],
    bridge,
  };
}

function candidateSource(result: $FlowFixMe, file: string): string {
  const change = result.record.candidate.changes.find(
    (item) => item.path === file,
  );
  if (change?.content == null)
    throw new Error(`No candidate source for ${file}`);
  return change.content;
}

describe('M9 theme decision candidate lifecycle', () => {
  let repo: string;
  let workspaceRoot: string;

  afterEach(() => {
    removeTempDir(repo);
    removeTempDir(workspaceRoot);
  });

  function prepare(files: { +[file: string]: string }, consumerFile: string) {
    const repositoryFiles: { [file: string]: string } = { ...files };
    repositoryFiles['src/theme/themes.ts'] =
      `export const lightTheme = {colors: {foreground: '#111'}};
export const darkTheme = {colors: {foreground: '#eee'}};
`;
    repo = createTempRepo(repositoryFiles);
    workspaceRoot = createTempDir('stylex-migrate-theme-ws-');
    const project = initializeProject({ repositoryRoot: repo });
    const inventory = scanRepository({ repositoryRoot: repo });
    saveInventory(project, inventory);
    const draft = persistThemeDecisionDraft({
      project,
      definition: definition(inventory.id, consumerFile),
      draftedBy: 'agent',
    });
    const approval = approvePersistedThemeDecision({
      project,
      draftId: draft.id,
      actor: 'human',
      approvedBy: 'reviewer',
    });
    return { project, inventory, draft, approval };
  }

  test('pins a callback slice from approval through an immutable candidate', () => {
    const card = `/** @jsxImportSource @emotion/react */
export const Card = () => <div css={(theme) => ({color: theme.colors.foreground})} />;
`;
    const { project, draft, approval } = prepare(
      { 'src/Card.tsx': card },
      'src/Card.tsx',
    );
    writeFiles(repo, { 'notes/unrelated.txt': 'developer work\n' });
    const result = proposeThemeDecisionCandidate({
      project,
      draftId: draft.id,
      workspaceRoot,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.ok).toBe(true);
    expect(result.record.candidate.decisionArtifactHashes).toEqual([
      approval.artifactHash,
    ]);
    expect(result.record.snapshot.decisionArtifactHashes).toEqual([
      approval.artifactHash,
    ]);
    expect(
      createCandidateEvidenceSubject({
        candidate: result.record.candidate,
        snapshot: result.record.snapshot,
        siteIdsByFile: result.record.siteIdsByFile,
      }).decisionArtifactHashes,
    ).toEqual([approval.artifactHash]);
    expect(candidateSource(result, 'src/Card.tsx')).toContain(
      'color: themeVars.foreground',
    );
    expect(candidateSource(result, 'src/theme/tokens.stylex.ts')).toContain(
      'stylex.defineVars',
    );
    expect(result.record.siteIdsByFile['src/Card.tsx']).toHaveLength(1);
    expect(readFile(repo, 'src/Card.tsx')).toBe(card);
    expect(readFile(repo, 'notes/unrelated.txt')).toBe('developer work\n');
    expect(fs.existsSync(path.join(repo, draft.targetModule))).toBe(false);
  });

  test('pins a ThemeProvider slice and covers its discovered provider site', () => {
    const provider = `import {ThemeProvider} from '@emotion/react';
import {darkTheme} from './theme/themes';
export const App = () => <ThemeProvider theme={darkTheme}><main>App</main></ThemeProvider>;
`;
    const { project, inventory, draft } = prepare(
      { 'src/Provider.tsx': provider },
      'src/Provider.tsx',
    );
    expect(
      inventory.sites.some(
        (site) =>
          site.file === 'src/Provider.tsx' && site.kind === 'theme-provider',
      ),
    ).toBe(true);
    const result = proposeThemeDecisionCandidate({
      project,
      draftId: draft.id,
      workspaceRoot,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.ok).toBe(true);
    const output = candidateSource(result, 'src/Provider.tsx');
    expect(output).not.toContain('ThemeProvider');
    expect(output).toContain('stylex.props(darkTheme)');
    expect(result.record.siteIdsByFile['src/Provider.tsx']).toHaveLength(1);
    expect(readFile(repo, 'src/Provider.tsx')).toBe(provider);
  });

  test('pins a styled theme slice to the approved map and exact site', () => {
    const styled = `import styled from '@emotion/styled';
import {ThemeProvider} from '@emotion/react';
import {darkTheme} from './theme/themes';
const CardRoot = styled.div\`color: \${p => p.theme.colors.foreground};\`;
export const Card = () => <ThemeProvider theme={darkTheme}><CardRoot data-card="true" /></ThemeProvider>;
`;
    const { project, inventory, draft, approval } = prepare(
      { 'src/Card.tsx': styled },
      'src/Card.tsx',
    );
    const site = inventory.sites.find(
      (item) =>
        item.file === 'src/Card.tsx' && item.kind === 'styled-theme-intrinsic',
    );
    expect(site).toBeDefined();
    const result = proposeThemeDecisionCandidate({
      project,
      draftId: draft.id,
      workspaceRoot,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.ok).toBe(true);
    const output = candidateSource(result, 'src/Card.tsx');
    expect(output).not.toContain("from '@emotion/styled'");
    expect(output).toContain('color: themeVars.foreground');
    expect(output).toContain('<div {...stylex.props(styles.cardRoot)}');
    expect(result.record.siteIdsByFile['src/Card.tsx']).toEqual(
      expect.arrayContaining([site?.id]),
    );
    expect(result.record.siteIdsByFile['src/Card.tsx']).toHaveLength(2);
    expect(result.record.candidate.decisionArtifactHashes).toEqual([
      approval.artifactHash,
    ]);
    expect(result.record.classification).toBe('repeatable-contextual');
    expect(result.record.staticEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 'stylex-plugin-transform',
          result: 'pass',
        }),
        expect.objectContaining({ check: 'stylex-lint', result: 'pass' }),
      ]),
    );
    expect(
      result.record.staticEvidence.some(
        (item) => item.check === 'static-css-comparison',
      ),
    ).toBe(false);
    expect(readFile(repo, 'src/Card.tsx')).toBe(styled);
  });

  test('converts a styled theme slice covered by a human-approved repository bridge', () => {
    const styled = `import styled from '@emotion/styled';
const CardRoot = styled.div\`color: \${p => p.theme.colors.foreground};\`;
export const Card = () => <CardRoot data-card="true" />;
`;
    repo = createTempRepo({
      'src/App.tsx':
        'export const App = ({children}) => <main>{children}</main>;\n',
      'src/Card.tsx': styled,
      'src/theme/themes.ts': `export const lightTheme = {colors: {foreground: '#111'}};
export const darkTheme = {colors: {foreground: '#eee'}};
`,
    });
    workspaceRoot = createTempDir('stylex-migrate-theme-ws-');
    const project = initializeProject({ repositoryRoot: repo });
    const inventory = scanRepository({ repositoryRoot: repo });
    saveInventory(project, inventory);
    const draft = persistThemeDecisionDraft({
      project,
      definition: definition(inventory.id, 'src/Card.tsx', 'foreground', {
        coverageGlobs: ['src/**'],
        boundaryFiles: ['src/App.tsx'],
      }),
      draftedBy: 'agent',
    });
    const approval = approvePersistedThemeDecision({
      project,
      draftId: draft.id,
      actor: 'human',
      approvedBy: 'reviewer',
    });
    expect(approval.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('human-approved scope assertion'),
        expect.stringContaining(
          'no generated StyleX theme variant application',
        ),
      ]),
    );

    const result = proposeThemeDecisionCandidate({
      project,
      draftId: draft.id,
      workspaceRoot,
    });
    if (!result.ok) throw new Error(result.reason);
    const output = candidateSource(result, 'src/Card.tsx');
    expect(output).not.toContain("from '@emotion/styled'");
    expect(output).toContain('color: themeVars.foreground');
    expect(output).toContain('<div {...stylex.props(styles.cardRoot)}');
    expect(result.record.snapshot.fileHashes['src/App.tsx']).toBeDefined();
    expect(readFile(repo, 'src/Card.tsx')).toBe(styled);
  });

  test('converts multiple closed styled theme definitions atomically under bridge coverage', () => {
    const styled = `import styled from '@emotion/styled';
const CardRoot = styled.div\`color: \${p => p.theme.colors.foreground};\`;
const CardLabel = styled.span\`border-color: \${p => p.theme.colors.foreground};\`;
export const Card = () => <CardRoot><CardLabel>Card</CardLabel></CardRoot>;
`;
    repo = createTempRepo({
      'src/App.tsx':
        'export const App = ({children}) => <main>{children}</main>;\n',
      'src/Card.tsx': styled,
      'src/theme/themes.ts': `export const lightTheme = {colors: {foreground: '#111'}};
export const darkTheme = {colors: {foreground: '#eee'}};
`,
    });
    workspaceRoot = createTempDir('stylex-migrate-theme-ws-');
    const project = initializeProject({ repositoryRoot: repo });
    const inventory = scanRepository({ repositoryRoot: repo });
    saveInventory(project, inventory);
    const draft = persistThemeDecisionDraft({
      project,
      definition: definition(inventory.id, 'src/Card.tsx', 'foreground', {
        coverageGlobs: ['src/**'],
        boundaryFiles: ['src/App.tsx'],
      }),
      draftedBy: 'agent',
    });
    approvePersistedThemeDecision({
      project,
      draftId: draft.id,
      actor: 'human',
      approvedBy: 'reviewer',
    });
    const result = proposeThemeDecisionCandidate({
      project,
      draftId: draft.id,
      workspaceRoot,
    });
    if (!result.ok) throw new Error(result.reason);
    const output = candidateSource(result, 'src/Card.tsx');
    expect(output).not.toContain("from '@emotion/styled'");
    expect(output).not.toContain('styled.div');
    expect(output).not.toContain('styled.span');
    expect(output).toContain('color: themeVars.foreground');
    expect(output).toContain('borderColor: themeVars.foreground');
    expect(output).toContain('<div {...stylex.props(styles.cardRoot)}>');
    expect(output).toContain('<span {...stylex.props(styles.cardLabel)}>');
    expect(readFile(repo, 'src/Card.tsx')).toBe(styled);
  });

  test('freezes a theme experiment under a test assumption without human approval', () => {
    const styled = `import styled from '@emotion/styled';
const CardRoot = styled.div\`color: \${p => p.theme.colors.foreground};\`;
export const Card = () => <CardRoot data-card="true" />;
`;
    repo = createTempRepo({
      'src/App.tsx':
        'export const App = ({children}) => <main>{children}</main>;\n',
      'src/Card.tsx': styled,
      'src/theme/themes.ts': `export const lightTheme = {colors: {foreground: '#111'}};
export const darkTheme = {colors: {foreground: '#eee'}};
`,
    });
    workspaceRoot = createTempDir('stylex-migrate-theme-ws-');
    const project = initializeProject({ repositoryRoot: repo });
    const inventory = scanRepository({ repositoryRoot: repo });
    saveInventory(project, inventory);
    const draft = persistThemeDecisionDraft({
      project,
      definition: definition(inventory.id, 'src/Card.tsx', 'foreground', {
        coverageGlobs: ['src/**'],
        boundaryFiles: ['src/App.tsx'],
      }),
      draftedBy: 'agent',
    });
    const assumption = persistTestAssumption({
      project,
      input: {
        purpose: 'Exercise the inferred theme bridge in a disposable run.',
        facts: [
          {
            statement: 'The fixture bridge is the selected experimental host.',
            status: 'inferred',
            inputFiles: ['src/App.tsx'],
            detail: 'This is test wiring, not repository intent.',
          },
        ],
        scope: {
          files: ['src/App.tsx', 'src/Card.tsx', 'src/theme/tokens.stylex.ts'],
          cases: ['theme-light-root', 'theme-dark-root'],
        },
        rationale: 'Test deterministic output before owner review.',
        alternatives: ['Ask a human to approve the production map.'],
        limitations: ['Does not approve the bridge.'],
      },
      authorKind: 'agent',
      authoredBy: 'fixture-agent',
    });
    const result = proposeThemeExperimentCandidate({
      project,
      draftId: draft.id,
      assumptionId: assumption.id,
      workspaceRoot,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.record.candidate).toMatchObject({
      proposer: {
        version: 'theme-experiment-v1',
        protocolVersion: 'stylex-migrate-theme-experiment-v1',
      },
      decisionArtifactHashes: [draft.definitionHash],
      assumptionArtifactHashes: [assumption.artifactHash],
    });
    expect(candidateSource(result, 'src/Card.tsx')).toContain(
      'color: themeVars.foreground',
    );
    expect(readFile(repo, 'src/Card.tsx')).toBe(styled);
  });

  test('a revised active map invalidates its dependent candidate at verification', async () => {
    const { project, inventory, draft } = prepare(
      {
        'src/Card.tsx': `/** @jsxImportSource @emotion/react */
export const Card = () => <div css={(theme) => ({color: theme.colors.foreground})} />;
`,
      },
      'src/Card.tsx',
    );
    const result = proposeThemeDecisionCandidate({
      project,
      draftId: draft.id,
      workspaceRoot,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.ok).toBe(true);
    const revised = persistThemeDecisionDraft({
      project,
      definition: definition(inventory.id, 'src/Card.tsx', 'textColor'),
      draftedBy: 'agent',
    });
    approvePersistedThemeDecision({
      project,
      draftId: revised.id,
      actor: 'human',
      approvedBy: 'reviewer',
    });
    expect(() =>
      assertActiveThemeCandidateDecisions(project, result.record.candidate),
    ).toThrow('is stale because another decision is active');
    await expect(
      verifyPersistedCandidates({
        project,
        candidateIds: [result.record.candidate.id],
        workspaceRoot,
      }),
    ).rejects.toThrow('is stale because another decision is active');
  });
});

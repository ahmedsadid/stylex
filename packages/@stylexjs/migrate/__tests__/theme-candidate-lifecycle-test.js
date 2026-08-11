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
  proposeThemeDecisionCandidate,
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
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
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
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    const output = candidateSource(result, 'src/Provider.tsx');
    expect(output).not.toContain('ThemeProvider');
    expect(output).toContain('stylex.props(darkTheme)');
    expect(result.record.siteIdsByFile['src/Provider.tsx']).toHaveLength(1);
    expect(readFile(repo, 'src/Provider.tsx')).toBe(provider);
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
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
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

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
import { openProject, writeConfig } from '../src/index';
import { runCli, runCliAsync } from '../src/cli';
import {
  createTempDir,
  createTempRepo,
  readFile,
  removeTempDir,
  writeFiles,
} from './utils/tempRepo';

type CliResult = {
  +code: number,
  +json: $FlowFixMe,
  +stderr: string,
};

function syncCli(repo: string, args: $ReadOnlyArray<string>): CliResult {
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
    json: stdout === '' ? null : JSON.parse(stdout),
    stderr,
  };
}

async function asyncCli(
  repo: string,
  args: $ReadOnlyArray<string>,
): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const code = await runCliAsync([...args, '--json'], {
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
    json: stdout === '' ? null : JSON.parse(stdout),
    stderr,
  };
}

describe('M9 theme CLI', () => {
  let repo: string;
  let inputRoot: string;

  beforeEach(() => {
    repo = createTempRepo({
      'src/theme/themes.ts': `export const lightTheme = {colors: {foreground: '#111'}};
export const darkTheme = {colors: {foreground: '#eee'}};
`,
      'src/Card.tsx': `import styled from '@emotion/styled';
import {ThemeProvider} from '@emotion/react';
import {darkTheme} from './theme/themes';
const CardRoot = styled.div\`color: \${p => p.theme.colors.foreground};\`;
export const Card = () => <ThemeProvider theme={darkTheme}><CardRoot data-card="true" /></ThemeProvider>;
`,
    });
    inputRoot = createTempDir('stylex-migrate-theme-input-');
  });

  afterEach(() => {
    removeTempDir(inputRoot);
    removeTempDir(repo);
  });

  test('drafts, requires human confirmation, proposes, verifies, and only reports candidate bytes', async () => {
    expect(syncCli(repo, ['init']).code).toBe(0);
    const scan = syncCli(repo, ['scan']);
    expect(scan.code).toBe(0);
    const candidates = syncCli(repo, ['theme', 'candidates']);
    expect(candidates).toMatchObject({
      code: 0,
      json: {
        command: 'theme candidates',
        counts: {
          bridgeReadyFiles: 1,
          bridgeReadyDefinitions: 1,
          localProviderReadyFiles: 1,
        },
        candidates: [
          {
            file: 'src/Card.tsx',
            definitionNames: ['CardRoot'],
            themePaths: ['colors.foreground'],
            bridgeReady: true,
            localProviderReady: true,
          },
        ],
      },
    });
    const definitionFile = path.join(inputRoot, 'theme.json');
    writeFiles(inputRoot, {
      'theme.json': JSON.stringify({
        protocolVersion: 'stylex-migrate-theme-decision-v1',
        inventoryId: scan.json.inventoryId,
        targetModule: 'src/theme/tokens.stylex.ts',
        varsExport: 'themeVars',
        defaultVariant: 'lightTheme',
        variants: [
          { name: 'lightTheme', exportName: 'lightTheme' },
          { name: 'darkTheme', exportName: 'darkTheme' },
        ],
        sourceFiles: ['src/theme/themes.ts'],
        consumerFiles: ['src/Card.tsx'],
      }),
    });

    const drafted = syncCli(repo, [
      'theme',
      'draft',
      definitionFile,
      'migration-agent',
    ]);
    expect(drafted.code).toBe(0);
    const draftId = drafted.json.draft.id;
    expect(drafted.json.draft).toMatchObject({
      mappings: [
        {
          sourcePath: 'colors.foreground',
          targetName: 'foreground',
          values: { lightTheme: '#111', darkTheme: '#eee' },
        },
      ],
    });
    expect(drafted.json.draft.tokens).toBeUndefined();
    const inspected = syncCli(repo, ['theme', 'inspect', draftId]);
    expect(inspected.json.state).toBe('drafted');
    expect(inspected.json.draft.mappings).toEqual(drafted.json.draft.mappings);

    const unconfirmed = syncCli(repo, [
      'theme',
      'approve',
      draftId,
      'reviewer',
    ]);
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.json.error).toContain('--human-confirm');

    const approved = syncCli(repo, [
      'theme',
      'approve',
      draftId,
      'reviewer',
      '--human-confirm',
    ]);
    expect(approved.code).toBe(0);
    expect(approved.json.warnings).toEqual([
      expect.stringContaining('does not establish runtime equivalence'),
    ]);
    const approvalHash = approved.json.approval.artifactHash;

    const original = readFile(repo, 'src/Card.tsx');
    const proposed = syncCli(repo, ['theme', 'propose', draftId]);
    if (proposed.code !== 0) throw new Error(JSON.stringify(proposed.json));
    expect(proposed).toMatchObject({
      code: 0,
      json: {
        command: 'theme propose',
        state: 'frozen',
        approvalArtifactHash: approvalHash,
      },
    });
    expect(readFile(repo, 'src/Card.tsx')).toBe(original);
    expect(fs.existsSync(path.join(repo, 'src/theme/tokens.stylex.ts'))).toBe(
      false,
    );
    const diff = syncCli(repo, [
      'candidate',
      'diff',
      proposed.json.candidateId,
    ]);
    expect(diff.code).toBe(0);
    expect(diff.json.patchText).toContain('stylex.create');
    expect(diff.json.patchText).toContain('themeVars.foreground');
    expect(diff.json.patchText).toContain('stylex.props(styles.cardRoot)');
    expect(diff.json.patchText).toContain('stylex.props(darkTheme)');
    expect(diff.json.patchText).not.toContain('+const CardRoot = styled.div');

    writeConfig(openProject(repo), {
      sourceGlobs: ['src/**/*.{js,jsx,ts,tsx}'],
      evidence: {
        concurrency: 1,
        outputPreviewBytes: 1024,
        providers: [
          {
            id: 'theme-repo-check',
            kind: 'command',
            check: 'focused-test',
            checkVersion: 'fixture-v1',
            subject: 'candidate',
            cost: 'cheap',
            argv: [process.execPath, '-e', 'process.exit(0)'],
            versionArgv: [
              process.execPath,
              '-e',
              "process.stdout.write('fixture-v1')",
            ],
            cwd: '.',
            allowedEnv: ['PATH'],
            fileGlobs: ['src/**'],
            limitations: ['fixture repository check'],
            timeoutMs: 5000,
          },
        ],
      },
    });
    const verified = await asyncCli(repo, [
      'verify',
      proposed.json.candidateId,
    ]);
    expect(verified).toMatchObject({
      code: 0,
      json: {
        subject: { decisionArtifactHashes: [approvalHash] },
        verdict: {
          outcome: 'eligible-for-review',
          decisionArtifactHashes: [approvalHash],
        },
        warnings: [expect.stringContaining('Runtime behavior was not matched')],
      },
    });
    const review = syncCli(repo, ['review', proposed.json.candidateId]);
    expect(review.json.candidates[0]).toMatchObject({
      decisionArtifactHashes: [approvalHash],
      decisionStatus: { status: 'active' },
    });
    expect(readFile(repo, 'src/Card.tsx')).toBe(original);
  });
});

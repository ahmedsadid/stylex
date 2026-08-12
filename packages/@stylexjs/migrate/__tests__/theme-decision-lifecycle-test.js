/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  THEME_DECISION_PROTOCOL_VERSION,
  THEME_NO_RUNTIME_LIMITATION,
  approvePersistedThemeDecision,
  initializeProject,
  inspectThemeDecision,
  persistThemeDecisionDraft,
  saveInventory,
  scanRepository,
} from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

function definition(inventoryId: string, targetName: string = 'foreground') {
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
    consumerFiles: ['src/Card.tsx'],
  };
}

describe('M9 persisted theme decisions', () => {
  let repo: string;

  beforeEach(() => {
    repo = createTempRepo({
      'src/theme/themes.ts': `export const lightTheme = {colors: {foreground: '#111'}};
export const darkTheme = {colors: {foreground: '#eee'}};
`,
      'src/Card.tsx': `/** @jsxImportSource @emotion/react */
export const Card = () => <div css={(theme) => ({color: theme.colors.foreground})} />;
`,
    });
  });

  afterEach(() => removeTempDir(repo));

  function setup() {
    const project = initializeProject({ repositoryRoot: repo });
    const inventory = scanRepository({ repositoryRoot: repo });
    saveInventory(project, inventory);
    return { project, inventory };
  }

  test('draft and approval are distinct durable events with an explicit runtime warning', () => {
    const { project, inventory } = setup();
    const draft = persistThemeDecisionDraft({
      project,
      definition: definition(inventory.id),
      draftedBy: 'migration-agent',
      now: () => '2026-08-11T00:00:00.000Z',
    });
    expect(inspectThemeDecision(project, draft.id)).toMatchObject({
      state: 'drafted',
      approval: null,
    });
    const approval = approvePersistedThemeDecision({
      project,
      draftId: draft.id,
      actor: 'human',
      approvedBy: 'human-reviewer',
      now: () => '2026-08-11T01:00:00.000Z',
    });
    expect(approval.limitations).toContain(THEME_NO_RUNTIME_LIMITATION);
    expect(inspectThemeDecision(project, draft.id)).toMatchObject({
      state: 'active',
      activeArtifactHash: approval.artifactHash,
    });
  });

  test('refuses a map whose values or reads disagree with current facts', () => {
    const { project, inventory } = setup();
    const wrongValue = definition(inventory.id);
    wrongValue.tokens[0].values.darkTheme = '#fff';
    expect(() =>
      persistThemeDecisionDraft({
        project,
        definition: wrongValue,
        draftedBy: 'agent',
      }),
    ).toThrow('does not match source');

    const missingToken = definition(inventory.id);
    missingToken.tokens[0].sourcePath = 'colors.accent';
    expect(() =>
      persistThemeDecisionDraft({
        project,
        definition: missingToken,
        draftedBy: 'agent',
      }),
    ).toThrow();
  });

  test('requires explicit human authority for persisted approval', () => {
    const { project, inventory } = setup();
    const draft = persistThemeDecisionDraft({
      project,
      definition: definition(inventory.id),
      draftedBy: 'agent',
    });
    expect(() =>
      approvePersistedThemeDecision({
        project,
        draftId: draft.id,
        actor: 'agent' as $FlowFixMe,
        approvedBy: 'migration-agent',
      }),
    ).toThrow('Only a named human may approve');
  });

  test('activating a revised map marks the earlier approval as superseded', () => {
    const { project, inventory } = setup();
    const first = persistThemeDecisionDraft({
      project,
      definition: definition(inventory.id),
      draftedBy: 'agent',
    });
    approvePersistedThemeDecision({
      project,
      draftId: first.id,
      actor: 'human',
      approvedBy: 'reviewer',
    });
    const second = persistThemeDecisionDraft({
      project,
      definition: definition(inventory.id, 'textColor'),
      draftedBy: 'agent',
    });
    const active = approvePersistedThemeDecision({
      project,
      draftId: second.id,
      actor: 'human',
      approvedBy: 'reviewer',
    });
    expect(inspectThemeDecision(project, first.id)).toMatchObject({
      state: 'superseded',
      activeArtifactHash: active.artifactHash,
    });
    expect(inspectThemeDecision(project, second.id).state).toBe('active');
  });
});

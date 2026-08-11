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
  approveThemeDecision,
  createThemeDecisionDraft,
  relativeThemeModuleSpecifier,
  validateThemeDecisionApproval,
  validateThemeDecisionDraft,
} from '../src/index';

function definition(): $FlowFixMe {
  return {
    protocolVersion: THEME_DECISION_PROTOCOL_VERSION,
    inventoryId: 'inventory-1',
    targetModule: 'src/theme/tokens.stylex.ts',
    varsExport: 'themeVars',
    defaultVariant: 'light',
    variants: [
      { name: 'light', exportName: 'lightTheme' },
      { name: 'dark', exportName: 'darkTheme' },
    ],
    tokens: [
      {
        sourcePath: 'colors.foreground',
        targetName: 'foreground',
        values: { light: '#111', dark: '#eee' },
        existingCssVariable: '--foreground',
      },
      {
        sourcePath: 'space.small',
        targetName: 'spaceSmall',
        values: { light: 4, dark: 4 },
        existingCssVariable: null,
      },
    ],
    sourceFiles: ['src/theme/dark.ts', 'src/theme/light.ts'],
    consumerFiles: ['src/components/Card.tsx'],
  };
}

describe('M9 theme token-map decisions', () => {
  test('canonicalizes an immutable complete map and approves it separately', () => {
    const draft = createThemeDecisionDraft({
      definition: definition(),
      draftedBy: 'migration-agent',
      now: () => '2026-08-11T00:00:00.000Z',
    });
    expect(validateThemeDecisionDraft(draft)).toEqual(draft);
    expect(Object.isFrozen(draft)).toBe(true);
    expect(draft.tokens.map((token) => token.sourcePath)).toEqual([
      'colors.foreground',
      'space.small',
    ]);
    const approval = approveThemeDecision({
      draft,
      actor: 'human',
      approvedBy: 'reviewer',
      limitations: ['tenant theme not observed', 'tenant theme not observed'],
      now: () => '2026-08-11T01:00:00.000Z',
    });
    expect(validateThemeDecisionApproval({ draft, approval })).toEqual(
      approval,
    );
    expect(approval).toMatchObject({
      draftId: draft.id,
      definitionHash: draft.definitionHash,
      approvedBy: 'reviewer',
      limitations: ['tenant theme not observed'],
    });
  });

  test.each([
    [
      'a missing variant',
      (input: $FlowFixMe) => delete input.tokens[0].values.dark,
    ],
    [
      'a placeholder',
      (input: $FlowFixMe) => (input.tokens[0].values.dark = 'TODO'),
    ],
    [
      'a source collision',
      (input: $FlowFixMe) => (input.tokens[1].sourcePath = 'colors.foreground'),
    ],
    [
      'a target collision',
      (input: $FlowFixMe) => (input.tokens[1].targetName = 'foreground'),
    ],
    [
      'an export collision',
      (input: $FlowFixMe) => (input.variants[1].exportName = 'lightTheme'),
    ],
    [
      'a noncanonical target',
      (input: $FlowFixMe) => (input.targetModule = '../tokens.stylex.ts'),
    ],
    [
      'a target and consumer collision',
      (input: $FlowFixMe) => {
        input.targetModule = 'src/components/Card.stylex.ts';
        input.consumerFiles = ['src/components/Card.stylex.ts'];
      },
    ],
  ])('refuses %s', (_label, mutate) => {
    const input = definition();
    mutate(input);
    expect(() =>
      createThemeDecisionDraft({ definition: input, draftedBy: 'agent' }),
    ).toThrow();
  });

  test('a changed value creates another decision and invalidates approval', () => {
    const first = createThemeDecisionDraft({
      definition: definition(),
      draftedBy: 'agent',
    });
    const changed = definition();
    changed.tokens[0].values.dark = '#fff';
    const second = createThemeDecisionDraft({
      definition: changed,
      draftedBy: 'agent',
    });
    const approval = approveThemeDecision({
      draft: first,
      actor: 'human',
      approvedBy: 'reviewer',
    });
    expect(second.id).not.toBe(first.id);
    expect(() =>
      validateThemeDecisionApproval({ draft: second, approval }),
    ).toThrow('Invalid theme decision approval');
  });

  test('computes extensionless specifiers from each consumer', () => {
    expect(
      relativeThemeModuleSpecifier(
        'src/components/Card.tsx',
        'src/theme/tokens.stylex.ts',
      ),
    ).toBe('../theme/tokens.stylex');
    expect(
      relativeThemeModuleSpecifier(
        'src/theme/Provider.tsx',
        'src/theme/tokens.stylex.ts',
      ),
    ).toBe('./tokens.stylex');
  });

  test('canonicalizes repository-managed bridge coverage into the decision hash', () => {
    const input = definition();
    input.bridge = {
      coverageGlobs: ['src/features/**', 'src/components/**'],
      boundaryFiles: ['src/App.tsx'],
    };
    const draft = createThemeDecisionDraft({
      definition: input,
      draftedBy: 'agent',
    });
    expect(draft.bridge).toEqual({
      coverageGlobs: ['src/components/**', 'src/features/**'],
      boundaryFiles: ['src/App.tsx'],
    });

    const changed = definition();
    changed.bridge = {
      coverageGlobs: ['src/components/**'],
      boundaryFiles: ['src/App.tsx'],
    };
    expect(
      createThemeDecisionDraft({ definition: changed, draftedBy: 'agent' }).id,
    ).not.toBe(draft.id);
  });

  test('refuses empty or escaping bridge coverage', () => {
    const empty = definition();
    empty.bridge = { coverageGlobs: [], boundaryFiles: ['src/App.tsx'] };
    expect(() =>
      createThemeDecisionDraft({ definition: empty, draftedBy: 'agent' }),
    ).toThrow('requires globs and boundary files');

    const escaping = definition();
    escaping.bridge = {
      coverageGlobs: ['../outside/**'],
      boundaryFiles: ['src/App.tsx'],
    };
    expect(() =>
      createThemeDecisionDraft({ definition: escaping, draftedBy: 'agent' }),
    ).toThrow('Invalid theme bridge coverage glob');
  });
});

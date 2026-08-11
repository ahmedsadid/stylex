/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import path from 'path';
import { hashString, shortHash } from '../kernel/hash';
import { canonicalJson, immutableJson } from '../state/json';

export const THEME_DECISION_PROTOCOL_VERSION: string =
  'stylex-migrate-theme-decision-v1';

export type ThemeValue = string | number;

export type ThemeVariantDefinition = {
  +name: string,
  +exportName: string,
};

export type ThemeTokenMapping = {
  +sourcePath: string,
  +targetName: string,
  +values: { +[variant: string]: ThemeValue },
  +existingCssVariable: string | null,
};

export type ThemeTokenMapDefinition = {
  +protocolVersion: string,
  +inventoryId: string,
  +targetModule: string,
  +varsExport: string,
  +defaultVariant: string,
  +variants: $ReadOnlyArray<ThemeVariantDefinition>,
  +tokens: $ReadOnlyArray<ThemeTokenMapping>,
  +sourceFiles: $ReadOnlyArray<string>,
  +consumerFiles: $ReadOnlyArray<string>,
};

export type ThemeDecisionDraft = ThemeTokenMapDefinition & {
  +id: string,
  +definitionHash: string,
  +draftedBy: string,
  +createdAt: string,
};

export type ThemeDecisionApproval = {
  +id: string,
  +protocolVersion: string,
  +draftId: string,
  +definitionHash: string,
  +artifactHash: string,
  +approvedBy: string,
  +approvedAt: string,
  +limitations: $ReadOnlyArray<string>,
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SOURCE_PATH = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;
const CSS_VARIABLE = /^--[A-Za-z0-9_-]+$/;
const PLACEHOLDER = /^(?:todo|fixme|tbd|unknown|placeholder|undefined|null)$/i;

function object(value: mixed): boolean {
  return value != null && !Array.isArray(value) && typeof value === 'object';
}

function strings(value: mixed, allowEmpty: boolean = false): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'string' &&
        (allowEmpty || item !== '') &&
        !item.includes('\0'),
    )
  );
}

function canonicalFile(value: mixed, label: string): string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    value.split('/').some((segment) => segment === '' || segment === '..') ||
    path.posix.normalize(value) !== value
  ) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  return value;
}

function canonicalFiles(value: mixed, label: string): $ReadOnlyArray<string> {
  if (!strings(value)) {
    throw new Error(`Invalid ${label}`);
  }
  const values: $ReadOnlyArray<string> = value as any;
  return Object.freeze(
    [...new Set(values.map((file) => canonicalFile(file, label)))].sort(),
  );
}

function themeValue(value: mixed, label: string): ThemeValue {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (
    typeof value === 'string' &&
    value.trim() !== '' &&
    !PLACEHOLDER.test(value.trim()) &&
    !value.includes('\0')
  ) {
    return value;
  }
  throw new Error(`${label} must be a concrete string or finite number`);
}

function normalizeDefinition(value: mixed): ThemeTokenMapDefinition {
  const definition: $FlowFixMe = value;
  if (
    !object(definition) ||
    definition.protocolVersion !== THEME_DECISION_PROTOCOL_VERSION ||
    typeof definition.inventoryId !== 'string' ||
    definition.inventoryId === '' ||
    typeof definition.varsExport !== 'string' ||
    !IDENTIFIER.test(definition.varsExport) ||
    typeof definition.defaultVariant !== 'string' ||
    definition.defaultVariant === '' ||
    !Array.isArray(definition.variants) ||
    definition.variants.length === 0 ||
    !Array.isArray(definition.tokens) ||
    definition.tokens.length === 0
  ) {
    throw new Error('Invalid theme token-map definition');
  }
  const targetModule = canonicalFile(
    definition.targetModule,
    'theme target module',
  );
  if (!/\.stylex\.(?:js|ts)$/.test(targetModule)) {
    throw new Error('Theme target module must end in .stylex.js or .stylex.ts');
  }
  const variants = definition.variants.map((value) => {
    const variant: $FlowFixMe = value;
    if (
      !object(variant) ||
      typeof variant.name !== 'string' ||
      variant.name === '' ||
      typeof variant.exportName !== 'string' ||
      !IDENTIFIER.test(variant.exportName)
    ) {
      throw new Error('Invalid theme variant definition');
    }
    return Object.freeze({
      name: variant.name,
      exportName: variant.exportName,
    });
  });
  if (
    new Set(variants.map((variant) => variant.name)).size !== variants.length ||
    new Set(variants.map((variant) => variant.exportName)).size !==
      variants.length ||
    variants.some((variant) => variant.exportName === definition.varsExport) ||
    !variants.some((variant) => variant.name === definition.defaultVariant)
  ) {
    throw new Error('Theme variants or exports collide, or default is missing');
  }
  const variantNames = variants.map((variant) => variant.name).sort();
  const tokens = definition.tokens.map((value) => {
    const token: $FlowFixMe = value;
    if (
      !object(token) ||
      typeof token.sourcePath !== 'string' ||
      !SOURCE_PATH.test(token.sourcePath) ||
      typeof token.targetName !== 'string' ||
      !IDENTIFIER.test(token.targetName) ||
      !object(token.values) ||
      !(
        token.existingCssVariable == null ||
        (typeof token.existingCssVariable === 'string' &&
          CSS_VARIABLE.test(token.existingCssVariable))
      )
    ) {
      throw new Error('Invalid theme token mapping');
    }
    const valueNames = Object.keys(token.values).sort();
    if (
      valueNames.length !== variantNames.length ||
      valueNames.some((name, index) => name !== variantNames[index])
    ) {
      throw new Error(
        `Theme token ${token.sourcePath} must define every declared variant exactly once`,
      );
    }
    return Object.freeze({
      sourcePath: token.sourcePath,
      targetName: token.targetName,
      values: Object.freeze(
        Object.fromEntries(
          valueNames.map((name) => [
            name,
            themeValue(
              token.values[name],
              `Theme token ${token.sourcePath} variant ${name}`,
            ),
          ]),
        ),
      ),
      existingCssVariable: token.existingCssVariable ?? null,
    });
  });
  if (
    new Set(tokens.map((token) => token.sourcePath)).size !== tokens.length ||
    new Set(tokens.map((token) => token.targetName)).size !== tokens.length
  ) {
    throw new Error(
      'Theme source paths and target names must be collision-free',
    );
  }
  const sourceFiles = canonicalFiles(
    definition.sourceFiles,
    'theme source files',
  );
  const consumerFiles = canonicalFiles(
    definition.consumerFiles,
    'theme consumer files',
  );
  if (sourceFiles.length === 0 || consumerFiles.length === 0) {
    throw new Error('Theme decisions require source and consumer files');
  }
  if (
    sourceFiles.includes(targetModule) ||
    consumerFiles.includes(targetModule)
  ) {
    throw new Error(
      'Theme target module must be distinct from source and consumer files',
    );
  }
  return immutableJson({
    protocolVersion: THEME_DECISION_PROTOCOL_VERSION,
    inventoryId: definition.inventoryId,
    targetModule,
    varsExport: definition.varsExport,
    defaultVariant: definition.defaultVariant,
    variants: variants.sort((a, b) => a.name.localeCompare(b.name)),
    tokens: tokens.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
    sourceFiles,
    consumerFiles,
  }) as $FlowFixMe;
}

export function createThemeDecisionDraft({
  definition: input,
  draftedBy,
  now = () => new Date().toISOString(),
}: {
  +definition: mixed,
  +draftedBy: string,
  +now?: () => string,
}): ThemeDecisionDraft {
  if (draftedBy.trim() === '') {
    throw new Error('Theme decision draft requires an author');
  }
  const definition = normalizeDefinition(input);
  const definitionHash = hashString(canonicalJson(definition as $FlowFixMe));
  return immutableJson({
    ...definition,
    id: `theme-draft-${shortHash(definitionHash)}`,
    definitionHash,
    draftedBy: draftedBy.trim(),
    createdAt: now(),
  }) as $FlowFixMe;
}

export function validateThemeDecisionDraft(value: mixed): ThemeDecisionDraft {
  const draft: $FlowFixMe = value;
  if (
    !object(draft) ||
    typeof draft.id !== 'string' ||
    typeof draft.definitionHash !== 'string' ||
    typeof draft.draftedBy !== 'string' ||
    draft.draftedBy === '' ||
    typeof draft.createdAt !== 'string'
  ) {
    throw new Error('Invalid theme decision draft');
  }
  const { id, definitionHash, draftedBy, createdAt, ...definitionInput } =
    draft;
  const definition = normalizeDefinition(definitionInput);
  const expectedHash = hashString(canonicalJson(definition as $FlowFixMe));
  if (
    definitionHash !== expectedHash ||
    id !== `theme-draft-${shortHash(expectedHash)}`
  ) {
    throw new Error('Theme decision draft integrity check failed');
  }
  return immutableJson({
    ...definition,
    id,
    definitionHash,
    draftedBy,
    createdAt,
  }) as $FlowFixMe;
}

export function approveThemeDecision({
  draft: input,
  actor,
  approvedBy,
  limitations = [],
  now = () => new Date().toISOString(),
}: {
  +draft: ThemeDecisionDraft,
  +actor: 'human',
  +approvedBy: string,
  +limitations?: $ReadOnlyArray<string>,
  +now?: () => string,
}): ThemeDecisionApproval {
  if (actor !== 'human' || approvedBy.trim() === '') {
    throw new Error('Only a named human may approve a theme decision');
  }
  const draft = validateThemeDecisionDraft(input);
  const stableLimitations = Object.freeze(
    [...new Set(limitations.map((item) => item.trim()))]
      .filter((item) => item !== '')
      .sort(),
  );
  const approvalDefinition = {
    protocolVersion: THEME_DECISION_PROTOCOL_VERSION,
    draftId: draft.id,
    definitionHash: draft.definitionHash,
    approvedBy: approvedBy.trim(),
    limitations: stableLimitations,
  };
  const approvalHash = hashString(
    canonicalJson(approvalDefinition as $FlowFixMe),
  );
  const id = `theme-approval-${shortHash(approvalHash)}`;
  const artifactHash = hashString(
    canonicalJson({
      protocolVersion: THEME_DECISION_PROTOCOL_VERSION,
      draftId: draft.id,
      definitionHash: draft.definitionHash,
      approvalId: id,
      limitations: stableLimitations,
    }),
  );
  return immutableJson({
    ...approvalDefinition,
    id,
    artifactHash,
    approvedAt: now(),
  }) as $FlowFixMe;
}

export function validateThemeDecisionApproval({
  draft: inputDraft,
  approval: inputApproval,
}: {
  +draft: ThemeDecisionDraft,
  +approval: ThemeDecisionApproval,
}): ThemeDecisionApproval {
  const draft = validateThemeDecisionDraft(inputDraft);
  const approval: $FlowFixMe = inputApproval;
  if (
    !object(approval) ||
    approval.protocolVersion !== THEME_DECISION_PROTOCOL_VERSION ||
    approval.draftId !== draft.id ||
    approval.definitionHash !== draft.definitionHash ||
    typeof approval.id !== 'string' ||
    typeof approval.artifactHash !== 'string' ||
    typeof approval.approvedBy !== 'string' ||
    approval.approvedBy === '' ||
    typeof approval.approvedAt !== 'string' ||
    !strings(approval.limitations, true)
  ) {
    throw new Error('Invalid theme decision approval');
  }
  const expected = approveThemeDecision({
    draft,
    actor: 'human',
    approvedBy: approval.approvedBy,
    limitations: approval.limitations,
    now: () => approval.approvedAt,
  });
  if (
    approval.id !== expected.id ||
    approval.artifactHash !== expected.artifactHash ||
    canonicalJson(approval.limitations) !== canonicalJson(expected.limitations)
  ) {
    throw new Error('Theme decision approval integrity check failed');
  }
  return expected;
}

export function relativeThemeModuleSpecifier(
  consumerFile: string,
  targetModule: string,
): string {
  const consumer = canonicalFile(consumerFile, 'theme consumer file');
  const target = canonicalFile(targetModule, 'theme target module');
  let relative = path.posix.relative(path.posix.dirname(consumer), target);
  relative = relative.replace(/\.(?:js|ts)$/, '');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

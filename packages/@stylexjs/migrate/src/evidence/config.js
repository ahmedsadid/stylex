/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  normalizeExpectedRuntimeObservations,
  normalizeRuntimeCases,
} from '../runtime/model';
import type {
  RuntimeCaseDefinition,
  RuntimeExpectedObservations,
} from '../runtime/model';

export type RepositoryCheck = 'focused-test' | 'typecheck' | 'lint' | 'build';
export type RuntimeCheck = 'runtime-render';

export type EvidenceSubjectKind = 'candidate' | 'apply-plan';
export type EvidenceCost = 'cheap' | 'standard' | 'expensive';

export type CommandProviderConfig = {
  +id: string,
  +kind: 'command',
  +check: RepositoryCheck,
  +checkVersion: string,
  +subject: EvidenceSubjectKind,
  +cost: EvidenceCost,
  +argv: $ReadOnlyArray<string>,
  +versionArgv: $ReadOnlyArray<string>,
  +cwd: string,
  +allowedEnv: $ReadOnlyArray<string>,
  +fileGlobs: $ReadOnlyArray<string>,
  +limitations: $ReadOnlyArray<string>,
  +timeoutMs: number,
};

export type RuntimeInterface =
  | 'playwright'
  | 'storybook'
  | 'component-test'
  | 'custom';

export type RuntimeCommandProviderConfig = {
  +id: string,
  +kind: 'runtime-command',
  +check: RuntimeCheck,
  +checkVersion: string,
  +subject: EvidenceSubjectKind,
  +cost: EvidenceCost,
  +runtimeInterface: RuntimeInterface,
  +argv: $ReadOnlyArray<string>,
  +versionArgv: $ReadOnlyArray<string>,
  +cwd: string,
  +allowedEnv: $ReadOnlyArray<string>,
  +fileGlobs: $ReadOnlyArray<string>,
  +limitations: $ReadOnlyArray<string>,
  +timeoutMs: number,
  +cases: $ReadOnlyArray<RuntimeCaseDefinition>,
};

export type GeneratedRuntimeProbeProviderConfig = {
  +id: string,
  +kind: 'generated-runtime-probe',
  +check: RuntimeCheck,
  +checkVersion: string,
  +subject: EvidenceSubjectKind,
  +cost: EvidenceCost,
  +runtimeInterface: RuntimeInterface,
  +argv: $ReadOnlyArray<string>,
  +versionArgv: $ReadOnlyArray<string>,
  +cwd: string,
  +allowedEnv: $ReadOnlyArray<string>,
  +fileGlobs: $ReadOnlyArray<string>,
  +limitations: $ReadOnlyArray<string>,
  +timeoutMs: number,
  +cases: $ReadOnlyArray<RuntimeCaseDefinition>,
  +assumptionArtifactHash: string,
  +expectedObservations: RuntimeExpectedObservations,
};

export type BootstrapRspackProviderConfig = {
  +id: string,
  +kind: 'bootstrap-rspack',
  +check: 'build',
  +checkVersion: string,
  +subject: EvidenceSubjectKind,
  +cost: EvidenceCost,
  +packageManager: 'pnpm' | 'yarn' | 'npm',
  +packageRoot: string,
  +buildCommand: $ReadOnlyArray<string>,
  +argv: $ReadOnlyArray<string>,
  +versionArgv: $ReadOnlyArray<string>,
  +cwd: string,
  +allowedEnv: $ReadOnlyArray<string>,
  +fileGlobs: $ReadOnlyArray<string>,
  +limitations: $ReadOnlyArray<string>,
  +timeoutMs: number,
};

export type EvidenceProviderConfig =
  | CommandProviderConfig
  | RuntimeCommandProviderConfig
  | GeneratedRuntimeProbeProviderConfig
  | BootstrapRspackProviderConfig;

export type EvidenceConfig = {
  +concurrency: number,
  +outputPreviewBytes: number,
  +providers: $ReadOnlyArray<EvidenceProviderConfig>,
};

export const DEFAULT_EVIDENCE_CONFIG: EvidenceConfig = Object.freeze({
  concurrency: 2,
  outputPreviewBytes: 8192,
  providers: Object.freeze([]),
});

const CHECKS = new Set(['focused-test', 'typecheck', 'lint', 'build']);
const RUNTIME_INTERFACES = new Set([
  'playwright',
  'storybook',
  'component-test',
  'custom',
]);
const SUBJECTS = new Set(['candidate', 'apply-plan']);
const COSTS = new Set(['cheap', 'standard', 'expensive']);
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function object(value: mixed): boolean {
  return value != null && !Array.isArray(value) && typeof value === 'object';
}

function nonEmptyStrings(value: mixed): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) => typeof item === 'string' && item !== '' && !item.includes('\0'),
    )
  );
}

function strings(value: mixed): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && !item.includes('\0'))
  );
}

function validRelativeCwd(value: mixed): boolean {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) {
    return false;
  }
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
    return false;
  }
  return !value.split(/[\\/]/).includes('..');
}

function validRelativePath(value: mixed): boolean {
  return typeof value === 'string' && (value === '' || validRelativeCwd(value));
}

function validCommonProvider(provider: $FlowFixMe): boolean {
  return (
    typeof provider.id === 'string' &&
    PROVIDER_ID.test(provider.id) &&
    typeof provider.checkVersion === 'string' &&
    provider.checkVersion !== '' &&
    SUBJECTS.has(provider.subject) &&
    COSTS.has(provider.cost) &&
    nonEmptyStrings(provider.argv) &&
    nonEmptyStrings(provider.versionArgv) &&
    validRelativeCwd(provider.cwd) &&
    strings(provider.allowedEnv) &&
    provider.allowedEnv.includes('PATH') &&
    provider.allowedEnv.every((key) => ENVIRONMENT_KEY.test(key)) &&
    new Set(provider.allowedEnv).size === provider.allowedEnv.length &&
    nonEmptyStrings(provider.fileGlobs) &&
    strings(provider.limitations) &&
    typeof provider.timeoutMs === 'number' &&
    Number.isInteger(provider.timeoutMs) &&
    provider.timeoutMs >= 1 &&
    provider.timeoutMs <= 60 * 60 * 1000
  );
}

function commonFields(provider: $FlowFixMe): $FlowFixMe {
  return {
    id: provider.id,
    checkVersion: provider.checkVersion,
    subject: provider.subject,
    cost: provider.cost,
    argv: Object.freeze([...provider.argv]),
    versionArgv: Object.freeze([...provider.versionArgv]),
    cwd: provider.cwd,
    allowedEnv: Object.freeze([...provider.allowedEnv].sort()),
    fileGlobs: Object.freeze([...provider.fileGlobs]),
    limitations: Object.freeze([...provider.limitations]),
    timeoutMs: provider.timeoutMs,
  };
}

function bootstrapFields(provider: $FlowFixMe): $FlowFixMe {
  return commonFields({
    ...provider,
    argv: ['stylex-migrate', 'internal', 'bootstrap-rspack'],
    versionArgv: ['stylex-migrate', '--version'],
  });
}

function normalizeProvider(value: mixed): EvidenceProviderConfig {
  const provider: $FlowFixMe = value;
  if (
    !object(provider) ||
    !validCommonProvider(
      provider.kind === 'bootstrap-rspack'
        ? {
            ...provider,
            argv: ['stylex-migrate', 'internal', 'bootstrap-rspack'],
            versionArgv: ['stylex-migrate', '--version'],
          }
        : provider,
    )
  ) {
    throw new Error('Invalid repository evidence provider configuration');
  }
  if (provider.kind === 'command' && CHECKS.has(provider.check)) {
    return Object.freeze({
      ...commonFields(provider),
      kind: 'command',
      check: provider.check,
    });
  }
  if (
    (provider.kind === 'runtime-command' ||
      provider.kind === 'generated-runtime-probe') &&
    provider.check === 'runtime-render' &&
    RUNTIME_INTERFACES.has(provider.runtimeInterface)
  ) {
    if (
      provider.kind === 'generated-runtime-probe' &&
      (typeof provider.assumptionArtifactHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(provider.assumptionArtifactHash))
    ) {
      throw new Error('Invalid generated runtime probe assumption hash');
    }
    return Object.freeze({
      ...commonFields(provider),
      kind: provider.kind,
      check: 'runtime-render',
      runtimeInterface: provider.runtimeInterface,
      cases: normalizeRuntimeCases(provider.cases),
      ...(provider.kind === 'generated-runtime-probe'
        ? {
            assumptionArtifactHash: provider.assumptionArtifactHash,
            expectedObservations: normalizeExpectedRuntimeObservations(
              provider.expectedObservations,
            ),
          }
        : {}),
    });
  }
  if (
    provider.kind === 'bootstrap-rspack' &&
    provider.check === 'build' &&
    (provider.packageManager === 'pnpm' ||
      provider.packageManager === 'yarn' ||
      provider.packageManager === 'npm') &&
    validRelativePath(provider.packageRoot) &&
    nonEmptyStrings(provider.buildCommand)
  ) {
    return Object.freeze({
      ...bootstrapFields(provider),
      kind: 'bootstrap-rspack',
      check: 'build',
      packageManager: provider.packageManager,
      packageRoot: provider.packageRoot,
      buildCommand: Object.freeze([...provider.buildCommand]),
    });
  }
  throw new Error('Invalid repository evidence provider configuration');
}

export function isRepositoryCheckProvider(
  provider: EvidenceProviderConfig,
): boolean {
  return provider.kind === 'command' || provider.kind === 'bootstrap-rspack';
}

export function normalizeEvidenceConfig(value?: mixed): EvidenceConfig {
  if (value == null) {
    return DEFAULT_EVIDENCE_CONFIG;
  }
  const config: $FlowFixMe = value;
  if (
    !object(config) ||
    typeof config.concurrency !== 'number' ||
    !Number.isInteger(config.concurrency) ||
    config.concurrency < 1 ||
    config.concurrency > 32 ||
    typeof config.outputPreviewBytes !== 'number' ||
    !Number.isInteger(config.outputPreviewBytes) ||
    config.outputPreviewBytes < 256 ||
    config.outputPreviewBytes > 1024 * 1024 ||
    !Array.isArray(config.providers)
  ) {
    throw new Error('Invalid repository evidence configuration');
  }
  const providers = config.providers.map(normalizeProvider);
  if (
    new Set(providers.map((provider) => provider.id)).size !== providers.length
  ) {
    throw new Error('Repository evidence provider ids must be unique');
  }
  return Object.freeze({
    concurrency: config.concurrency,
    outputPreviewBytes: config.outputPreviewBytes,
    providers: Object.freeze(providers),
  });
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

export type RepositoryCheck = 'focused-test' | 'typecheck' | 'lint' | 'build';

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
  +timeoutMs: number,
};

export type EvidenceProviderConfig = CommandProviderConfig;

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

function normalizeProvider(value: mixed): CommandProviderConfig {
  const provider: $FlowFixMe = value;
  if (
    !object(provider) ||
    provider.kind !== 'command' ||
    typeof provider.id !== 'string' ||
    !PROVIDER_ID.test(provider.id) ||
    !CHECKS.has(provider.check) ||
    typeof provider.checkVersion !== 'string' ||
    provider.checkVersion === '' ||
    !SUBJECTS.has(provider.subject) ||
    !COSTS.has(provider.cost) ||
    !nonEmptyStrings(provider.argv) ||
    !nonEmptyStrings(provider.versionArgv) ||
    !validRelativeCwd(provider.cwd) ||
    !strings(provider.allowedEnv) ||
    !provider.allowedEnv.includes('PATH') ||
    !provider.allowedEnv.every((key) => ENVIRONMENT_KEY.test(key)) ||
    new Set(provider.allowedEnv).size !== provider.allowedEnv.length ||
    !nonEmptyStrings(provider.fileGlobs) ||
    typeof provider.timeoutMs !== 'number' ||
    !Number.isInteger(provider.timeoutMs) ||
    provider.timeoutMs < 1 ||
    provider.timeoutMs > 60 * 60 * 1000
  ) {
    throw new Error('Invalid repository evidence provider configuration');
  }
  return Object.freeze({
    id: provider.id,
    kind: 'command',
    check: provider.check,
    checkVersion: provider.checkVersion,
    subject: provider.subject,
    cost: provider.cost,
    argv: Object.freeze([...provider.argv]),
    versionArgv: Object.freeze([...provider.versionArgv]),
    cwd: provider.cwd,
    allowedEnv: Object.freeze([...provider.allowedEnv].sort()),
    fileGlobs: Object.freeze([...provider.fileGlobs]),
    timeoutMs: provider.timeoutMs,
  });
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

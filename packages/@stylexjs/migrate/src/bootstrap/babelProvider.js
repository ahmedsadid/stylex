/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  evidenceCommandDirectory,
  fullEvidenceOutput,
  previewEvidenceOutput,
  repositoryEvidenceIdentity,
  runEvidenceProcess,
  selectedEvidenceEnvironment,
} from '../evidence/command';
import { hashBytes } from '../kernel/hash';
import type {
  CommandExecution,
  CommandExecutionContext,
  ProcessResult,
} from '../evidence/command';
import type { BootstrapBabelProviderConfig } from '../evidence/config';

export const BABEL_SENTINEL_CHECK_VERSION: string =
  'stylex-babel-emitted-css-v1';
export const BABEL_SENTINEL_LIMITATION: string =
  'The Babel sentinel and repository build are separate checks in one candidate workspace. The sentinel proves StyleX transformation, CSS metadata emission, and runtime-injection output; the repository build proves only that the exact application paths credited by this provider compiled successfully.';

export function bootstrapBabelProviderId(inspectionId: string): string {
  return `stylex-bootstrap-babel-${inspectionId}`;
}

function installArgv(
  packageManager: 'pnpm' | 'yarn' | 'npm',
): $ReadOnlyArray<string> {
  if (packageManager === 'pnpm') {
    return [
      'corepack',
      'pnpm',
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
    ];
  }
  if (packageManager === 'yarn') {
    return [
      'corepack',
      'yarn',
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
    ];
  }
  return ['npm', 'ci', '--ignore-scripts'];
}

function emptyResult(): ProcessResult {
  return {
    exitCode: null,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    error: null,
    timedOut: false,
  };
}

function sentinelProgram(): string {
  return String.raw`
'use strict';
const {transformSync} = require('@babel/core');
const pluginModule = require('@stylexjs/babel-plugin');
const plugin = pluginModule.default || pluginModule;
const source = [
  "import * as stylex from '@stylexjs/stylex';",
  "const styles = stylex.create({sentinel: {color: 'rgb(1, 2, 3)'}});",
  "export const className = stylex.props(styles.sentinel).className;",
].join('\n');
const result = transformSync(source, {
  babelrc: false,
  configFile: false,
  filename: 'stylex-migrate-sentinel.js',
  plugins: [[plugin, {dev: false, runtimeInjection: true}]],
});
const code = result && result.code || '';
const styles = result && result.metadata && result.metadata.stylex || [];
const css = styles.map(item => item[1] && item[1].ltr || '').join('\n');
const emittedDeclaration = /color\s*:\s*(?:#010203|rgb\(\s*1\s*,\s*2\s*,\s*3\s*\))/i.test(css);
const transformed = !code.includes('stylex.create') && styles.length > 0;
const runtimeInjected = code.includes('stylex-inject');
if (!emittedDeclaration || !transformed || !runtimeInjected) {
  throw new Error('Babel sentinel did not transform StyleX, emit CSS metadata, and inject the runtime stylesheet call');
}
process.stdout.write(JSON.stringify({
  emittedCssBytes: Buffer.byteLength(css),
  runtimeInjection: true,
  transformedJavaScript: true,
}) + '\n');
`;
}

function failure(label: string, result: ProcessResult): string {
  if (result.timedOut) return `${label} timed out`;
  if (result.error != null)
    return `${label} unavailable: ${result.error.message}`;
  return `${label} exited ${String(result.exitCode)}`;
}

export async function runBootstrapBabelProvider(
  config: BootstrapBabelProviderConfig,
  context: CommandExecutionContext,
): Promise<CommandExecution> {
  const now = context.now ?? (() => new Date().toISOString());
  const monotonicNow = context.monotonicNow ?? (() => Date.now());
  const startedAt = now();
  const started = monotonicNow();
  const platform = Object.freeze({
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
  });
  const environment = selectedEvidenceEnvironment(
    config.allowedEnv,
    context.environment ?? process.env,
  );
  const invocation = Object.freeze([
    'stylex-migrate',
    'internal',
    'bootstrap-babel',
    '--package-manager',
    config.packageManager,
    '--package-root',
    config.packageRoot || '.',
  ]);
  const versionArgv = Object.freeze(['stylex-migrate', '--version']);
  const cached = await context.lookupCached?.({
    providerVersion: BABEL_SENTINEL_CHECK_VERSION,
    argv: invocation,
    versionArgv,
    cwd: config.cwd,
    allowedEnvKeys: config.allowedEnv,
    environmentFingerprint: environment.fingerprint,
    platform,
  });
  if (cached != null) return cached;

  let install = emptyResult();
  let sentinel = emptyResult();
  let build = emptyResult();
  let result: 'pass' | 'fail' | 'unavailable' = 'pass';
  let detail =
    'Locked dependencies installed; Babel transformed the StyleX sentinel, emitted CSS metadata and runtime injection; the repository application build passed.';
  let commandCwd = config.cwd;
  try {
    const installCwd = evidenceCommandDirectory(
      context.workspaceRoot,
      config.cwd,
    );
    const packageCwd = evidenceCommandDirectory(
      context.workspaceRoot,
      config.packageRoot || '.',
    );
    install = await runEvidenceProcess({
      argv: installArgv(config.packageManager),
      cwd: installCwd,
      environment: environment.values,
      timeoutMs: config.timeoutMs,
    });
    if (install.error != null || install.timedOut || install.exitCode !== 0) {
      result = install.error == null ? 'fail' : 'unavailable';
      detail = failure('dependency installation', install);
    } else {
      commandCwd = config.packageRoot || '.';
      sentinel = await runEvidenceProcess({
        argv: [process.execPath, '-e', sentinelProgram()],
        cwd: packageCwd,
        environment: environment.values,
        timeoutMs: config.timeoutMs,
      });
      if (
        sentinel.error != null ||
        sentinel.timedOut ||
        sentinel.exitCode !== 0
      ) {
        result = sentinel.error == null ? 'fail' : 'unavailable';
        detail = failure('Babel sentinel compilation', sentinel);
      } else {
        build = await runEvidenceProcess({
          argv: config.buildCommand,
          cwd: installCwd,
          environment: environment.values,
          timeoutMs: config.timeoutMs,
        });
        if (build.error != null || build.timedOut || build.exitCode !== 0) {
          result = build.error == null ? 'fail' : 'unavailable';
          detail = failure('repository application build', build);
        }
      }
    }
  } catch (error) {
    result = 'unavailable';
    detail = error instanceof Error ? error.message : String(error);
  }
  const output = Buffer.concat([
    Buffer.from('[dependency-install]\n'),
    fullEvidenceOutput(install),
    Buffer.from('\n[babel-sentinel]\n'),
    fullEvidenceOutput(sentinel),
    Buffer.from('\n[repository-build]\n'),
    fullEvidenceOutput(build),
  ]);
  const command = Object.freeze({
    argv: invocation,
    versionArgv,
    cwd: commandCwd,
    allowedEnvKeys: config.allowedEnv,
    environmentFingerprint: environment.fingerprint,
    exitCode: build.exitCode ?? sentinel.exitCode ?? install.exitCode,
  });
  const stable = {
    check: config.check,
    checkVersion: config.checkVersion,
    provider: config.id,
    providerVersion: BABEL_SENTINEL_CHECK_VERSION,
    subject: context.subject,
    result,
    command,
    platform,
    outputHash: hashBytes(output),
    outputSize: output.length,
    limitations: config.limitations,
    detail,
  };
  const provisional = {
    id: '',
    ...stable,
    startedAt,
    durationMs: Math.max(0, monotonicNow() - started),
    outputPreview: previewEvidenceOutput(
      output,
      context.outputPreviewBytes ?? 8192,
    ),
  };
  return Object.freeze({
    evidence: Object.freeze({
      ...provisional,
      id: repositoryEvidenceIdentity(provisional),
    }),
    fullOutput: output,
  });
}

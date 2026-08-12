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
import type { BootstrapRspackProviderConfig } from '../evidence/config';

export const RSPACK_SENTINEL_CHECK_VERSION: string =
  'stylex-rspack-emitted-css-v2';
export const RSPACK_SENTINEL_LIMITATION: string =
  'The sentinel and repository build are separate checks in one candidate workspace. The sentinel proves StyleX transformation and CSS emission; the repository build proves only that the exact application paths credited by this provider compiled successfully.';

export function bootstrapRspackProviderId(inspectionId: string): string {
  return `stylex-bootstrap-rspack-${inspectionId}`;
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

function emptyProcessResult(): ProcessResult {
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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageRoot = process.cwd();
const resolveFromPackage = name => require.resolve(name, {paths: [packageRoot]});
const rspackModule = require(resolveFromPackage('@rspack/core'));
const unpluginModule = require(resolveFromPackage('@stylexjs/unplugin'));
const rspack = rspackModule.rspack || rspackModule.default || rspackModule;
const stylexPlugin = unpluginModule.default || unpluginModule;
if (typeof rspack !== 'function' || typeof stylexPlugin.rspack !== 'function') {
  throw new Error('Rspack or the StyleX Rspack adapter is not callable');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stylex-migrate-sentinel-'));
const output = path.join(root, 'dist');
const entry = path.join(root, 'sentinel.js');
const moduleDirectories = [];
for (let current = packageRoot; ; current = path.dirname(current)) {
  moduleDirectories.push(path.join(current, 'node_modules'));
  if (path.dirname(current) === current) break;
}
fs.writeFileSync(entry, [
  "import * as stylex from '@stylexjs/stylex';",
  "const styles = stylex.create({sentinel: {color: 'rgb(1, 2, 3)'}});",
  "export const className = stylex.props(styles.sentinel).className;",
  '',
].join('\n'));

class SeedCssAssetPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('stylex-migrate-sentinel-seed', compilation => {
      compilation.hooks.processAssets.tap(
        {
          name: 'stylex-migrate-sentinel-seed',
          stage: rspackModule.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        () => compilation.emitAsset(
          'style.css',
          new rspackModule.sources.RawSource('/* stylex-migrate-sentinel-seed */\n'),
        ),
      );
    });
  }
}

const compiler = rspack({
  mode: 'production',
  context: packageRoot,
  entry,
  output: {path: output, filename: 'sentinel.js'},
  resolve: {modules: moduleDirectories},
  plugins: [new SeedCssAssetPlugin(), stylexPlugin.rspack({dev: false})],
});
compiler.run((error, stats) => {
  compiler.close(() => {});
  try {
    if (error) throw error;
    if (!stats || stats.hasErrors()) {
      throw new Error(stats ? stats.toString({colors: false}) : 'Rspack returned no stats');
    }
    const cssPath = path.join(output, 'style.css');
    const jsPath = path.join(output, 'sentinel.js');
    const css = fs.readFileSync(cssPath, 'utf8');
    const js = fs.readFileSync(jsPath, 'utf8');
    const emittedDeclaration = /color\s*:\s*(?:#010203|rgb\(\s*1\s*,\s*2\s*,\s*3\s*\))/i.test(css);
    const transformedCall = !js.includes('stylex.create') && !js.includes("@stylexjs/stylex");
    if (!emittedDeclaration || !transformedCall) {
      throw new Error('Sentinel did not produce transformed JavaScript and the expected CSS declaration');
    }
    process.stdout.write(JSON.stringify({
      emittedCssBytes: Buffer.byteLength(css),
      transformedJavaScript: true,
    }) + '\n');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
`;
}

function combinedOutput(
  install: ProcessResult,
  sentinel: ProcessResult,
  repositoryBuild: ProcessResult,
): Buffer {
  return Buffer.concat([
    Buffer.from('[dependency-install]\n'),
    fullEvidenceOutput(install),
    Buffer.from('\n[rspack-sentinel]\n'),
    fullEvidenceOutput(sentinel),
    Buffer.from('\n[repository-build]\n'),
    fullEvidenceOutput(repositoryBuild),
  ]);
}

function failureDetail(label: string, result: ProcessResult): string {
  if (result.timedOut) return `${label} timed out`;
  if (result.error != null)
    return `${label} unavailable: ${result.error.message}`;
  return `${label} exited ${String(result.exitCode)}`;
}

export async function runBootstrapRspackProvider(
  config: BootstrapRspackProviderConfig,
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
  const install = installArgv(config.packageManager);
  const invocation = Object.freeze([
    'stylex-migrate',
    'internal',
    'bootstrap-rspack',
    '--package-manager',
    config.packageManager,
    '--package-root',
    config.packageRoot || '.',
  ]);
  const versionArgv = Object.freeze(['stylex-migrate', '--version']);
  const providerVersion = RSPACK_SENTINEL_CHECK_VERSION;
  const cached = await context.lookupCached?.(
    Object.freeze({
      providerVersion,
      argv: invocation,
      versionArgv,
      cwd: config.cwd,
      allowedEnvKeys: config.allowedEnv,
      environmentFingerprint: environment.fingerprint,
      platform,
    }),
  );
  if (cached != null) return cached;

  let installResult = emptyProcessResult();
  let sentinelResult = emptyProcessResult();
  let buildResult = emptyProcessResult();
  let result: 'pass' | 'fail' | 'unavailable' | 'not-applicable' = 'pass';
  let detail =
    'Locked dependencies installed; StyleX transformed the sentinel and emitted CSS; the repository application build passed.';
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
    installResult = await runEvidenceProcess({
      argv: install,
      cwd: installCwd,
      environment: environment.values,
      timeoutMs: config.timeoutMs,
    });
    if (
      installResult.error != null ||
      installResult.timedOut ||
      installResult.exitCode !== 0
    ) {
      result = installResult.error == null ? 'fail' : 'unavailable';
      detail = failureDetail('dependency installation', installResult);
    } else {
      commandCwd = config.packageRoot || '.';
      sentinelResult = await runEvidenceProcess({
        argv: [process.execPath, '-e', sentinelProgram()],
        cwd: packageCwd,
        environment: environment.values,
        timeoutMs: config.timeoutMs,
      });
      if (
        sentinelResult.error != null ||
        sentinelResult.timedOut ||
        sentinelResult.exitCode !== 0
      ) {
        result = sentinelResult.error == null ? 'fail' : 'unavailable';
        detail = failureDetail('Rspack sentinel compilation', sentinelResult);
      } else {
        buildResult = await runEvidenceProcess({
          argv: config.buildCommand,
          cwd: installCwd,
          environment: environment.values,
          timeoutMs: config.timeoutMs,
        });
        if (
          buildResult.error != null ||
          buildResult.timedOut ||
          buildResult.exitCode !== 0
        ) {
          result = buildResult.error == null ? 'fail' : 'unavailable';
          detail = failureDetail('repository application build', buildResult);
        }
      }
    }
  } catch (error) {
    result = 'unavailable';
    detail = error instanceof Error ? error.message : String(error);
  }

  const output = combinedOutput(installResult, sentinelResult, buildResult);
  const command = Object.freeze({
    argv: invocation,
    versionArgv,
    cwd: commandCwd,
    allowedEnvKeys: config.allowedEnv,
    environmentFingerprint: environment.fingerprint,
    exitCode:
      buildResult.exitCode ?? sentinelResult.exitCode ?? installResult.exitCode,
  });
  const stable = {
    check: config.check,
    checkVersion: config.checkVersion,
    provider: config.id,
    providerVersion,
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
  const evidence = Object.freeze({
    ...provisional,
    id: repositoryEvidenceIdentity(provisional),
  });
  return Object.freeze({ evidence, fullOutput: output });
}

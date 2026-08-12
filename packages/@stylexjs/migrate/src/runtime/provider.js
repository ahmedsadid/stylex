/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { hashBytes } from '../kernel/hash';
import {
  evidenceCommandDirectory,
  expandEvidenceArgv,
  fullEvidenceOutput,
  previewEvidenceOutput,
  repositoryEvidenceIdentity,
  runEvidenceProcess,
  selectedEvidenceEnvironment,
} from '../evidence/command';
import { compareRuntimeReports, normalizeRuntimeReport } from './model';
import type {
  CommandExecution,
  CommandExecutionContext,
  CommandRecord,
  ProcessResult,
  RepositoryEvidenceResult,
} from '../evidence/command';
import type { RuntimeCommandProviderConfig } from '../evidence/config';
import type { RuntimeComparison } from './model';

function emptyProcess(error: Error): ProcessResult {
  return {
    exitCode: null,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    error,
    timedOut: false,
  };
}

function versionText(result: ProcessResult): string | null {
  if (result.error != null || result.timedOut || result.exitCode !== 0) {
    return null;
  }
  const value = Buffer.concat([result.stdout, result.stderr])
    .toString('utf8')
    .trim();
  return value === '' ? null : value;
}

function commandRecord({
  config,
  argv,
  environmentFingerprint,
  result,
}: {
  +config: RuntimeCommandProviderConfig,
  +argv: $ReadOnlyArray<string>,
  +environmentFingerprint: string,
  +result: ProcessResult,
}): CommandRecord {
  return Object.freeze({
    argv,
    versionArgv: config.versionArgv,
    cwd: config.cwd,
    allowedEnvKeys: config.allowedEnv,
    environmentFingerprint,
    exitCode: result.exitCode,
  });
}

function outputFor(baseline: ProcessResult, candidate: ProcessResult): Buffer {
  return Buffer.concat([
    Buffer.from('[baseline]\n'),
    fullEvidenceOutput(baseline),
    Buffer.from('\n[candidate]\n'),
    fullEvidenceOutput(candidate),
  ]);
}

function caseScopeProblem(
  config: RuntimeCommandProviderConfig,
  context: CommandExecutionContext,
): string | null {
  const changes = new Map(
    context.subject.changes.map((change) => [change.path, change]),
  );
  for (const runtimeCase of config.cases) {
    for (const changePath of runtimeCase.changePaths) {
      if (!changes.has(changePath)) {
        return `runtime case ${runtimeCase.id} names unchanged path ${changePath}`;
      }
    }
    const declaredSites = new Set(
      runtimeCase.changePaths.flatMap(
        (changePath) => changes.get(changePath)?.siteIds ?? [],
      ),
    );
    for (const siteId of runtimeCase.siteIds) {
      if (!declaredSites.has(siteId)) {
        return `runtime case ${runtimeCase.id} names unknown site ${siteId}`;
      }
    }
  }
  return null;
}

export async function runRuntimeCommandProvider(
  config: RuntimeCommandProviderConfig,
  context: CommandExecutionContext,
): Promise<CommandExecution> {
  const startedAt = (context.now ?? (() => new Date().toISOString()))();
  const monotonicNow = context.monotonicNow ?? (() => Date.now());
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
  const argv = expandEvidenceArgv(config.argv, context.subject);
  let baselineResult = emptyProcess(
    new Error('baseline runtime workspace was unavailable'),
  );
  let candidateResult = emptyProcess(
    new Error('candidate runtime workspace was unavailable'),
  );
  let providerVersion = 'unavailable';
  let result: 'pass' | 'fail' | 'unavailable' | 'not-applicable';
  let detail;
  let comparison: RuntimeComparison | null = null;

  if (config.subject !== context.subject.kind) {
    result = 'not-applicable';
    detail = `provider requires a ${config.subject} subject`;
  } else if (context.baselineWorkspaceRoot == null) {
    result = 'unavailable';
    detail = 'runtime comparison requires a retained baseline workspace';
  } else {
    try {
      const baselineCwd = evidenceCommandDirectory(
        context.baselineWorkspaceRoot,
        config.cwd,
      );
      const candidateCwd = evidenceCommandDirectory(
        context.workspaceRoot,
        config.cwd,
      );
      const version = await runEvidenceProcess({
        argv: config.versionArgv,
        cwd: candidateCwd,
        environment: environment.values,
        timeoutMs: Math.min(Math.max(config.timeoutMs, 1000), 30000),
      });
      const reportedVersion = versionText(version);
      if (reportedVersion == null) {
        candidateResult = version;
        result = 'unavailable';
        detail = version.timedOut
          ? 'runtime provider version command timed out'
          : (version.error?.message ??
            `runtime provider version command exited ${String(version.exitCode)}`);
      } else {
        providerVersion = reportedVersion;
        const scopeProblem = caseScopeProblem(config, context);
        if (scopeProblem != null) {
          result = 'fail';
          detail = scopeProblem;
        } else {
          baselineResult = await runEvidenceProcess({
            argv,
            cwd: baselineCwd,
            environment: environment.values,
            timeoutMs: config.timeoutMs,
          });
          candidateResult = await runEvidenceProcess({
            argv,
            cwd: candidateCwd,
            environment: environment.values,
            timeoutMs: config.timeoutMs,
          });
          const unavailable = [baselineResult, candidateResult].find(
            (execution) => execution.error != null,
          );
          const failed = [baselineResult, candidateResult].find(
            (execution) => execution.timedOut || execution.exitCode !== 0,
          );
          if (unavailable != null) {
            result = 'unavailable';
            detail = unavailable.error?.message;
          } else if (failed != null) {
            result = 'fail';
            detail = failed.timedOut
              ? `runtime provider timed out after ${config.timeoutMs}ms`
              : `runtime provider exited ${String(failed.exitCode)}`;
          } else {
            try {
              const baselineReport = normalizeRuntimeReport(
                JSON.parse(baselineResult.stdout.toString('utf8')),
              );
              const candidateReport = normalizeRuntimeReport(
                JSON.parse(candidateResult.stdout.toString('utf8')),
              );
              comparison = compareRuntimeReports({
                cases: config.cases,
                baseline: baselineReport,
                candidate: candidateReport,
              });
              result =
                comparison.result === 'matched'
                  ? 'pass'
                  : comparison.result === 'incomparable'
                    ? 'unavailable'
                    : 'fail';
              if (comparison.result !== 'matched') {
                detail = `runtime comparison was ${comparison.result}`;
              }
            } catch (error) {
              result = 'fail';
              detail = `invalid runtime report: ${
                error instanceof Error ? error.message : String(error)
              }`;
            }
          }
        }
      }
    } catch (error) {
      result = 'unavailable';
      detail = error instanceof Error ? error.message : String(error);
    }
  }

  const output = outputFor(baselineResult, candidateResult);
  const durationMs = Math.max(0, monotonicNow() - started);
  const baselineCommand = commandRecord({
    config,
    argv,
    environmentFingerprint: environment.fingerprint,
    result: baselineResult,
  });
  const candidateCommand = commandRecord({
    config,
    argv,
    environmentFingerprint: environment.fingerprint,
    result: candidateResult,
  });
  const stable = {
    check: config.check,
    checkVersion: config.checkVersion,
    provider: config.id,
    providerVersion,
    subject: context.subject,
    result,
    command: candidateCommand,
    platform,
    outputHash: hashBytes(output),
    outputSize: output.length,
    limitations: Object.freeze([
      ...new Set([...config.limitations, ...(comparison?.limitations ?? [])]),
    ]),
  };
  const runtime =
    comparison == null
      ? null
      : Object.freeze({
          baselineKind: 'retained-repository',
          runtimeInterface: config.runtimeInterface,
          baselineCommand,
          candidateCommand,
          comparison,
        });
  const timed = {
    startedAt,
    durationMs,
    outputPreview: previewEvidenceOutput(
      output,
      context.outputPreviewBytes ?? 8192,
    ),
  };
  let provisional: RepositoryEvidenceResult;
  if (runtime == null) {
    provisional = {
      id: '',
      ...stable,
      ...timed,
      ...(detail == null ? {} : { detail }),
    };
  } else {
    provisional = {
      id: '',
      ...stable,
      ...timed,
      runtime,
      ...(detail == null ? {} : { detail }),
    };
  }
  const evidence = Object.freeze({
    ...provisional,
    id: repositoryEvidenceIdentity(provisional),
  });
  return Object.freeze({ evidence, fullOutput: output });
}

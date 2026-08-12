/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { hashBytes, hashString } from '../kernel/hash';
import { canonicalJson } from '../state/json';
import {
  evidenceCommandDirectory,
  expandEvidenceArgv,
  fullEvidenceOutput,
  previewEvidenceOutput,
  repositoryEvidenceIdentity,
  runEvidenceProcess,
  selectedEvidenceEnvironment,
} from '../evidence/command';
import {
  compareExpectedRuntimeObservations,
  normalizeRuntimeReport,
} from './model';
import type {
  CommandExecution,
  CommandExecutionContext,
  CommandRecord,
  ProcessResult,
} from '../evidence/command';
import type { GeneratedRuntimeProbeProviderConfig } from '../evidence/config';

function commandRecord(
  config: GeneratedRuntimeProbeProviderConfig,
  argv: $ReadOnlyArray<string>,
  environmentFingerprint: string,
  exitCode: number | null,
): CommandRecord {
  return Object.freeze({
    argv,
    versionArgv: config.versionArgv,
    cwd: config.cwd,
    allowedEnvKeys: config.allowedEnv,
    environmentFingerprint,
    exitCode,
  });
}

function emptyProcess(): ProcessResult {
  return {
    exitCode: null,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    error: null,
    timedOut: false,
  };
}

function caseScopeProblem(
  config: GeneratedRuntimeProbeProviderConfig,
  context: CommandExecutionContext,
): string | null {
  const changes = new Map(
    context.subject.changes.map((change) => [change.path, change]),
  );
  if (
    !context.subject.assumptionArtifactHashes?.includes(
      config.assumptionArtifactHash,
    )
  ) {
    return 'generated runtime probe assumption is not bound to the evidence subject';
  }
  for (const runtimeCase of config.cases) {
    for (const changePath of runtimeCase.changePaths) {
      if (!changes.has(changePath)) {
        return `runtime case ${runtimeCase.id} names unchanged path ${changePath}`;
      }
    }
    const sites = new Set(
      runtimeCase.changePaths.flatMap(
        (changePath) => changes.get(changePath)?.siteIds ?? [],
      ),
    );
    for (const siteId of runtimeCase.siteIds) {
      if (!sites.has(siteId)) {
        return `runtime case ${runtimeCase.id} names unknown site ${siteId}`;
      }
    }
  }
  return null;
}

export async function runGeneratedRuntimeProbeProvider(
  config: GeneratedRuntimeProbeProviderConfig,
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
  const cwd = evidenceCommandDirectory(context.workspaceRoot, config.cwd);
  let providerVersion = 'unavailable';
  let result: 'pass' | 'fail' | 'unavailable' | 'not-applicable';
  let detail;
  let comparison = null;
  let candidate = emptyProcess();

  if (config.subject !== context.subject.kind) {
    result = 'not-applicable';
    detail = `provider requires a ${config.subject} subject`;
  } else {
    const scopeProblem = caseScopeProblem(config, context);
    if (scopeProblem != null) {
      result = 'fail';
      detail = scopeProblem;
    } else {
      const version = await runEvidenceProcess({
        argv: config.versionArgv,
        cwd,
        environment: environment.values,
        timeoutMs: Math.min(Math.max(config.timeoutMs, 1000), 30000),
      });
      const versionOutput = Buffer.concat([version.stdout, version.stderr])
        .toString('utf8')
        .trim();
      if (
        version.error != null ||
        version.timedOut ||
        version.exitCode !== 0 ||
        versionOutput === ''
      ) {
        candidate = version;
        result = 'unavailable';
        detail =
          version.error?.message ??
          (version.timedOut
            ? 'generated runtime probe version command timed out'
            : `generated runtime probe version command exited ${String(version.exitCode)}`);
      } else {
        providerVersion = versionOutput;
        candidate = await runEvidenceProcess({
          argv,
          cwd,
          environment: environment.values,
          timeoutMs: config.timeoutMs,
        });
        if (candidate.error != null) {
          result = 'unavailable';
          detail = candidate.error.message;
        } else if (candidate.timedOut || candidate.exitCode !== 0) {
          result = 'fail';
          detail = candidate.timedOut
            ? `generated runtime probe timed out after ${config.timeoutMs}ms`
            : `generated runtime probe exited ${String(candidate.exitCode)}`;
        } else {
          try {
            comparison = compareExpectedRuntimeObservations({
              cases: config.cases,
              expected: config.expectedObservations,
              candidate: normalizeRuntimeReport(
                JSON.parse(candidate.stdout.toString('utf8')),
              ),
            });
            result =
              comparison.result === 'matched'
                ? 'pass'
                : comparison.result === 'incomparable'
                  ? 'unavailable'
                  : 'fail';
            if (comparison.result !== 'matched') {
              detail = `generated runtime comparison was ${comparison.result}`;
            }
          } catch (error) {
            result = 'fail';
            detail = `invalid generated runtime report: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        }
      }
    }
  }

  const output = Buffer.concat([
    Buffer.from('[expected-observations]\n'),
    Buffer.from(canonicalJson(config.expectedObservations as $FlowFixMe)),
    Buffer.from('\n[candidate]\n'),
    fullEvidenceOutput(candidate),
  ]);
  const candidateCommand = commandRecord(
    config,
    argv,
    environment.fingerprint,
    candidate.exitCode,
  );
  const expectedReportHash = hashString(
    canonicalJson(config.expectedObservations as $FlowFixMe),
  );
  const stable = {
    id: '',
    check: config.check,
    checkVersion: config.checkVersion,
    provider: config.id,
    providerVersion,
    subject: context.subject,
    result,
    command: candidateCommand,
    platform,
    startedAt,
    durationMs: Math.max(0, monotonicNow() - started),
    outputHash: hashBytes(output),
    outputSize: output.length,
    outputPreview: previewEvidenceOutput(
      output,
      context.outputPreviewBytes ?? 8192,
    ),
    limitations: Object.freeze([
      ...new Set([
        ...config.limitations,
        'Generated expected observations are bound test assumptions, not retained repository behavior or owner approval.',
        ...(comparison?.limitations ?? []),
      ]),
    ]),
  };
  const runtime =
    comparison == null
      ? null
      : Object.freeze({
          baselineKind: 'generated-probe' as 'generated-probe',
          runtimeInterface: config.runtimeInterface,
          assumptionArtifactHash: config.assumptionArtifactHash,
          expectedReportHash,
          candidateCommand,
          comparison,
        });
  const provisional =
    runtime == null
      ? detail == null
        ? stable
        : { ...stable, detail }
      : detail == null
        ? { ...stable, runtime }
        : { ...stable, runtime, detail };
  return Object.freeze({
    evidence: Object.freeze({
      ...provisional,
      id: repositoryEvidenceIdentity(provisional as $FlowFixMe),
    }) as $FlowFixMe,
    fullOutput: output,
  });
}

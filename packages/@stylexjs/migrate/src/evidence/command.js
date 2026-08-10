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
import { spawn } from 'child_process';
import { hashBytes, hashString, shortHash } from '../kernel/hash';
import { canonicalJson } from '../state/json';
import type { CommandProviderConfig } from './config';
import type { RepositoryEvidenceSubject } from './subject';

export type CommandRecord = {
  +argv: $ReadOnlyArray<string>,
  +versionArgv: $ReadOnlyArray<string>,
  +cwd: string,
  +allowedEnvKeys: $ReadOnlyArray<string>,
  +environmentFingerprint: string,
  +exitCode: number | null,
};

export type PlatformFingerprint = {
  +platform: string,
  +architecture: string,
  +node: string,
};

export type RepositoryEvidenceResult = {
  +id: string,
  +check: string,
  +checkVersion: string,
  +provider: string,
  +providerVersion: string,
  +subject: RepositoryEvidenceSubject,
  +result: 'pass' | 'fail' | 'unavailable' | 'not-applicable',
  +command: CommandRecord,
  +platform: PlatformFingerprint,
  +startedAt: string,
  +durationMs: number,
  +outputHash: string,
  +outputSize: number,
  +outputPreview: string,
  +limitations: $ReadOnlyArray<string>,
  +detail?: string,
};

export type CommandExecution = {
  +evidence: RepositoryEvidenceResult,
  +fullOutput: Buffer,
};

export type CommandExecutionContext = {
  +workspaceRoot: string,
  +subject: RepositoryEvidenceSubject,
  +environment?: { +[string]: string | void },
  +now?: () => string,
  +monotonicNow?: () => number,
  +outputPreviewBytes?: number,
};

type ProcessResult = {
  +exitCode: number | null,
  +signal: string | null,
  +stdout: Buffer,
  +stderr: Buffer,
  +error: Error | null,
  +timedOut: boolean,
};

function runProcess({
  argv,
  cwd,
  environment,
  timeoutMs,
}: {
  +argv: $ReadOnlyArray<string>,
  +cwd: string,
  +environment: { +[string]: string },
  +timeoutMs: number,
}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timedOut = false;
    let timer = null;
    let killTimer = null;
    const finish = (value: ProcessResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer != null) {
        clearTimeout(timer);
      }
      if (killTimer != null) {
        clearTimeout(killTimer);
      }
      resolve(value);
    };
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: environment,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        exitCode: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        error: error instanceof Error ? error : new Error(String(error)),
        timedOut: false,
      });
      return;
    }
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) =>
      finish({
        exitCode: null,
        signal: null,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        error,
        timedOut,
      }),
    );
    child.on('close', (exitCode, signal) =>
      finish({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        error: null,
        timedOut,
      }),
    );
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    }, timeoutMs);
  });
}

function selectedEnvironment(
  keys: $ReadOnlyArray<string>,
  source: { +[string]: string | void },
): { +values: { +[string]: string }, +fingerprint: string } {
  const values: { [string]: string } = {};
  for (const key of keys) {
    const value = source[key];
    if (value != null) {
      values[key] = value;
    }
  }
  return Object.freeze({
    values: Object.freeze(values),
    fingerprint: hashString(canonicalJson(values)),
  });
}

function commandDirectory(workspaceRoot: string, relative: string): string {
  const root = fs.realpathSync(workspaceRoot);
  const requested = path.resolve(root, relative);
  let resolved;
  try {
    const stats = fs.lstatSync(requested);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('not a real directory');
    }
    resolved = fs.realpathSync(requested);
  } catch (error) {
    throw new Error(
      `Evidence provider cwd is unavailable: ${relative} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const relation = path.relative(root, resolved);
  if (
    path.isAbsolute(relation) ||
    relation === '..' ||
    relation.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Evidence provider cwd escapes the workspace: ${relative}`);
  }
  return resolved;
}

function expandArgv(
  argv: $ReadOnlyArray<string>,
  subject: RepositoryEvidenceSubject,
): $ReadOnlyArray<string> {
  const changedFiles = subject.changes.map((change) => change.path);
  return Object.freeze(
    argv.flatMap((argument) =>
      argument === '{changedFiles}' ? changedFiles : [argument],
    ),
  );
}

function fullOutput(result: ProcessResult): Buffer {
  return Buffer.concat([
    Buffer.from('[stdout]\n'),
    result.stdout,
    Buffer.from('\n[stderr]\n'),
    result.stderr,
  ]);
}

function preview(output: Buffer, limit: number): string {
  if (output.length <= limit) {
    return output.toString('utf8');
  }
  return `${output.subarray(0, limit).toString('utf8')}\n… output preview truncated; full log retained`;
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

export async function runCommandProvider(
  config: CommandProviderConfig,
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
  const environment = selectedEnvironment(
    config.allowedEnv,
    context.environment ?? process.env,
  );
  const argv = expandArgv(config.argv, context.subject);
  let cwd = context.workspaceRoot;
  let processResult: ProcessResult;
  let providerVersion = 'unavailable';
  let result: 'pass' | 'fail' | 'unavailable' | 'not-applicable';
  let detail;

  if (config.subject !== context.subject.kind) {
    processResult = {
      exitCode: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      error: null,
      timedOut: false,
    };
    result = 'not-applicable';
    detail = `provider requires a ${config.subject} subject`;
  } else {
    try {
      cwd = commandDirectory(context.workspaceRoot, config.cwd);
      const version = await runProcess({
        argv: config.versionArgv,
        cwd,
        environment: environment.values,
        timeoutMs: Math.min(config.timeoutMs, 30000),
      });
      const reportedVersion = versionText(version);
      if (reportedVersion == null) {
        processResult = version;
        result = 'unavailable';
        detail = version.timedOut
          ? 'provider version command timed out'
          : (version.error?.message ??
            `provider version command exited ${String(version.exitCode)}`);
      } else {
        providerVersion = reportedVersion;
        processResult = await runProcess({
          argv,
          cwd,
          environment: environment.values,
          timeoutMs: config.timeoutMs,
        });
        if (processResult.error != null) {
          result = 'unavailable';
          detail = processResult.error.message;
        } else if (processResult.timedOut) {
          result = 'fail';
          detail = `provider timed out after ${config.timeoutMs}ms`;
        } else if (processResult.exitCode === 0) {
          result = 'pass';
        } else {
          result = 'fail';
          detail = `provider exited ${String(processResult.exitCode)}${
            processResult.signal == null
              ? ''
              : ` after signal ${processResult.signal}`
          }`;
        }
      }
    } catch (error) {
      processResult = {
        exitCode: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        error: error instanceof Error ? error : new Error(String(error)),
        timedOut: false,
      };
      result = 'unavailable';
      detail = processResult.error?.message;
    }
  }

  const output = fullOutput(processResult);
  const durationMs = Math.max(0, monotonicNow() - started);
  const command = Object.freeze({
    argv,
    versionArgv: config.versionArgv,
    cwd: config.cwd,
    allowedEnvKeys: config.allowedEnv,
    environmentFingerprint: environment.fingerprint,
    exitCode: processResult.exitCode,
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
    ...(detail == null ? {} : { detail }),
  };
  const evidence = Object.freeze({
    id: shortHash(hashString(canonicalJson(stable as $FlowFixMe))),
    ...stable,
    startedAt,
    durationMs,
    outputPreview: preview(output, context.outputPreviewBytes ?? 8192),
  });
  return Object.freeze({ evidence, fullOutput: output });
}

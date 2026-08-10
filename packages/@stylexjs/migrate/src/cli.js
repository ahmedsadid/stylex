#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  STATE_DIRECTORY,
  initializeProject,
  openProject,
} from './state/project';
import { rebuildIndexes, replayEvents } from './state/events';
import { cleanupProject, migrateProject } from './state/maintenance';
import { redact, redactText } from './state/redact';
import type { JsonValue } from './state/json';

type WriteOutput = (text: string) => mixed;

type CliOptions = {
  +cwd?: string,
  +writeStdout?: WriteOutput,
  +writeStderr?: WriteOutput,
};

const HELP = `Usage: stylex-migrate <command> [options]

Commands:
  init                    initialize local project state
  status                  summarize replayed local state
  state rebuild           rebuild indexes from append-only events
  schema migrate          migrate local state, with a backup
  cleanup                 find unused local artifacts

Options:
  --json                  emit stable JSON
  --dry-run               describe a schema migration without changing files
  --confirm               allow cleanup to delete listed unused files
`;

function present(value: JsonValue, json: boolean, stdout: WriteOutput): void {
  const safe = redact(value);
  if (json) {
    stdout(`${JSON.stringify(safe)}\n`);
  } else {
    stdout(`${JSON.stringify(safe, null, 2)}\n`);
  }
}

function counts(indexes: $FlowFixMe): { [string]: JsonValue } {
  const output: { [string]: JsonValue } = {};
  for (const name of Object.keys(indexes).sort()) {
    output[name] = Object.keys(indexes[name]).length;
  }
  return output;
}

export function runCli(
  argv: $ReadOnlyArray<string>,
  options?: CliOptions,
): number {
  const cwd = options?.cwd ?? process.cwd();
  const stdout = options?.writeStdout ?? ((text) => process.stdout.write(text));
  const stderr = options?.writeStderr ?? ((text) => process.stderr.write(text));
  const json = argv.includes('--json');
  const args = argv.filter((argument) => !argument.startsWith('--'));
  try {
    if (args.length === 0 || args[0] === 'help') {
      stdout(HELP);
      return 0;
    }
    if (args[0] === 'init' && args.length === 1) {
      const project = initializeProject({ repositoryRoot: cwd });
      present(
        {
          command: 'init',
          stateDirectory: STATE_DIRECTORY,
          schemaVersion: project.schemaVersion,
        },
        json,
        stdout,
      );
      return 0;
    }
    if (args[0] === 'status' && args.length === 1) {
      const project = openProject(cwd);
      const replay = replayEvents(project);
      present(
        {
          command: 'status',
          schemaVersion: project.schemaVersion,
          eventCount: replay.lastSequence,
          counts: counts(replay.indexes),
        },
        json,
        stdout,
      );
      return 0;
    }
    if (args[0] === 'state' && args[1] === 'rebuild' && args.length === 2) {
      const replay = rebuildIndexes(openProject(cwd));
      present(
        {
          command: 'state rebuild',
          eventCount: replay.lastSequence,
          counts: counts(replay.indexes),
        },
        json,
        stdout,
      );
      return 0;
    }
    if (args[0] === 'schema' && args[1] === 'migrate' && args.length === 2) {
      const result = migrateProject({
        repositoryRoot: cwd,
        dryRun: argv.includes('--dry-run'),
      });
      present(
        { command: 'schema migrate', ...result } as $FlowFixMe,
        json,
        stdout,
      );
      return 0;
    }
    if (args[0] === 'cleanup' && args.length === 1) {
      const result = cleanupProject({
        project: openProject(cwd),
        confirm: argv.includes('--confirm'),
      });
      present({ command: 'cleanup', ...result } as $FlowFixMe, json, stdout);
      return 0;
    }
    stderr(redactText(`Unknown command.\n${HELP}`));
    return 64;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      present({ error: redactText(message) }, true, stdout);
    } else {
      stderr(`${redactText(message)}\n`);
    }
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2));
}

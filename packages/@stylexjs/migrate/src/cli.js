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
  readConfig,
} from './state/project';
import { rebuildIndexes, replayEvents } from './state/events';
import { cleanupProject, migrateProject } from './state/maintenance';
import { redact, redactText } from './state/redact';
import { scanRepository } from './inventory/scan';
import { createPlan } from './planning/plan';
import {
  inventoryCounts,
  loadCurrentInventory,
  loadCurrentPlan,
  loadPlan,
  saveInventory,
  savePlan,
} from './planning/reports';
import type { JsonValue } from './state/json';
import type { Inventory, Plan } from './inventory/model';
import type { ProjectState } from './state/project';

type WriteOutput = (text: string) => mixed;

type CliOptions = {
  +cwd?: string,
  +writeStdout?: WriteOutput,
  +writeStderr?: WriteOutput,
};

const HELP = `Usage: stylex-migrate <command> [options]

Commands:
  init                    initialize local project state
  scan                    inventory configured source files
  plan                    form migration clusters from the latest inventory
  status                  summarize inventory, plan, and replayed state
  explain <id>            show a site's, fact's, cluster's, or plan's reasons
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

function planSummary(
  plan: Plan,
  inventory: Inventory | null,
): { +[string]: JsonValue } {
  return {
    id: plan.id,
    inventoryId: plan.inventoryId,
    stale: inventory == null || plan.inventoryId !== inventory.id,
    clusters: plan.clusters.length,
    conflicts: plan.conflicts.length,
    diagnostics: plan.diagnosticCount,
    counts: plan.counts as $FlowFixMe,
  };
}

function explain(
  project: ProjectState,
  id: string,
): { +kind: string, +detail: JsonValue } | null {
  const inventory = loadCurrentInventory(project);
  const currentPlan = loadCurrentPlan(project);
  if (currentPlan?.id === id) {
    return { kind: 'plan', detail: currentPlan as $FlowFixMe };
  }
  const cluster = currentPlan?.clusters.find((item) => item.id === id);
  if (cluster != null) {
    return {
      kind: 'cluster',
      detail: {
        cluster: cluster as $FlowFixMe,
        sites: (inventory?.sites.filter((site) =>
          cluster.siteIds.includes(site.id),
        ) ?? []) as $FlowFixMe,
        facts: (inventory?.facts.filter((fact) =>
          cluster.factIds.includes(fact.id),
        ) ?? []) as $FlowFixMe,
      },
    };
  }
  const site = inventory?.sites.find((item) => item.id === id);
  if (site != null) {
    return {
      kind: 'site',
      detail: {
        site: site as $FlowFixMe,
        facts: (inventory?.facts.filter((fact) =>
          site.factIds.includes(fact.id),
        ) ?? []) as $FlowFixMe,
        clusters: (currentPlan?.clusters.filter((item) =>
          item.siteIds.includes(site.id),
        ) ?? []) as $FlowFixMe,
      },
    };
  }
  const fact = inventory?.facts.find((item) => item.id === id);
  if (fact != null) {
    return { kind: 'fact', detail: fact as $FlowFixMe };
  }
  if (inventory?.id === id) {
    return { kind: 'inventory', detail: inventory as $FlowFixMe };
  }
  if (/^[a-f0-9]{16}$/.test(id)) {
    const storedPlan = loadPlan(project, id);
    if (storedPlan != null) {
      return { kind: 'plan', detail: storedPlan as $FlowFixMe };
    }
  }
  return null;
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
    if (args[0] === 'scan' && args.length === 1) {
      const project = openProject(cwd);
      const inventory = scanRepository({
        repositoryRoot: project.repositoryRoot,
        sourceGlobs: readConfig(project).sourceGlobs,
      });
      saveInventory(project, inventory);
      present(
        {
          command: 'scan',
          inventoryId: inventory.id,
          counts: inventoryCounts(inventory),
        },
        json,
        stdout,
      );
      return 0;
    }
    if (args[0] === 'plan' && args.length === 1) {
      const project = openProject(cwd);
      const inventory = loadCurrentInventory(project);
      if (inventory == null) {
        throw new Error('No inventory found; run stylex-migrate scan first');
      }
      const plan = createPlan({ inventory });
      savePlan(project, plan);
      present(
        { ...planSummary(plan, inventory), command: 'plan' } as $FlowFixMe,
        json,
        stdout,
      );
      return 0;
    }
    if (args[0] === 'status' && args.length === 1) {
      const project = openProject(cwd);
      const replay = replayEvents(project);
      const inventory = loadCurrentInventory(project);
      const plan = loadCurrentPlan(project);
      present(
        {
          command: 'status',
          schemaVersion: project.schemaVersion,
          eventCount: replay.lastSequence,
          counts: counts(replay.indexes),
          inventory:
            inventory == null
              ? null
              : {
                  id: inventory.id,
                  counts: inventoryCounts(inventory),
                },
          plan: plan == null ? null : planSummary(plan, inventory),
        },
        json,
        stdout,
      );
      return 0;
    }
    if (args[0] === 'explain' && args.length === 2) {
      const result = explain(openProject(cwd), args[1]);
      if (result == null) {
        const message = `No migration entity found for ${args[1]}`;
        if (json) {
          present({ error: message, id: args[1] }, true, stdout);
        } else {
          stderr(`${message}\n`);
        }
        return 2;
      }
      present(
        {
          command: 'explain',
          id: args[1],
          kind: result.kind,
          detail: result.detail,
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

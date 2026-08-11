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
  writeConfig,
} from './state/project';
import fs from 'fs';
import path from 'path';
import { rebuildIndexes, replayEvents } from './state/events';
import { cleanupProject, migrateProject } from './state/maintenance';
import { redact, redactText } from './state/redact';
import { scanRepository } from './inventory/scan';
import { inventoryReadiness } from './inventory/readiness';
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
import { parseJson } from './state/json';
import type { Inventory, Plan } from './inventory/model';
import type { ProjectState } from './state/project';
import { loadVerificationCandidate } from './evidence/candidates';
import { createCandidateEvidenceSubject } from './evidence/subject';
import {
  loadLatestRepositoryEvidenceBundle,
  loadRepositoryEvidenceBundle,
} from './evidence/bundle';
import {
  loadLatestRepositoryEvidenceVerdict,
  loadRepositoryEvidenceVerdict,
} from './evidence/verdict';
import { verifyPersistedCandidates } from './evidence/verify';
import {
  abandonContextTask,
  inspectContextTask,
  openContextRetry,
  openContextTask,
  submitContextAttempt,
} from './context/lifecycle';
import {
  approvePersistedThemeDecision,
  assertActiveThemeCandidateDecisions,
  inspectThemeDecision,
  loadThemeDecisionDraft,
  persistThemeDecisionDraft,
} from './theme/decisions';
import { proposeThemeDecisionCandidate } from './theme/candidate';
import { proposeMechanicalCandidate } from './mechanical/candidate';
import { proposeStyledCandidate } from './styled/candidate';
import type { CandidatePatch } from './candidate/patch';

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
  readiness               summarize styled, theme, and css-prop shapes
  plan                    form migration clusters from the latest inventory
  mechanical propose <cluster>
                          freeze a checked candidate from a mechanical cluster
  styled propose <cluster>
                          freeze a checked closed-intrinsic styled candidate
  candidate diff <candidate>
                          print the exact frozen patch without applying it
  theme draft <json-file> <author>
                          validate and persist a theme token-map draft
  theme inspect <draft>   show approval and active/superseded state
  theme approve <draft> <reviewer> --human-confirm
                          record a human approval; agents must not run this
  theme propose <draft>   freeze a candidate from the active approved map
  context open <cluster> <goal>
                          open a contextual workspace from a planned cluster
  context open <task>     open the kernel-owned retry for a failed task
  context inspect <task>  show the immutable capsule and current task state
  context submit <task> <agent|human> <name> <version> [skill-version]
                          freeze workspace bytes and submit through the kernel
  context abandon <task>  abandon an open workspace
  verify <candidate...>   run checks against exact persisted candidate bytes
  review <id>             show a verdict, coverage, claims, and limitations
  config show             show normalized project configuration
  config set <json-file>  validate and store project configuration
  status                  summarize inventory, plan, and replayed state
  explain <id>            explain an inventory, candidate, evidence, or verdict id
  state rebuild           rebuild indexes from append-only events
  schema migrate          migrate local state, with a backup
  cleanup                 find unused local artifacts

Options:
  --json                  emit stable JSON
  --dry-run               describe a schema migration without changing files
  --confirm               allow cleanup to delete listed unused files
  --human-confirm         attest that a named human reviewed the theme map
`;

function present(value: JsonValue, json: boolean, stdout: WriteOutput): void {
  const safe = redact(value);
  if (json) {
    stdout(`${JSON.stringify(safe)}\n`);
  } else {
    stdout(`${JSON.stringify(safe, null, 2)}\n`);
  }
}

function presentCandidateDiff(
  candidate: CandidatePatch,
  json: boolean,
  stdout: WriteOutput,
): void {
  // This command is an explicit source export. Redacting it would change the
  // candidate bytes and make the output unsuitable for review or application.
  if (json) {
    stdout(
      `${JSON.stringify({
        command: 'candidate diff',
        candidateId: candidate.id,
        patchHash: candidate.patchHash,
        files: candidate.touchedFiles,
        patchText: candidate.patchText,
      })}\n`,
    );
  } else {
    stdout(candidate.patchText);
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
  if (id.startsWith('theme-draft-')) {
    const draft = loadThemeDecisionDraft(project, id);
    if (draft != null) {
      return {
        kind: 'theme-decision',
        detail: inspectThemeDecision(project, id) as $FlowFixMe,
      };
    }
  }
  if (/^[a-f0-9]{16}$/.test(id)) {
    const candidate = loadVerificationCandidate(project, id);
    if (candidate != null) {
      const subject = createCandidateEvidenceSubject({
        candidate: candidate.candidate,
        snapshot: candidate.snapshot,
        siteIdsByFile: candidate.siteIdsByFile,
      });
      return {
        kind: 'candidate',
        detail: {
          id: candidate.candidate.id,
          subjectId: subject.id,
          classification: candidate.classification,
          proposer: candidate.candidate.proposer as $FlowFixMe,
          decisionArtifactHashes: candidate.candidate.decisionArtifactHashes,
          decisionStatus: candidateDecisionStatus(
            project,
            candidate.candidate,
          ) as $FlowFixMe,
          files: candidate.candidate.touchedFiles,
          clusters: candidate.candidate.clusterIds,
          latestVerdict: loadLatestRepositoryEvidenceVerdict(
            project,
            subject.id,
          ) as $FlowFixMe,
        },
      };
    }
    const verdict = loadRepositoryEvidenceVerdict(project, id);
    if (verdict != null) {
      return { kind: 'verdict', detail: verdict as $FlowFixMe };
    }
    const bundle = loadRepositoryEvidenceBundle(project, id);
    if (bundle != null) {
      return { kind: 'evidence-bundle', detail: bundle as $FlowFixMe };
    }
    const latestVerdict = loadLatestRepositoryEvidenceVerdict(project, id);
    if (latestVerdict != null) {
      return {
        kind: 'evidence-subject',
        detail: {
          subjectId: id,
          verdict: latestVerdict as $FlowFixMe,
          evidence: loadLatestRepositoryEvidenceBundle(
            project,
            id,
          ) as $FlowFixMe,
        },
      };
    }
    const storedPlan = loadPlan(project, id);
    if (storedPlan != null) {
      return { kind: 'plan', detail: storedPlan as $FlowFixMe };
    }
  }
  return null;
}

function candidateDecisionStatus(
  project: ProjectState,
  candidate: CandidatePatch,
): { +status: string, +reason: string | null } {
  if (candidate.decisionArtifactHashes.length === 0) {
    return { status: 'not-applicable', reason: null };
  }
  try {
    assertActiveThemeCandidateDecisions(project, candidate);
    return { status: 'active', reason: null };
  } catch (error) {
    return {
      status: 'stale',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function review(
  project: ProjectState,
  id: string,
): {
  +warnings: JsonValue,
  +verdict: JsonValue,
  +evidence: JsonValue,
  +candidates: JsonValue,
} | null {
  let verdict = loadRepositoryEvidenceVerdict(project, id);
  let bundle = loadRepositoryEvidenceBundle(project, id);
  const candidate = loadVerificationCandidate(project, id);
  if (candidate != null) {
    const subject = createCandidateEvidenceSubject({
      candidate: candidate.candidate,
      snapshot: candidate.snapshot,
      siteIdsByFile: candidate.siteIdsByFile,
    });
    verdict = loadLatestRepositoryEvidenceVerdict(project, subject.id);
    bundle = loadLatestRepositoryEvidenceBundle(project, subject.id);
  } else if (verdict == null && bundle == null) {
    verdict = loadLatestRepositoryEvidenceVerdict(project, id);
    bundle = loadLatestRepositoryEvidenceBundle(project, id);
  }
  if (verdict != null && bundle == null) {
    bundle = loadRepositoryEvidenceBundle(project, verdict.evidenceBundleId);
  }
  if (bundle != null && verdict == null) {
    verdict = loadLatestRepositoryEvidenceVerdict(project, bundle.subject.id);
  }
  if (verdict == null || bundle == null) {
    return null;
  }
  const candidateRecords = bundle.candidateIds.map((candidateId) => ({
    candidateId,
    record: loadVerificationCandidate(project, candidateId),
  }));
  const decisionWarnings = candidateRecords
    .map(({ record }) =>
      record == null
        ? null
        : candidateDecisionStatus(project, record.candidate),
    )
    .flatMap((status) =>
      status?.status === 'stale' ? [`WARNING: ${String(status.reason)}`] : [],
    );
  return {
    warnings: [
      ...verdict.limitations.filter((limitation) =>
        limitation.startsWith('WARNING:'),
      ),
      ...decisionWarnings,
    ] as $FlowFixMe,
    verdict: verdict as $FlowFixMe,
    evidence: {
      id: bundle.id,
      subject: bundle.subject as $FlowFixMe,
      coverage: bundle.coverage as $FlowFixMe,
      runtimeCoverage: bundle.runtimeCoverage as $FlowFixMe,
      repositoryChecks: bundle.repositoryEntries.map((entry) => ({
        provider: entry.providerId,
        check: entry.evidence.check,
        result: entry.evidence.result,
        detail: entry.evidence.detail ?? null,
        outputPreview: entry.evidence.outputPreview,
        outputArtifact: entry.outputArtifact,
      })) as $FlowFixMe,
      skippedProviderIds: bundle.skippedProviderIds,
    },
    candidates: candidateRecords.map(({ candidateId, record }) => {
      return record == null
        ? { id: candidateId, missing: true }
        : {
            id: candidateId,
            classification: record.classification,
            proposer: record.candidate.proposer,
            files: record.candidate.touchedFiles,
            decisionArtifactHashes: record.candidate.decisionArtifactHashes,
            decisionStatus: candidateDecisionStatus(project, record.candidate),
          };
    }) as $FlowFixMe,
  };
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
          readiness: inventoryReadiness(inventory, { sampleLimit: 0 }),
        },
        json,
        stdout,
      );
      return 0;
    }
    if (args[0] === 'readiness' && args.length === 1) {
      const project = openProject(cwd);
      const inventory = loadCurrentInventory(project);
      if (inventory == null) {
        throw new Error('No inventory found; run stylex-migrate scan first');
      }
      present(
        {
          command: 'readiness',
          inventoryId: inventory.id,
          readiness: inventoryReadiness(inventory),
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
    if (
      args[0] === 'mechanical' &&
      args[1] === 'propose' &&
      args.length === 3
    ) {
      const result = proposeMechanicalCandidate({
        project: openProject(cwd),
        clusterId: args[2],
      });
      present(
        result.ok
          ? {
              command: 'mechanical propose',
              state: 'frozen',
              candidateId: result.record.candidate.id,
              clusterId: result.clusterId,
              changedFiles: result.record.candidate.touchedFiles,
              models: result.models,
              limitations: result.limitations,
              next:
                `Inspect with stylex-migrate candidate diff ${result.record.candidate.id}, ` +
                `then run stylex-migrate verify ${result.record.candidate.id}.`,
            }
          : {
              command: 'mechanical propose',
              state: 'refused',
              reason: result.reason,
              file: result.file,
              evidence: result.evidence,
            },
        json,
        stdout,
      );
      return result.ok ? 0 : 3;
    }
    if (args[0] === 'styled' && args[1] === 'propose' && args.length === 3) {
      const result = proposeStyledCandidate({
        project: openProject(cwd),
        clusterId: args[2],
      });
      present(
        result.ok
          ? {
              command: 'styled propose',
              state: 'frozen',
              candidateId: result.record.candidate.id,
              clusterId: result.clusterId,
              changedFiles: result.record.candidate.touchedFiles,
              model: result.model,
              limitations: result.limitations,
              next:
                `Inspect with stylex-migrate candidate diff ${result.record.candidate.id}, ` +
                `then configure repository checks and run stylex-migrate verify ${result.record.candidate.id}.`,
            }
          : {
              command: 'styled propose',
              state: 'refused',
              reason: result.reason,
              file: result.file,
              evidence: result.evidence,
            },
        json,
        stdout,
      );
      return result.ok ? 0 : 3;
    }
    if (args[0] === 'candidate' && args[1] === 'diff' && args.length === 3) {
      const record = loadVerificationCandidate(openProject(cwd), args[2]);
      if (record == null) {
        const message = `No persisted candidate found for ${args[2]}`;
        if (json) {
          present({ error: message, id: args[2] }, true, stdout);
        } else {
          stderr(`${message}\n`);
        }
        return 2;
      }
      presentCandidateDiff(record.candidate, json, stdout);
      return 0;
    }
    if (args[0] === 'theme' && args[1] === 'draft' && args.length === 4) {
      const project = openProject(cwd);
      const source = path.resolve(cwd, args[2]);
      const definition = parseJson(fs.readFileSync(source, 'utf8'), source);
      const draft = persistThemeDecisionDraft({
        project,
        definition,
        draftedBy: args[3],
      });
      present(
        {
          command: 'theme draft',
          state: 'drafted',
          draft: draft as $FlowFixMe,
          next: `A human must inspect this map, then run stylex-migrate theme approve ${draft.id} <reviewer> --human-confirm.`,
        },
        json,
        stdout,
      );
      return 0;
    }
    if (args[0] === 'theme' && args[1] === 'inspect' && args.length === 3) {
      const inspection = inspectThemeDecision(openProject(cwd), args[2]);
      present(
        {
          command: 'theme inspect',
          ...inspection,
        } as $FlowFixMe,
        json,
        stdout,
      );
      return 0;
    }
    if (args[0] === 'theme' && args[1] === 'approve' && args.length === 4) {
      if (!argv.includes('--human-confirm')) {
        throw new Error(
          'Theme approval requires --human-confirm from the named human reviewer. Agents must not approve their own drafts.',
        );
      }
      const project = openProject(cwd);
      const approval = approvePersistedThemeDecision({
        project,
        draftId: args[2],
        actor: 'human',
        approvedBy: args[3],
      });
      present(
        {
          command: 'theme approve',
          state: 'active',
          approval: approval as $FlowFixMe,
          warnings: approval.limitations,
          next: `Run stylex-migrate theme propose ${args[2]} to create an immutable candidate.`,
        },
        json,
        stdout,
      );
      return 0;
    }
    if (args[0] === 'theme' && args[1] === 'propose' && args.length === 3) {
      const result = proposeThemeDecisionCandidate({
        project: openProject(cwd),
        draftId: args[2],
      });
      present(
        result.ok
          ? {
              command: 'theme propose',
              state: 'frozen',
              candidateId: result.record.candidate.id,
              draftId: result.draftId,
              approvalArtifactHash: result.approvalArtifactHash,
              changedFiles: result.record.candidate.touchedFiles,
              next: `Run stylex-migrate verify ${result.record.candidate.id}.`,
            }
          : {
              command: 'theme propose',
              state: 'refused',
              reason: result.reason,
              file: result.file,
            },
        json,
        stdout,
      );
      return result.ok ? 0 : 3;
    }
    if (args[0] === 'context' && args[1] === 'open') {
      const project = openProject(cwd);
      const result =
        args.length === 3
          ? openContextRetry({ project, taskId: args[2] })
          : args.length === 4
            ? openContextTask({
                project,
                clusterId: args[2],
                goal: args[3],
              })
            : null;
      if (result == null) {
        stderr(redactText(`Unknown command.\n${HELP}`));
        return 64;
      }
      present(
        result.ok
          ? {
              command: 'context open',
              state: result.state,
              taskId: result.task.id,
              attemptId: result.attempt.id,
              workspace: result.attempt.workspace.path,
              task: result.task as $FlowFixMe,
              attempt: result.attempt as $FlowFixMe,
            }
          : {
              command: 'context open',
              state: result.state,
              reasons: result.reasons,
            },
        json,
        stdout,
      );
      return result.ok ? 0 : 3;
    }
    if (args[0] === 'context' && args[1] === 'inspect' && args.length === 3) {
      const result = inspectContextTask(openProject(cwd), args[2]);
      present(
        {
          command: 'context inspect',
          taskId: result.task.id,
          state: result.state,
          stateData: result.stateData,
          task: result.task as $FlowFixMe,
          attempt: result.attempt as $FlowFixMe,
        },
        json,
        stdout,
      );
      return 0;
    }
    if (
      args[0] === 'context' &&
      args[1] === 'submit' &&
      (args.length === 6 || args.length === 7)
    ) {
      const proposerKind = args[3];
      if (proposerKind !== 'agent' && proposerKind !== 'human') {
        throw new Error('Context proposer kind must be agent or human');
      }
      const result = submitContextAttempt({
        project: openProject(cwd),
        taskId: args[2],
        proposerKind,
        proposerName: args[4],
        proposerVersion: args[5],
        ...(args[6] == null ? {} : { skillVersion: args[6] }),
      });
      present(
        { command: 'context submit', ...result } as $FlowFixMe,
        json,
        stdout,
      );
      return result.ok ? 0 : result.state === 'blocked' ? 3 : 4;
    }
    if (args[0] === 'context' && args[1] === 'abandon' && args.length === 3) {
      const result = abandonContextTask({
        project: openProject(cwd),
        taskId: args[2],
      });
      present(
        {
          command: 'context abandon',
          taskId: result.task.id,
          state: result.state,
        },
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
                  readiness: inventoryReadiness(inventory, {
                    sampleLimit: 0,
                  }),
                },
          plan: plan == null ? null : planSummary(plan, inventory),
        },
        json,
        stdout,
      );
      return 0;
    }
    if (args[0] === 'config' && args[1] === 'show' && args.length === 2) {
      present(
        {
          command: 'config show',
          config: readConfig(openProject(cwd)) as $FlowFixMe,
        },
        json,
        stdout,
      );
      return 0;
    }
    if (args[0] === 'config' && args[1] === 'set' && args.length === 3) {
      const project = openProject(cwd);
      const source = path.resolve(cwd, args[2]);
      const config = parseJson(fs.readFileSync(source, 'utf8'), source);
      if (
        config == null ||
        Array.isArray(config) ||
        typeof config !== 'object'
      ) {
        throw new Error('Project configuration input must be a JSON object');
      }
      writeConfig(project, config as $FlowFixMe);
      present(
        {
          command: 'config set',
          config: readConfig(project) as $FlowFixMe,
        },
        json,
        stdout,
      );
      return 0;
    }
    if (args[0] === 'review' && args.length === 2) {
      const result = review(openProject(cwd), args[1]);
      if (result == null) {
        const message = `No evidence review found for ${args[1]}`;
        if (json) {
          present({ error: message, id: args[1] }, true, stdout);
        } else {
          stderr(`${message}\n`);
        }
        return 2;
      }
      present(
        {
          command: 'review',
          id: args[1],
          warnings: result.warnings,
          verdict: result.verdict,
          evidence: result.evidence,
          candidates: result.candidates,
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

export async function runCliAsync(
  argv: $ReadOnlyArray<string>,
  options?: CliOptions,
): Promise<number> {
  const args = argv.filter((argument) => !argument.startsWith('--'));
  if (args[0] !== 'verify') {
    return runCli(argv, options);
  }
  const cwd = options?.cwd ?? process.cwd();
  const stdout = options?.writeStdout ?? ((text) => process.stdout.write(text));
  const stderr = options?.writeStderr ?? ((text) => process.stderr.write(text));
  const json = argv.includes('--json');
  try {
    if (args.length < 2) {
      stderr(redactText(`Unknown command.\n${HELP}`));
      return 64;
    }
    const result = await verifyPersistedCandidates({
      project: openProject(cwd),
      candidateIds: args.slice(1),
    });
    present(
      {
        command: 'verify',
        subject: result.subject as $FlowFixMe,
        schedule: {
          id: result.schedule.schedule.id,
          estimatedCommandRuns: result.schedule.schedule.estimatedCommandRuns,
          estimatedDurationMs: result.schedule.schedule.estimatedDurationMs,
          actualDurationMs: result.schedule.actualDurationMs,
          checks: result.schedule.entries.map((entry) => ({
            provider: entry.providerId,
            result: entry.evidence.result,
            cacheHit: entry.cacheHit,
            durationMs: entry.evidence.durationMs,
            outputArtifact: entry.outputArtifact,
          })),
          skippedProviderIds: result.schedule.skippedProviderIds,
        } as $FlowFixMe,
        coverage: result.coverage as $FlowFixMe,
        runtimeCoverage: result.runtimeCoverage as $FlowFixMe,
        warnings: result.verdict.limitations.filter((limitation) =>
          limitation.startsWith('WARNING:'),
        ) as $FlowFixMe,
        evidenceBundleId: result.bundle.id,
        verdict: result.verdict as $FlowFixMe,
      },
      json,
      stdout,
    );
    return result.verdict.outcome === 'rejected'
      ? 4
      : result.verdict.outcome === 'blocked'
        ? 3
        : 0;
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
  runCliAsync(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

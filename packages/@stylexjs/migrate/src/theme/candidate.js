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
import { changedPaths, createCandidatePatch } from '../candidate/patch';
import {
  createCandidateWorkspace,
  removeCandidateWorkspace,
} from '../candidate/workspace';
import { saveVerificationCandidate } from '../evidence/candidates';
import { evidence } from '../evidence/claims';
import { compileStyleX } from '../evidence/compile';
import { describeLintMessages, lintStyleX } from '../evidence/lint';
import { hashString } from '../kernel/hash';
import { createSnapshot, detectStaleFiles } from '../kernel/snapshot';
import { loadCurrentInventory } from '../planning/reports';
import { appendStateEvent } from '../state/events';
import { canonicalJson } from '../state/json';
import { readConfig } from '../state/project';
import {
  assertCurrentTestAssumption,
  loadTestAssumption,
} from '../assumption/records';
import {
  assertActiveThemeCandidateDecisions,
  inspectThemeDecision,
  validateThemeDecisionAgainstInventory,
} from './decisions';
import { THEME_DECISION_PROTOCOL_VERSION } from './model';
import { proposeApprovedThemeFiles, proposeThemeFiles } from './rewrite';
import type { VerificationCandidate } from '../evidence/candidates';
import type { EvidenceResult } from '../kernel/evidence';
import type { ProjectState } from '../state/project';
import type { TestAssumption } from '../assumption/model';
import type { ThemeDecisionApproval, ThemeDecisionDraft } from './model';

export type ThemeCandidateProposalResult =
  | {
      +ok: true,
      +record: VerificationCandidate,
      +draftId: string,
      +approvalArtifactHash: string,
    }
  | {
      +ok: false,
      +reason: string,
      +file: string | null,
    };

export type ThemeExperimentProposalResult =
  | {
      +ok: true,
      +record: VerificationCandidate,
      +draftId: string,
      +assumptionArtifactHash: string,
    }
  | {
      +ok: false,
      +reason: string,
      +file: string | null,
    };

export const THEME_EXPERIMENT_PROTOCOL_VERSION: string =
  'stylex-migrate-theme-experiment-v1';

function readTextOrNull(root: string, file: string): string | null {
  const absolute = path.join(root, file);
  try {
    const stats = fs.lstatSync(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Theme input ${file} is not a regular file`);
    }
    const bytes = fs.readFileSync(absolute);
    const source = bytes.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(bytes)) {
      throw new Error(`Theme input ${file} is not valid UTF-8`);
    }
    return source;
  } catch (error) {
    if (
      error != null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

function writeText(root: string, file: string, source: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, source, 'utf8');
}

export function proposeThemeDecisionCandidate({
  project,
  draftId,
  workspaceRoot,
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +draftId: string,
  +workspaceRoot?: string,
  +now?: () => string,
}): ThemeCandidateProposalResult {
  const inspection = inspectThemeDecision(project, draftId);
  if (inspection.state !== 'active' || inspection.approval == null) {
    throw new Error(`Theme decision ${draftId} is not the active approved map`);
  }
  const draft = inspection.draft;
  const approval = inspection.approval;
  return proposeThemeCandidate({
    project,
    draft,
    approval,
    assumption: null,
    workspaceRoot,
    now,
  });
}

export function proposeThemeExperimentCandidate({
  project,
  draftId,
  assumptionId,
  workspaceRoot,
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +draftId: string,
  +assumptionId: string,
  +workspaceRoot?: string,
  +now?: () => string,
}): ThemeExperimentProposalResult {
  const inspection = inspectThemeDecision(project, draftId);
  const assumption = loadTestAssumption(project, assumptionId);
  if (assumption == null) {
    throw new Error(`No test assumption found for ${assumptionId}`);
  }
  assertCurrentTestAssumption(project, assumption);
  const draft = inspection.draft;
  const requiredScope = [draft.targetModule, ...draft.consumerFiles];
  const missingScope = requiredScope.filter(
    (file) => !assumption.scope.files.includes(file),
  );
  if (missingScope.length > 0) {
    throw new Error(
      `Test assumption ${assumptionId} does not authorize theme experiment paths: ${missingScope.join(', ')}`,
    );
  }
  const result = proposeThemeCandidate({
    project,
    draft,
    approval: null,
    assumption,
    workspaceRoot,
    now,
  });
  return result.ok
    ? {
        ok: true,
        record: result.record,
        draftId,
        assumptionArtifactHash: assumption.artifactHash,
      }
    : result;
}

function proposeThemeCandidate({
  project,
  draft,
  approval,
  assumption,
  workspaceRoot,
  now,
}: {
  +project: ProjectState,
  +draft: ThemeDecisionDraft,
  +approval: ThemeDecisionApproval | null,
  +assumption: TestAssumption | null,
  +workspaceRoot?: string,
  +now: () => string,
}): ThemeCandidateProposalResult {
  const inventory = loadCurrentInventory(project);
  if (inventory == null || inventory.id !== draft.inventoryId) {
    throw new Error(
      `Theme decision ${draft.id} is stale; run stylex-migrate scan and draft a new map`,
    );
  }
  validateThemeDecisionAgainstInventory(draft, inventory);
  const configHash = hashString(
    canonicalJson(readConfig(project) as $FlowFixMe),
  );
  const snapshot = createSnapshot({
    repositoryRoot: project.repositoryRoot,
    files: [
      ...new Set([
        ...draft.sourceFiles,
        ...draft.consumerFiles,
        ...(draft.bridge?.boundaryFiles ?? []),
        ...inventory.configInputs,
        draft.targetModule,
        ...(assumption?.declaredInputs.map((input) => input.path) ?? []),
      ]),
    ].sort(),
    configHash,
    decisionArtifactHashes: [
      approval == null ? draft.definitionHash : approval.artifactHash,
    ],
    assumptionArtifactHashes:
      assumption == null ? [] : [assumption.artifactHash],
  });
  const stale = detectStaleFiles(snapshot);
  if (stale.length > 0) {
    throw new Error(
      `Theme candidate inputs differ from HEAD: ${stale.join(', ')}. Commit or stash them first.`,
    );
  }
  const workspace = createCandidateWorkspace({
    repositoryRoot: project.repositoryRoot,
    allowedPaths: [...draft.consumerFiles, draft.targetModule],
    baseCommit: snapshot.gitCommit,
    requireClean: false,
    rootDir: workspaceRoot,
  });
  try {
    const files = Object.fromEntries([
      ...draft.consumerFiles.map((file) => [
        file,
        readTextOrNull(workspace.path, file),
      ]),
      [draft.targetModule, readTextOrNull(workspace.path, draft.targetModule)],
    ]);
    const proposal =
      approval == null
        ? proposeThemeFiles({ files, draft })
        : proposeApprovedThemeFiles({ files, draft, approval });
    if (proposal.status === 'refused') {
      return {
        ok: false,
        reason: proposal.reason,
        file: proposal.file,
      };
    }
    for (const file of proposal.changedFiles) {
      writeText(workspace.path, file, proposal.files[file]);
    }
    const expectedContent = Object.fromEntries(
      proposal.changedFiles.map((file) => [
        file,
        hashString(proposal.files[file]),
      ]),
    );
    const staticEvidence: Array<EvidenceResult> = [];
    for (const file of proposal.changedFiles) {
      const targetHash = expectedContent[file];
      const subject = {
        file,
        sourceHash: snapshot.fileHashes[file] ?? null,
        targetHash,
        model: 'approved-theme-map-v1',
      };
      const compiled = compileStyleX(
        proposal.files[file],
        path.join(workspace.path, file),
        { moduleResolutionRoot: workspace.path },
      );
      staticEvidence.push(
        evidence({
          check: 'stylex-plugin-transform',
          provider: '@stylexjs/babel-plugin',
          subject,
          scope: [file],
          result: compiled.ok ? 'pass' : 'fail',
          ...(compiled.ok ? {} : { detail: compiled.reason }),
          limitations: [
            'the StyleX babel plugin was run without the repository compiler configuration',
            ...(assumption == null
              ? []
              : [
                  `WARNING: Test assumption ${assumption.id} authorizes a disposable theme experiment, not repository intent or human approval.`,
                  ...assumption.limitations,
                ]),
          ],
        }),
      );
      if (!compiled.ok) {
        return { ok: false, reason: compiled.reason, file };
      }
      const linted = lintStyleX(proposal.files[file], file);
      staticEvidence.push(
        evidence({
          check: 'stylex-lint',
          provider: '@stylexjs/eslint-plugin',
          subject,
          scope: [file],
          result: linted.ok ? 'pass' : 'fail',
          ...(linted.ok
            ? {}
            : { detail: describeLintMessages(linted.messages) }),
          limitations: [
            'only @stylexjs rules were run; the repository lint setup was not',
          ],
        }),
      );
      if (!linted.ok) {
        return {
          ok: false,
          reason: `StyleX lint rejected the theme output: ${describeLintMessages(linted.messages)}`,
          file,
        };
      }
    }
    const built = createCandidatePatch({
      workspace,
      snapshot,
      proposer: {
        kind: 'deterministic',
        version: approval == null ? 'theme-experiment-v1' : 'theme-decision-v1',
        protocolVersion:
          approval == null
            ? THEME_EXPERIMENT_PROTOCOL_VERSION
            : THEME_DECISION_PROTOCOL_VERSION,
      },
      decisionArtifactHashes: [
        approval == null ? draft.definitionHash : approval.artifactHash,
      ],
      assumptionArtifactHashes:
        assumption == null ? [] : [assumption.artifactHash],
      expectedContent,
    });
    if (!built.ok) {
      return {
        ok: false,
        reason: built.reason,
        file: built.paths[0] ?? null,
      };
    }
    const siteIdsByFile = Object.fromEntries(
      built.candidate.touchedFiles.map((file) => {
        const spans = proposal.siteSpansByFile[file] ?? [];
        return [
          file,
          inventory.sites
            .filter(
              (site) =>
                site.file === file &&
                spans.some(
                  (span) =>
                    span.start === site.span.start &&
                    span.end === site.span.end,
                ),
            )
            .map((site) => site.id),
        ];
      }),
    );
    const record: VerificationCandidate = Object.freeze({
      candidate: built.candidate,
      snapshot: built.snapshot,
      classification: 'repeatable-contextual',
      siteIdsByFile: Object.freeze(siteIdsByFile),
      staticEvidence: Object.freeze(staticEvidence),
    });
    if (approval != null) {
      assertActiveThemeCandidateDecisions(project, record.candidate);
    }
    saveVerificationCandidate(project, record, { now });
    appendStateEvent({
      project,
      entityKind: 'candidate',
      entityId: record.candidate.id,
      state: 'frozen',
      data: {
        draftId: draft.id,
        approvalArtifactHash:
          approval == null ? draft.definitionHash : approval.artifactHash,
        changes: changedPaths(record.candidate),
      },
      now,
    });
    return Object.freeze({
      ok: true,
      record,
      draftId: draft.id,
      approvalArtifactHash:
        approval == null ? draft.definitionHash : approval.artifactHash,
    });
  } finally {
    removeCandidateWorkspace(workspace);
  }
}

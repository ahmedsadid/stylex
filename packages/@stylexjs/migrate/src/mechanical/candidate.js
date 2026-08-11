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
import { hashString } from '../kernel/hash';
import { createSnapshot, detectStaleFiles } from '../kernel/snapshot';
import { loadCurrentInventory, loadCurrentPlan } from '../planning/reports';
import {
  proposeStaticConversion,
  proposeStaticConversionWithProjectActivation,
} from '../proposers/emotionStatic';
import { appendStateEvent } from '../state/events';
import { canonicalJson } from '../state/json';
import { readConfig } from '../state/project';
import type { VerificationCandidate } from '../evidence/candidates';
import type { EvidenceResult } from '../kernel/evidence';
import type { ProjectState } from '../state/project';
import type { Fact, Inventory } from '../inventory/model';

export type MechanicalCandidateProposalResult =
  | {
      +ok: true,
      +record: VerificationCandidate,
      +clusterId: string,
      +models: $ReadOnlyArray<string>,
      +limitations: $ReadOnlyArray<string>,
    }
  | {
      +ok: false,
      +reason: string,
      +file: string | null,
      +evidence: $ReadOnlyArray<EvidenceResult>,
    };

function readText(root: string, file: string): string {
  const absolute = path.join(root, file);
  const stats = fs.lstatSync(absolute);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Mechanical input ${file} is not a regular file`);
  }
  const bytes = fs.readFileSync(absolute);
  const source = bytes.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(bytes)) {
    throw new Error(`Mechanical input ${file} is not valid UTF-8`);
  }
  return source;
}

function writeText(root: string, file: string, source: string): void {
  fs.writeFileSync(path.join(root, file), source, 'utf8');
}

function projectActivationFactForFile(
  inventory: Inventory,
  factIds: $ReadOnlyArray<string>,
  file: string,
): Fact | null {
  const matches = inventory.facts.filter((fact) => {
    const value: $FlowFixMe = fact.value;
    return (
      factIds.includes(fact.id) &&
      fact.kind === 'emotion-jsx-activation' &&
      fact.status === 'known' &&
      value?.source === 'project-config' &&
      fact.inputFiles.includes(file)
    );
  });
  if (matches.length > 1) {
    throw new Error(`Multiple project activation facts apply to ${file}`);
  }
  return matches[0] ?? null;
}

export function proposeMechanicalCandidate({
  project,
  clusterId,
  workspaceRoot,
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +clusterId: string,
  +workspaceRoot?: string,
  +now?: () => string,
}): MechanicalCandidateProposalResult {
  const inventory = loadCurrentInventory(project);
  const plan = loadCurrentPlan(project);
  if (inventory == null || plan == null) {
    throw new Error(
      'No current migration plan found; run stylex-migrate scan and stylex-migrate plan first',
    );
  }
  if (plan.inventoryId !== inventory.id) {
    throw new Error(
      'The current plan is stale; run stylex-migrate plan against the latest scan',
    );
  }
  const cluster = plan.clusters.find((item) => item.id === clusterId);
  if (cluster == null) {
    throw new Error(`No current cluster found for ${clusterId}`);
  }
  if (cluster.state !== 'planned') {
    return {
      ok: false,
      reason: `Cluster ${clusterId} is blocked: ${cluster.blockedReasons.join('; ')}`,
      file: null,
      evidence: Object.freeze([]),
    };
  }
  if (cluster.classification !== 'mechanical') {
    return {
      ok: false,
      reason:
        `Cluster ${clusterId} is ${cluster.classification}; ` +
        'use the contextual or decision workflow',
      file: null,
      evidence: Object.freeze([]),
    };
  }

  const config = readConfig(project);
  const snapshot = createSnapshot({
    repositoryRoot: project.repositoryRoot,
    files: [
      ...new Set([...cluster.declaredInputs, ...inventory.configInputs]),
    ].sort(),
    configHash: hashString(canonicalJson(config as $FlowFixMe)),
  });
  const stale = detectStaleFiles(snapshot);
  if (stale.length > 0) {
    throw new Error(
      `Mechanical candidate inputs differ from HEAD: ${stale.join(', ')}. ` +
        'Commit or stash those inputs first.',
    );
  }

  const workspace = createCandidateWorkspace({
    repositoryRoot: project.repositoryRoot,
    allowedPaths: cluster.changeFiles,
    baseCommit: snapshot.gitCommit,
    requireClean: false,
    rootDir: workspaceRoot,
  });
  try {
    const expectedContent: { [string]: string } = {};
    const siteIdsByFile: { [string]: $ReadOnlyArray<string> } = {};
    const staticEvidence: Array<EvidenceResult> = [];
    const models = new Set<string>();
    const limitations = new Set<string>();

    for (const file of cluster.changeFiles) {
      const source = readText(workspace.path, file);
      const activationFact = projectActivationFactForFile(
        inventory,
        cluster.factIds,
        file,
      );
      const proposal =
        activationFact == null
          ? proposeStaticConversion({ source, filename: file })
          : proposeStaticConversionWithProjectActivation({
              source,
              filename: file,
              activationFact,
            });
      if (proposal.status !== 'proposed') {
        return {
          ok: false,
          reason: proposal.reason,
          file,
          evidence:
            proposal.status === 'refused'
              ? proposal.evidence
              : Object.freeze([]),
        };
      }
      const plannedSiteIds = cluster.siteIds.filter((siteId) =>
        inventory.sites.some(
          (site) => site.id === siteId && site.file === file,
        ),
      );
      if (
        proposal.refusals.length > 0 ||
        proposal.entries.length !== plannedSiteIds.length
      ) {
        return {
          ok: false,
          reason:
            `${file} no longer matches the planned mechanical boundary: ` +
            `${plannedSiteIds.length} planned site(s), ` +
            `${proposal.entries.length} converted, ` +
            `${proposal.refusals.length} refused`,
          file,
          evidence: proposal.evidence,
        };
      }
      writeText(workspace.path, file, proposal.code);
      expectedContent[file] = proposal.generatedHash;
      siteIdsByFile[file] = Object.freeze([...plannedSiteIds].sort());
      staticEvidence.push(...proposal.evidence);
      models.add(proposal.model);
      proposal.uncovered.forEach((limitation) => limitations.add(limitation));
    }

    const built = createCandidatePatch({
      workspace,
      snapshot,
      clusterIds: [cluster.id],
      proposer: { kind: 'deterministic', version: 'emotion-static-v1' },
      expectedContent,
    });
    if (!built.ok) {
      return {
        ok: false,
        reason: built.reason,
        file: built.paths[0] ?? null,
        evidence: Object.freeze(staticEvidence),
      };
    }
    const record: VerificationCandidate = Object.freeze({
      candidate: built.candidate,
      snapshot: built.snapshot,
      classification: 'mechanical',
      siteIdsByFile: Object.freeze(siteIdsByFile),
      staticEvidence: Object.freeze(staticEvidence),
    });
    saveVerificationCandidate(project, record, { now });
    appendStateEvent({
      project,
      entityKind: 'candidate',
      entityId: record.candidate.id,
      state: 'frozen',
      data: {
        clusterId,
        changes: changedPaths(record.candidate),
        models: [...models].sort(),
      },
      now,
    });
    return Object.freeze({
      ok: true,
      record,
      clusterId,
      models: Object.freeze([...models].sort()),
      limitations: Object.freeze([...limitations].sort()),
    });
  } finally {
    removeCandidateWorkspace(workspace);
  }
}

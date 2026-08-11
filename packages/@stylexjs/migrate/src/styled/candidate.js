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
import { proposeClosedStyledConversion } from '../proposers/emotionStyled';
import { appendStateEvent } from '../state/events';
import { canonicalJson } from '../state/json';
import { readConfig } from '../state/project';
import type { VerificationCandidate } from '../evidence/candidates';
import type { Fact, Site } from '../inventory/model';
import type { EvidenceResult } from '../kernel/evidence';
import type { ProjectState } from '../state/project';

export type StyledCandidateProposalResult =
  | {
      +ok: true,
      +record: VerificationCandidate,
      +clusterId: string,
      +model: string,
      +limitations: $ReadOnlyArray<string>,
    }
  | {
      +ok: false,
      +reason: string,
      +file: string | null,
      +evidence: $ReadOnlyArray<EvidenceResult>,
    };

function factForSite(
  site: Site,
  facts: $ReadOnlyArray<Fact>,
  kind: string,
): Fact {
  const matches = facts.filter(
    (fact) => site.factIds.includes(fact.id) && fact.kind === kind,
  );
  if (matches.length !== 1) {
    throw new Error(`Styled site ${site.id} requires exactly one ${kind} fact`);
  }
  return matches[0];
}

function readText(root: string, file: string): string {
  const absolute = path.join(root, file);
  const stats = fs.lstatSync(absolute);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Styled input ${file} is not a regular file`);
  }
  const bytes = fs.readFileSync(absolute);
  const source = bytes.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(bytes)) {
    throw new Error(`Styled input ${file} is not valid UTF-8`);
  }
  return source;
}

export function proposeStyledCandidate({
  project,
  clusterId,
  workspaceRoot,
  now = () => new Date().toISOString(),
}: {
  +project: ProjectState,
  +clusterId: string,
  +workspaceRoot?: string,
  +now?: () => string,
}): StyledCandidateProposalResult {
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
  if (cluster == null)
    throw new Error(`No current cluster found for ${clusterId}`);
  if (cluster.state !== 'planned') {
    return {
      ok: false,
      reason: `Cluster ${clusterId} is blocked: ${cluster.blockedReasons.join('; ')}`,
      file: null,
      evidence: Object.freeze([]),
    };
  }
  const styledSites = cluster.siteIds
    .map((id) => inventory.sites.find((site) => site.id === id))
    .filter(Boolean);
  if (
    styledSites.length !== 1 ||
    styledSites[0]?.kind !== 'styled-intrinsic' ||
    cluster.siteIds.length !== 1 ||
    cluster.changeFiles.length !== 1 ||
    cluster.classification !== 'repeatable-contextual'
  ) {
    return {
      ok: false,
      reason:
        `Cluster ${clusterId} is not one isolated repeatable-contextual ` +
        'closed intrinsic styled site',
      file: null,
      evidence: Object.freeze([]),
    };
  }
  const site = styledSites[0];
  if (site == null) throw new Error('Styled site unexpectedly missing');
  const file = site.file;
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
      `Styled candidate inputs differ from HEAD: ${stale.join(', ')}. ` +
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
    const source = readText(workspace.path, file);
    const proposal = proposeClosedStyledConversion({
      source,
      filename: file,
      readinessFact: factForSite(
        site,
        inventory.facts,
        'emotion-styled-readiness',
      ),
      usageFact: factForSite(site, inventory.facts, 'emotion-styled-usage'),
      grammarFact: factForSite(
        site,
        inventory.facts,
        'emotion-styled-template-grammar',
      ),
    });
    if (proposal.status !== 'proposed') {
      return {
        ok: false,
        reason: proposal.reason,
        file,
        evidence: proposal.evidence,
      };
    }
    fs.writeFileSync(path.join(workspace.path, file), proposal.code, 'utf8');
    const built = createCandidatePatch({
      workspace,
      snapshot,
      clusterIds: [cluster.id],
      proposer: {
        kind: 'deterministic',
        version: 'emotion-styled-flat-v1',
      },
      expectedContent: { [file]: proposal.generatedHash },
    });
    if (!built.ok) {
      return {
        ok: false,
        reason: built.reason,
        file: built.paths[0] ?? file,
        evidence: proposal.evidence,
      };
    }
    const record: VerificationCandidate = Object.freeze({
      candidate: built.candidate,
      snapshot: built.snapshot,
      classification: 'repeatable-contextual',
      siteIdsByFile: Object.freeze({ [file]: Object.freeze([site.id]) }),
      staticEvidence: proposal.evidence,
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
        model: proposal.model,
      },
      now,
    });
    return Object.freeze({
      ok: true,
      record,
      clusterId,
      model: proposal.model,
      limitations: proposal.uncovered,
    });
  } finally {
    removeCandidateWorkspace(workspace);
  }
}

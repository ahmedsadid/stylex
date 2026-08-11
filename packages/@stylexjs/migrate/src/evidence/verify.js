/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { removeCandidateWorkspace } from '../candidate/workspace';
import { recordContextVerificationOutcome } from '../context/lifecycle';
import { appendStateEvent } from '../state/events';
import { readConfig } from '../state/project';
import {
  createApplyPlanEvidenceSubject,
  createCandidateEvidenceSubject,
} from './subject';
import { createVerificationWorkspace } from './workspace';
import { loadVerificationCandidates } from './candidates';
import { runEvidenceSchedule } from './scheduler';
import {
  createRepositoryEvidenceBundle,
  saveRepositoryEvidenceBundle,
} from './bundle';
import {
  evaluateRepositoryEvidence,
  saveRepositoryEvidenceVerdict,
} from './verdict';
import type { CoverageSummary } from './coverage';
import type { EvidenceProviderRegistry } from './registry';
import type { EvidenceScheduleResult } from './scheduler';
import type { RepositoryEvidenceSubject } from './subject';
import type { RepositoryEvidenceBundle } from './bundle';
import type { RepositoryEvidenceVerdict } from './verdict';
import type { ProjectState } from '../state/project';

export type VerificationResult = {
  +subject: RepositoryEvidenceSubject,
  +schedule: EvidenceScheduleResult,
  +coverage: CoverageSummary,
  +bundle: RepositoryEvidenceBundle,
  +verdict: RepositoryEvidenceVerdict,
};

export async function verifyPersistedCandidates({
  project,
  candidateIds,
  registry,
  environment,
  workspaceRoot,
  now = () => new Date().toISOString(),
  monotonicNow,
}: {
  +project: ProjectState,
  +candidateIds: $ReadOnlyArray<string>,
  +registry?: EvidenceProviderRegistry,
  +environment?: { +[string]: string | void },
  +workspaceRoot?: string,
  +now?: () => string,
  +monotonicNow?: () => number,
}): Promise<VerificationResult> {
  const candidates = loadVerificationCandidates(project, candidateIds);
  const subjectInputs = candidates.map((record) => ({
    candidate: record.candidate,
    snapshot: record.snapshot,
    siteIdsByFile: record.siteIdsByFile,
  }));
  const subject =
    subjectInputs.length === 1
      ? createCandidateEvidenceSubject(subjectInputs[0])
      : createApplyPlanEvidenceSubject(subjectInputs);
  const config = readConfig(project).evidence;
  const workspace = createVerificationWorkspace({
    records: candidates,
    rootDir: workspaceRoot,
  });
  try {
    const schedule = await runEvidenceSchedule({
      project,
      workspaceRoot: workspace.path,
      subject,
      config,
      registry,
      environment,
      now,
      monotonicNow,
    });
    const bundle = createRepositoryEvidenceBundle({
      subject,
      candidates,
      schedule,
      config,
      now,
    });
    const coverage = bundle.coverage;
    const verdict = evaluateRepositoryEvidence({
      bundle,
      candidates,
      now,
    });
    saveRepositoryEvidenceBundle(project, bundle, { now });
    saveRepositoryEvidenceVerdict(project, verdict, { now });
    for (const candidate of candidates) {
      appendStateEvent({
        project,
        entityKind: 'candidate',
        entityId: candidate.candidate.id,
        state: 'evidence-collected',
        data: {
          subjectId: subject.id,
          evidenceBundleId: bundle.id,
          verdictId: verdict.id,
        },
        now,
      });
    }
    appendStateEvent({
      project,
      entityKind: 'verdict',
      entityId: verdict.id,
      state: verdict.outcome,
      data: {
        subjectId: subject.id,
        evidenceBundleId: bundle.id,
        candidateIds: verdict.candidateIds,
      },
      now,
    });
    for (const candidate of candidates) {
      recordContextVerificationOutcome({
        project,
        candidate: candidate.candidate,
        verdict,
        now,
      });
    }
    return Object.freeze({ subject, schedule, coverage, bundle, verdict });
  } finally {
    removeCandidateWorkspace(workspace);
  }
}

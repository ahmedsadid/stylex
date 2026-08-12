/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { proposeStaticConversion } from '../proposers/emotionStatic';
import type { Proposal } from '../proposers/emotionStatic';

export type CorpusSource = {
  +filename: string,
  +source: string,
};

export type CorpusSummary = {
  +files: {
    +scanned: number,
    +mentioningEmotion: number,
    +recognizedEmotion: number,
    +proposed: number,
    +partiallyProposed: number,
    +noSupportedSites: number,
    +refused: number,
    +notEmotion: number,
    +crashed: number,
  },
  +sites: {
    +proposed: number,
    +refusedDuringDiscovery: number,
  },
  +comparisonModels: { +[string]: number },
  +discoveryRefusals: { +[string]: number },
  +terminalRefusals: { +[string]: number },
  +crashes: $ReadOnlyArray<{ +filename: string, +error: string }>,
};

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedCounts(counts: Map<string, number>): { +[string]: number } {
  return Object.freeze(
    Object.fromEntries(
      [...counts].sort(
        ([leftKey, leftCount], [rightKey, rightCount]) =>
          rightCount - leftCount || leftKey.localeCompare(rightKey),
      ),
    ),
  );
}

function normalizedTerminalReason(reason: string): string {
  return reason
    .replace(/\b[A-Za-z_$][A-Za-z0-9_$]*-\d+\b/g, '<generated-key>')
    .replace(/\s+/g, ' ')
    .trim();
}

function errorMessage(error: mixed): string {
  return error instanceof Error ? error.message : String(error);
}

export function evaluateCorpusSources(
  sources: $ReadOnlyArray<CorpusSource>,
): CorpusSummary {
  const files = {
    scanned: sources.length,
    mentioningEmotion: 0,
    recognizedEmotion: 0,
    proposed: 0,
    partiallyProposed: 0,
    noSupportedSites: 0,
    refused: 0,
    notEmotion: 0,
    crashed: 0,
  };
  let proposedSites = 0;
  let refusedDuringDiscovery = 0;
  const comparisonModels = new Map<string, number>();
  const discoveryRefusals = new Map<string, number>();
  const terminalRefusals = new Map<string, number>();
  const crashes: Array<{ +filename: string, +error: string }> = [];

  for (const input of sources) {
    // Every currently supported Emotion activation contains this exact text.
    // Avoiding a full Babel parse for unrelated files makes large-repository
    // evaluations cheap without changing the proposer's eligibility rules.
    if (!input.source.includes('@emotion')) {
      files.notEmotion += 1;
      continue;
    }
    files.mentioningEmotion += 1;

    let proposal: Proposal;
    try {
      proposal = proposeStaticConversion(input);
    } catch (error) {
      files.crashed += 1;
      crashes.push(
        Object.freeze({
          filename: input.filename,
          error: errorMessage(error),
        }),
      );
      continue;
    }

    if (proposal.status === 'proposed') {
      files.recognizedEmotion += 1;
      files.proposed += 1;
      proposedSites += proposal.entries.length;
      bump(comparisonModels, proposal.model);
      if (proposal.refusals.length > 0) {
        files.partiallyProposed += 1;
      }
      for (const refusal of proposal.refusals) {
        refusedDuringDiscovery += 1;
        bump(discoveryRefusals, refusal.reason);
      }
      continue;
    }

    if (proposal.status === 'unchanged') {
      if (proposal.reason === 'not-emotion') {
        files.notEmotion += 1;
      } else {
        files.recognizedEmotion += 1;
        files.noSupportedSites += 1;
      }
      for (const refusal of proposal.refusals) {
        refusedDuringDiscovery += 1;
        bump(discoveryRefusals, refusal.reason);
      }
      continue;
    }

    files.recognizedEmotion += 1;
    files.refused += 1;
    bump(terminalRefusals, normalizedTerminalReason(proposal.reason));
  }

  return Object.freeze({
    files: Object.freeze(files),
    sites: Object.freeze({
      proposed: proposedSites,
      refusedDuringDiscovery,
    }),
    comparisonModels: sortedCounts(comparisonModels),
    discoveryRefusals: sortedCounts(discoveryRefusals),
    terminalRefusals: sortedCounts(terminalRefusals),
    crashes: Object.freeze(crashes),
  });
}

function countLines(counts: { +[string]: number }): $ReadOnlyArray<string> {
  const entries = Object.entries(counts);
  return entries.length === 0
    ? ['- none']
    : entries.map(([name, count]) => `- ${count} — \`${name}\``);
}

export function formatCorpusSummary({
  label,
  revision,
  summary,
}: {
  +label: string,
  +revision: string,
  +summary: CorpusSummary,
}): string {
  return [
    `# Phase C corpus report — ${label}`,
    '',
    `Revision: \`${revision}\``,
    '',
    '## Files',
    '',
    `- source files scanned: ${summary.files.scanned}`,
    `- files mentioning Emotion: ${summary.files.mentioningEmotion}`,
    `- files recognized by the Emotion adapter: ${summary.files.recognizedEmotion}`,
    `- files with correctness-gated proposals: ${summary.files.proposed}`,
    `- proposed files that also contain refused sites: ${summary.files.partiallyProposed}`,
    `- recognized files with no supported sites: ${summary.files.noSupportedSites}`,
    `- files refused during proposal or evidence: ${summary.files.refused}`,
    `- files outside the current Emotion activation boundary: ${summary.files.notEmotion}`,
    `- crashes: ${summary.files.crashed}`,
    '',
    '## Sites',
    '',
    `- correctness-gated proposed sites: ${summary.sites.proposed}`,
    `- sites refused during discovery: ${summary.sites.refusedDuringDiscovery}`,
    '',
    'These are counts, not a conversion percentage or a safety claim. A proposal',
    'is counted only after all mechanical evidence checks pass for the generated',
    'candidate bytes.',
    '',
    '## Comparison models used by passing proposals',
    '',
    ...countLines(summary.comparisonModels),
    '',
    '## Discovery refusal reasons',
    '',
    ...countLines(summary.discoveryRefusals),
    '',
    '## Terminal proposal or evidence refusals',
    '',
    ...countLines(summary.terminalRefusals),
    '',
    '## Crashes',
    '',
    ...(summary.crashes.length === 0
      ? ['- none']
      : summary.crashes.map(
          (crash) => `- \`${crash.filename}\` — ${crash.error}`,
        )),
    '',
  ].join('\n');
}

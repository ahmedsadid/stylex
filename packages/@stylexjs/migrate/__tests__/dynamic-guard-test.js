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
import {
  createPlan,
  initializeProject,
  loadVerificationCandidate,
  openContextTask,
  persistDynamicStrategyDraft,
  saveInventory,
  savePlan,
  scanRepository,
  submitContextAttempt,
} from '../src/index';
import { createTempDir, createTempRepo, removeTempDir } from './utils/tempRepo';

const SOURCE = `import styled from '@emotion/styled';
const MeterRoot = styled.div<{active: boolean; width: number}>\`
  color: \${p => (p.active ? 'red' : 'blue')};
  width: \${({width}) => width}px;
\`;
export function Meter({active, width}: {active: boolean; width: number}) {
  return <MeterRoot className="meter" style={{minWidth: 1}} active={active} width={width} />;
}
`;

function fixture(): $FlowFixMe {
  const repo = createTempRepo({ 'src/Meter.tsx': SOURCE });
  const workspaceRoot = createTempDir('stylex-migrate-dynamic-guard-');
  const project = initializeProject({ repositoryRoot: repo });
  const inventory = scanRepository({ repositoryRoot: repo });
  const plan = createPlan({ inventory });
  const site = inventory.sites.find(
    (item) => item.kind === 'styled-dynamic-intrinsic',
  );
  const cluster = plan.clusters.find((item) =>
    item.siteIds.includes(site?.id ?? ''),
  );
  const dynamicFact = inventory.facts.find(
    (item) => item.kind === 'emotion-styled-dynamic-value',
  );
  if (cluster == null || dynamicFact == null) {
    throw new Error('Fixture did not produce a dynamic cluster');
  }
  const dynamic: $FlowFixMe = dynamicFact.value;
  saveInventory(project, inventory);
  savePlan(project, plan);
  persistDynamicStrategyDraft({
    project,
    definition: {
      protocolVersion: 'stylex-migrate-dynamic-strategy-v1',
      inventoryId: inventory.id,
      clusterId: cluster.id,
      entries: [
        {
          definitionFactId: dynamic.definitionFactId,
          propPath: 'active',
          strategy: 'stylex-variants',
          rationale: 'The observed source has a finite boolean conditional.',
          evidenceRequirements: ['Exercise both active states.'],
        },
        {
          definitionFactId: dynamic.definitionFactId,
          propPath: 'width',
          strategy: 'css-variable',
          rationale: 'Width remains a runtime scalar at the render boundary.',
          evidenceRequirements: ['Exercise representative width values.'],
        },
      ],
    },
    authorKind: 'agent',
    authoredBy: 'fixture-agent',
  });
  const opened = openContextTask({
    project,
    clusterId: cluster.id,
    goal: 'Convert the dynamic styled boundary.',
    workspaceRoot,
  });
  if (!opened.ok) throw new Error(opened.reasons.join('\n'));
  return { repo, workspaceRoot, project, opened };
}

function writeCandidate(opened: $FlowFixMe, source: string): void {
  fs.writeFileSync(
    path.join(opened.attempt.workspace.path, 'src/Meter.tsx'),
    source,
    'utf8',
  );
}

function submit(value: $FlowFixMe): $FlowFixMe {
  return submitContextAttempt({
    project: value.project,
    taskId: value.opened.task.id,
    proposerKind: 'agent',
    proposerVersion: 'fixture-v1',
    proposerName: 'fixture-agent',
  });
}

describe('dynamic strategy frozen-candidate guard', () => {
  test('records bounded wiring evidence for a structurally complete rewrite', () => {
    const value = fixture();
    try {
      writeCandidate(
        value.opened,
        `import * as stylex from '@stylexjs/stylex';
const styles = stylex.create({
  root: {color: 'blue', width: 'var(--meter-width)'},
  active: {color: 'red'},
});
export function Meter({active, width}: {active: boolean; width: number}) {
  return <div {...stylex.props(styles.root, active && styles.active)} className="meter" style={{minWidth: 1, '--meter-width': width + 'px'}} />;
}
`,
      );
      const result = submit(value);
      expect(result).toMatchObject({
        ok: true,
        state: 'awaiting-verification',
      });
      const candidate = loadVerificationCandidate(
        value.project,
        result.candidateId,
      );
      expect(candidate?.staticEvidence).toEqual([
        expect.objectContaining({
          check: 'dynamic-strategy-wiring',
          result: 'pass',
          subject: expect.objectContaining({
            file: 'src/Meter.tsx',
            model: 'dynamic-strategy-wiring-v1',
          }),
          limitations: [expect.stringContaining('does not establish runtime')],
        }),
      ]);
    } finally {
      removeTempDir(value.workspaceRoot);
      removeTempDir(value.repo);
    }
  });

  test('rejects leftover consumers, styling prop leaks, and lost merge surfaces', () => {
    const value = fixture();
    try {
      writeCandidate(
        value.opened,
        `import * as stylex from '@stylexjs/stylex';
const styles = stylex.create({root: {color: 'red'}});
export function Meter({active, width}: {active: boolean; width: number}) {
  return <div {...stylex.props(styles.root)} active={active} width={width} />;
}
`,
      );
      expect(submit(value)).toMatchObject({
        ok: false,
        state: 'needs-replan',
        reasons: expect.arrayContaining([
          expect.stringContaining('lost the observable className'),
          expect.stringContaining('lost the observable style'),
          expect.stringContaining('styling prop active'),
          expect.stringContaining('styling prop width'),
        ]),
      });
    } finally {
      removeTempDir(value.workspaceRoot);
      removeTempDir(value.repo);
    }
  });

  test('rejects a partial rewrite that leaves the old boundary', () => {
    const value = fixture();
    try {
      writeCandidate(
        value.opened,
        SOURCE.replace(
          "import styled from '@emotion/styled';",
          "import styled from '@emotion/styled';\nimport * as stylex from '@stylexjs/stylex';",
        ),
      );
      expect(submit(value)).toMatchObject({
        ok: false,
        state: 'needs-replan',
        reasons: expect.arrayContaining([
          expect.stringContaining('old JSX consumer remains'),
        ]),
      });
    } finally {
      removeTempDir(value.workspaceRoot);
      removeTempDir(value.repo);
    }
  });
});

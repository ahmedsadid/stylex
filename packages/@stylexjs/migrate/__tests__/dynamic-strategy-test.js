/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import path from 'path';
import { runCli } from '../src/cli';
import {
  DYNAMIC_STRATEGY_PROTOCOL_VERSION,
  createPlan,
  currentDynamicStrategy,
  initializeProject,
  inspectDynamicStrategy,
  persistDynamicStrategyDraft,
  saveInventory,
  savePlan,
  scanRepository,
} from '../src/index';
import type { Inventory, Plan, ProjectState } from '../src/index';
import {
  createTempDir,
  createTempRepo,
  removeTempDir,
  writeFiles,
} from './utils/tempRepo';

function command(repo: string, args: $ReadOnlyArray<string>): $FlowFixMe {
  let stdout = '';
  let stderr = '';
  const code = runCli([...args, '--json'], {
    cwd: repo,
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  return {
    code,
    stderr,
    json: stdout === '' ? null : JSON.parse(stdout),
  };
}

describe('dynamic strategy decisions', () => {
  let repo: string;
  let inputRoot: string;
  let project: ProjectState;
  let inventory: Inventory;
  let plan: Plan;
  let clusterId: string;
  let definitionFactId: string;

  beforeEach(() => {
    repo = createTempRepo({
      'src/Meter.tsx': `import styled from '@emotion/styled';
const MeterRoot = styled.div<{active: boolean; width: number}>\`
  color: \${p => (p.active ? 'red' : 'blue')};
  width: \${({width}) => width}px;
\`;
export function Meter({active, width}: {active: boolean; width: number}) {
  return <MeterRoot active={active} width={width} />;
}
`,
    });
    inputRoot = createTempDir('stylex-migrate-dynamic-strategy-');
    project = initializeProject({ repositoryRoot: repo });
    inventory = scanRepository({ repositoryRoot: repo });
    plan = createPlan({ inventory });
    const site = inventory.sites.find(
      (item) => item.kind === 'styled-dynamic-intrinsic',
    );
    const cluster = plan.clusters.find((item) =>
      item.siteIds.includes(site?.id ?? ''),
    );
    const fact = inventory.facts.find(
      (item) => item.kind === 'emotion-styled-dynamic-value',
    );
    if (cluster == null || fact == null) {
      throw new Error('Fixture did not produce a dynamic strategy cluster');
    }
    clusterId = cluster.id;
    definitionFactId = String((fact.value as $FlowFixMe).definitionFactId);
    saveInventory(project, inventory);
    savePlan(project, plan);
  });

  afterEach(() => {
    removeTempDir(inputRoot);
    removeTempDir(repo);
  });

  function definition(widthStrategy: string = 'css-variable'): $FlowFixMe {
    return {
      protocolVersion: DYNAMIC_STRATEGY_PROTOCOL_VERSION,
      inventoryId: inventory.id,
      clusterId,
      entries: [
        {
          definitionFactId,
          propPath: 'active',
          strategy: 'stylex-variants',
          rationale: 'The component prop is a declared boolean.',
          evidenceRequirements: ['active=false and active=true runtime cases'],
        },
        {
          definitionFactId,
          propPath: 'width',
          strategy: widthStrategy,
          rationale: 'Width is a runtime scalar.',
          evidenceRequirements: ['nullish and representative width cases'],
        },
      ],
    };
  }

  test('persists exact coverage and supersedes an earlier cluster strategy', () => {
    const first = persistDynamicStrategyDraft({
      project,
      definition: definition(),
      authorKind: 'agent',
      authoredBy: 'fixture-agent',
    });
    expect(currentDynamicStrategy(project, clusterId)?.id).toBe(first.id);
    expect(inspectDynamicStrategy(project, first.id)).toMatchObject({
      state: 'active',
      activeDefinitionHash: first.definitionHash,
    });

    const second = persistDynamicStrategyDraft({
      project,
      definition: definition('inline-style'),
      authorKind: 'human',
      authoredBy: 'fixture-reviewer',
    });
    expect(second.id).not.toBe(first.id);
    expect(inspectDynamicStrategy(project, first.id).state).toBe('superseded');
    expect(inspectDynamicStrategy(project, second.id).state).toBe('active');
  });

  test('requires every and only observed prop path', () => {
    const missing = definition();
    missing.entries.pop();
    expect(() =>
      persistDynamicStrategyDraft({
        project,
        definition: missing,
        authorKind: 'agent',
        authoredBy: 'fixture-agent',
      }),
    ).toThrow('missing');

    const mixedRetention = definition();
    mixedRetention.entries[0].strategy = 'retain-emotion';
    expect(() =>
      persistDynamicStrategyDraft({
        project,
        definition: mixedRetention,
        authorKind: 'agent',
        authoredBy: 'fixture-agent',
      }),
    ).toThrow('retain Emotion for every prop path or none');
  });

  test('drafts and inspects through the stable CLI', () => {
    const input = path.join(inputRoot, 'strategy.json');
    writeFiles(inputRoot, {
      'strategy.json': JSON.stringify(definition()),
    });
    const drafted = command(repo, [
      'dynamic',
      'strategy',
      'draft',
      input,
      'agent',
      'fixture-agent',
    ]);
    expect(drafted).toMatchObject({
      code: 0,
      json: {
        command: 'dynamic strategy draft',
        state: 'active',
        draft: {
          id: expect.stringMatching(/^dynamic-strategy-/),
          clusterId,
          entries: [
            { propPath: 'active', strategy: 'stylex-variants' },
            { propPath: 'width', strategy: 'css-variable' },
          ],
        },
      },
    });
    expect(
      command(repo, ['dynamic', 'strategy', 'inspect', drafted.json.draft.id]),
    ).toMatchObject({
      code: 0,
      json: { command: 'dynamic strategy inspect', state: 'active' },
    });
  });
});

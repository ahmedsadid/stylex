/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { SHORTHAND_MUTATION_MANIFEST, verifyConversion } from '../src/index';
import { convertSource } from '../src/adapters/emotion/convert';
import type { MutationGate, Proposal, ShorthandMutationId } from '../src/index';

const PRAGMA = '/** @jsxImportSource @emotion/react */\n';
const FILENAME = 'Shorthand.jsx';
const SOURCE = `${PRAGMA}export const App = () => <div css={{ marginTop: 20, margin: '4px 8px' }} />;\n`;

function rejectionGate(proposal: Proposal): MutationGate {
  if (proposal.status !== 'refused')
    throw new Error(`mutation was not refused: ${proposal.status}`);
  const failed = proposal.evidence.find((item) => item.result !== 'pass');
  if (failed == null) throw new Error('refusal recorded no rejecting evidence');
  if (failed.check === 'binding-integrity') return 'binding-integrity';
  if (failed.check === 'static-css-comparison')
    return failed.result === 'fail' ? 'referee' : 'observer';
  return 'observer';
}

function mutateCode(
  mutate: (string) => string,
  stale: boolean = false,
): MutationGate {
  const converted = convertSource(SOURCE, FILENAME);
  if (converted.status !== 'converted')
    throw new Error('fixture did not convert');
  const code = mutate(converted.code);
  if (code === converted.code) throw new Error('mutation changed no bytes');
  const entries = stale
    ? converted.entries
    : converted.entries.map((entry) => ({
        ...entry,
        outputStart: code.indexOf(
          `{...${converted.namespace}.props(${converted.registryName}.${entry.key})}`,
        ),
      }));
  return rejectionGate(
    verifyConversion({
      source: SOURCE,
      filename: FILENAME,
      converted: { ...converted, code, entries },
    }),
  );
}

const mutations: { +[ShorthandMutationId]: () => MutationGate } = {
  'top-removed': () =>
    mutateCode((code) => code.replace("    marginTop: '4px',\n", '')),
  'right-mapping-changed': () =>
    mutateCode((code) =>
      code.replace("marginRight: '8px'", "marginRight: '4px'"),
    ),
  'bottom-property-renamed': () =>
    mutateCode((code) => code.replace('marginBottom:', 'paddingBottom:')),
  'left-value-changed': () =>
    mutateCode((code) =>
      code.replace("marginLeft: '8px'", "marginLeft: '12px'"),
    ),
  'top-reset-changed': () =>
    mutateCode((code) => code.replace("marginTop: '4px'", 'marginTop: 20')),
  'unit-changed': () =>
    mutateCode((code) =>
      code.replace("marginBottom: '4px'", "marginBottom: '4em'"),
    ),
  'importance-added': () =>
    mutateCode((code) =>
      code.replace("marginRight: '8px'", "marginRight: '8px !important'"),
    ),
  'extra-longhand-added': () =>
    mutateCode((code) =>
      code.replace('marginBottom:', 'opacity: 1,\n    marginBottom:'),
    ),
  'shorthand-reintroduced': () =>
    mutateCode((code) =>
      code.replace('marginBottom:', "margin: '4px 8px',\n    marginBottom:"),
    ),
  'style-key-wiring-changed': () =>
    mutateCode((code) => code.replace('styles.div)', 'styles.missing)'), true),
};

describe('box shorthand verifier mutation manifest', () => {
  test('has exactly one executable case for every mandatory mutation', () => {
    expect(Object.keys(mutations).sort()).toEqual(
      SHORTHAND_MUTATION_MANIFEST.map((item) => item.id).sort(),
    );
  });
  test.each(SHORTHAND_MUTATION_MANIFEST)(
    'rejects $id through $expectedGate',
    (item) => {
      expect(mutations[item.id]()).toBe(item.expectedGate);
    },
  );
});

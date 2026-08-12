/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  compileStyleX,
  DIRECTIONAL_MUTATION_MANIFEST,
  observeEmotionDirectional,
  observeStyleXDirectionalRules,
  proposeStaticConversion,
  refereeDirectional,
  verifyConversion,
} from '../src/index';
import { convertSource } from '../src/adapters/emotion/convert';
import type {
  DirectionalDeclaration,
  DirectionalMutationId,
  MutationGate,
  Proposal,
} from '../src/index';

const PRAGMA = '/** @jsxImportSource @emotion/react */\n';
const FILENAME = 'Directional.jsx';
const SOURCE = `${PRAGMA}export const App = () => <div css={{ marginInlineStart: '2px', marginLeft: '1px' }} />;\n`;

function rejectionGate(proposal: Proposal): MutationGate {
  if (proposal.status !== 'refused')
    throw new Error(`mutation was not refused: ${proposal.status}`);
  const failed = proposal.evidence.find((item) => item.result !== 'pass');
  if (failed == null) throw new Error('refusal recorded no rejecting evidence');
  if (failed.check === 'binding-integrity') return 'binding-integrity';
  if (failed.check === 'static-css-comparison') {
    if (failed.result === 'fail') return 'referee';
    if (failed.result === 'not-applicable') return 'grammar';
    return 'observer';
  }
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

function observations() {
  const source = observeEmotionDirectional({
    marginInlineStart: '2px',
    marginLeft: '1px',
  });
  const compiled = compileStyleX(
    `import * as stylex from '@stylexjs/stylex';
const styles = stylex.create({ root: { marginInlineStart: '2px', marginLeft: '1px' } });
export const props = stylex.props(styles.root);`,
    'target.js',
  );
  if (!compiled.ok) throw new Error(compiled.reason);
  const target = observeStyleXDirectionalRules(compiled.ruleMetadata);
  if (!source.ok || !target.ok)
    throw new Error(source.ok ? target.reason : source.reason);
  return { source: source.declarations, target: target.declarations };
}

function modelMutation(
  mutate: (DirectionalDeclaration) => DirectionalDeclaration,
  expected: 'mismatch' | 'unsupported',
): MutationGate {
  const values = observations();
  const target = values.target.map((item) =>
    item.property === 'margin-inline-start' ? mutate(item) : item,
  );
  const result = refereeDirectional(values.source, target);
  if (result.status !== expected)
    throw new Error(`mutation escaped with ${result.status}`);
  return expected === 'unsupported' ? 'grammar' : 'referee';
}

const mutations: { +[DirectionalMutationId]: () => MutationGate } = {
  'logical-declaration-removed': () =>
    mutateCode((code) => code.replace("    marginInlineStart: '2px',\n", '')),
  'logical-value-changed': () =>
    mutateCode((code) =>
      code.replace("marginInlineStart: '2px'", "marginInlineStart: '3px'"),
    ),
  'physical-value-changed': () =>
    mutateCode((code) =>
      code.replace("marginLeft: '1px'", "marginLeft: '3px'"),
    ),
  'physical-property-renamed': () =>
    mutateCode((code) => code.replace('marginLeft:', 'paddingLeft:')),
  'priority-changed': () =>
    modelMutation((item) => ({ ...item, stylexPriority: 5000 }), 'mismatch'),
  'logical-axis-changed': () =>
    modelMutation(
      (item) => ({ ...item, property: 'margin-block-start' }),
      'mismatch',
    ),
  'source-order-reversed': () =>
    rejectionGate(
      proposeStaticConversion({
        source: `${PRAGMA}export const App = () => <div css={{ marginLeft: '1px', marginInlineStart: '2px' }} />;\n`,
        filename: FILENAME,
      }),
    ),
  'importance-added': () =>
    modelMutation((item) => ({ ...item, important: true }), 'unsupported'),
  'extra-property-added': () =>
    mutateCode((code) =>
      code.replace('marginLeft:', 'opacity: 1,\n    marginLeft:'),
    ),
  'style-key-wiring-changed': () =>
    mutateCode((code) => code.replace('styles.div)', 'styles.missing)'), true),
};

describe('directional verifier mutation manifest', () => {
  test('has exactly one executable case for every mandatory mutation', () => {
    expect(Object.keys(mutations).sort()).toEqual(
      DIRECTIONAL_MUTATION_MANIFEST.map((item) => item.id).sort(),
    );
  });
  test.each(DIRECTIONAL_MUTATION_MANIFEST)(
    'rejects $id through $expectedGate',
    (item) => {
      expect(mutations[item.id]()).toBe(item.expectedGate);
    },
  );
});

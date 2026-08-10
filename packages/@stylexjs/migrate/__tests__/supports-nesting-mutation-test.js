/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  emotionSupportsNestingBaseline,
  observeStyleXCompilation,
  proposeStaticConversion,
  refereeSupportsNesting,
  SUPPORTS_NESTING_MUTATION_MANIFEST,
  verifyConversion,
} from '../src/index';
import { convertSource } from '../src/adapters/emotion/convert';
import type {
  MutationGate,
  Proposal,
  RefereeDeclaration,
  SupportsNestingMutationId,
} from '../src/index';

const PRAGMA = '/** @jsxImportSource @emotion/react */\n';
const FILENAME = 'Supports.jsx';
const SUPPORTS = '@supports (display: grid)';
const MEDIA = '@media (min-width: 800px)';
const OBJECT = `{ color: 'black', '${SUPPORTS}': { color: 'blue', '${MEDIA}': { color: 'purple' } } }`;
const SOURCE = `${PRAGMA}export const App = () => <div css={${OBJECT}} />;\n`;
const STYLEX_SOURCE = `import * as stylex from '@stylexjs/stylex';
const styles = stylex.create({ root: { color: { default: 'black', '${SUPPORTS}': { default: 'blue', '${MEDIA}': 'purple' } } } });
export const props = stylex.props(styles.root);`;

function rejectionGate(proposal: Proposal): MutationGate {
  if (proposal.status !== 'refused') {
    throw new Error(`mutation was not refused: ${proposal.status}`);
  }
  const failed = proposal.evidence.find((result) => result.result !== 'pass');
  if (failed == null) throw new Error('refusal recorded no rejecting evidence');
  if (failed.check === 'binding-integrity') return 'binding-integrity';
  if (failed.check === 'static-css-comparison') {
    if (failed.result === 'fail') return 'referee';
    if (failed.result === 'not-applicable') return 'grammar';
    return 'observer';
  }
  return 'observer';
}

function verifyCodeMutation(
  mutate: (string) => string,
  preserveStaleBinding: boolean = false,
): MutationGate {
  const converted = convertSource(SOURCE, FILENAME);
  if (converted.status !== 'converted')
    throw new Error('fixture did not convert');
  const code = mutate(converted.code);
  if (code === converted.code) throw new Error('mutation changed no bytes');
  const entries = preserveStaleBinding
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

function observed() {
  const source = emotionSupportsNestingBaseline(OBJECT);
  const target = observeStyleXCompilation(STYLEX_SOURCE, 'target.js');
  if (!source.ok || !target.ok)
    throw new Error(source.ok ? target.reason : source.reason);
  return { source: source.declarations, target: target.declarations };
}

function grammarMutation(
  mutate: (RefereeDeclaration) => RefereeDeclaration,
): MutationGate {
  const values = observed();
  const target = values.target.map((declaration) =>
    declaration.conditions.length > 0 ? mutate(declaration) : declaration,
  );
  if (refereeSupportsNesting(values.source, target).status !== 'unsupported') {
    throw new Error('mutation escaped the supports grammar gate');
  }
  return 'grammar';
}

const mutations: { +[SupportsNestingMutationId]: () => MutationGate } = {
  'intersection-removed': () =>
    verifyCodeMutation((code) =>
      code.replace(`      '${MEDIA}': 'purple',\n`, ''),
    ),
  'supports-query-changed': () =>
    verifyCodeMutation((code) =>
      code.replace(SUPPORTS, '@supports (display: flex)'),
    ),
  'source-branch-reordered': () =>
    rejectionGate(
      proposeStaticConversion({
        source: `${PRAGMA}export const App = () => <div css={{ '${SUPPORTS}': { color: 'blue' }, color: 'black' }} />;\n`,
        filename: FILENAME,
      }),
    ),
  'property-renamed': () =>
    verifyCodeMutation((code) =>
      code.replace('    color: {', '    backgroundColor: {'),
    ),
  'value-changed': () =>
    verifyCodeMutation((code) => code.replace("'purple'", "'orange'")),
  'importance-added': () =>
    grammarMutation((declaration) => ({ ...declaration, important: true })),
  'specificity-changed': () =>
    grammarMutation((declaration) => ({
      ...declaration,
      specificity: [0, 4, 0],
    })),
  'second-supports-added': () =>
    grammarMutation((declaration) => ({
      ...declaration,
      conditions: [...declaration.conditions, '@supports (display: flex)'],
    })),
  'third-level-added': () =>
    grammarMutation((declaration) => ({
      ...declaration,
      conditions: [...declaration.conditions, '@media (max-width: 400px)'],
    })),
  'style-key-wiring-changed': () =>
    verifyCodeMutation(
      (code) => code.replace('styles.div)', 'styles.missing)'),
      true,
    ),
};

describe('supports nesting verifier mutation manifest', () => {
  test('has exactly one executable case for every mandatory mutation', () => {
    expect(Object.keys(mutations).sort()).toEqual(
      SUPPORTS_NESTING_MUTATION_MANIFEST.map((item) => item.id).sort(),
    );
  });

  test.each(SUPPORTS_NESTING_MUTATION_MANIFEST)(
    'rejects $id through $expectedGate',
    (mutation) => {
      expect(mutations[mutation.id]()).toBe(mutation.expectedGate);
    },
  );
});

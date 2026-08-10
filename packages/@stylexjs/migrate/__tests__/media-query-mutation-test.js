/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  emotionMediaQueryBaseline,
  MEDIA_QUERY_MUTATION_MANIFEST,
  observeStyleXCompilation,
  proposeStaticConversion,
  refereeMediaQueries,
  verifyConversion,
} from '../src/index';
import { convertSource } from '../src/adapters/emotion/convert';
import type {
  MediaQueryMutationId,
  MutationGate,
  Proposal,
  RefereeDeclaration,
} from '../src/index';

const PRAGMA = '/** @jsxImportSource @emotion/react */\n';
const FILENAME = 'MediaQuery.jsx';
const QUERY = '@media (min-width: 800px)';
const OBJECT = `{ color: 'black', '${QUERY}': { color: 'blue' } }`;
const SOURCE = `${PRAGMA}export const App = () => <div css={${OBJECT}} />;\n`;
const STYLEX_SOURCE = `import * as stylex from '@stylexjs/stylex';
const styles = stylex.create({ root: { color: { default: 'black', '${QUERY}': 'blue' } } });
export const props = stylex.props(styles.root);`;

function rejectionGate(proposal: Proposal): MutationGate {
  if (proposal.status !== 'refused') {
    throw new Error(`mutation was not refused: ${proposal.status}`);
  }
  const failed = proposal.evidence.find((result) => result.result !== 'pass');
  if (failed == null) {
    throw new Error('refusal did not record a rejecting evidence result');
  }
  if (failed.check === 'binding-integrity') return 'binding-integrity';
  if (failed.check === 'static-css-comparison') {
    if (failed.result === 'fail') return 'referee';
    if (failed.result === 'not-applicable') return 'grammar';
    return 'observer';
  }
  if (
    failed.check === 'stylex-plugin-transform' ||
    failed.check === 'stylex-lint'
  ) {
    return 'observer';
  }
  throw new Error(`unclassified rejecting check: ${failed.check}`);
}

function verifyCodeMutation(
  mutate: (string) => string,
  { preserveStaleBinding = false }: { +preserveStaleBinding?: boolean } = {},
): MutationGate {
  const converted = convertSource(SOURCE, FILENAME);
  if (converted.status !== 'converted') {
    throw new Error('fixture did not convert');
  }
  const code = mutate(converted.code);
  if (code === converted.code) throw new Error('mutation changed no bytes');
  const entries = preserveStaleBinding
    ? converted.entries
    : converted.entries.map((entry) => {
        const spread = `{...${converted.namespace}.props(${converted.registryName}.${entry.key})}`;
        const outputStart = code.indexOf(spread);
        if (outputStart < 0) {
          throw new Error(`mutation lost the spread for ${entry.key}`);
        }
        return { ...entry, outputStart };
      });
  return rejectionGate(
    verifyConversion({
      source: SOURCE,
      filename: FILENAME,
      converted: { ...converted, code, entries },
    }),
  );
}

function observedDeclarations(): {
  +source: $ReadOnlyArray<RefereeDeclaration>,
  +target: $ReadOnlyArray<RefereeDeclaration>,
} {
  const source = emotionMediaQueryBaseline(OBJECT);
  const target = observeStyleXCompilation(STYLEX_SOURCE, 'target.js');
  if (!source.ok || !target.ok) {
    throw new Error(source.ok ? target.reason : source.reason);
  }
  return { source: source.declarations, target: target.declarations };
}

function grammarMutation(
  mutate: (RefereeDeclaration) => RefereeDeclaration,
): MutationGate {
  const observed = observedDeclarations();
  const target = observed.target.map((declaration) =>
    declaration.conditions.length > 0 ? mutate(declaration) : declaration,
  );
  if (refereeMediaQueries(observed.source, target).status !== 'unsupported') {
    throw new Error('mutation escaped the media-query grammar gate');
  }
  return 'grammar';
}

const mutations: {
  +[MediaQueryMutationId]: () => MutationGate,
} = {
  'query-removed': () =>
    verifyCodeMutation((code) =>
      code.replace(`      '${QUERY}': 'blue',\n`, ''),
    ),
  'query-changed': () =>
    verifyCodeMutation((code) =>
      code.replace(QUERY, '@media (min-width: 1200px)'),
    ),
  'source-branch-reordered': () =>
    rejectionGate(
      proposeStaticConversion({
        source: `${PRAGMA}export const App = () => <div css={{ '${QUERY}': { color: 'blue' }, color: 'black' }} />;\n`,
        filename: FILENAME,
      }),
    ),
  'property-renamed': () =>
    verifyCodeMutation((code) =>
      code.replace('    color: {', '    backgroundColor: {'),
    ),
  'value-changed': () =>
    verifyCodeMutation((code) =>
      code.replace(`'${QUERY}': 'blue'`, `'${QUERY}': 'purple'`),
    ),
  'importance-added': () =>
    grammarMutation((declaration) => ({ ...declaration, important: true })),
  'specificity-changed': () =>
    grammarMutation((declaration) => ({
      ...declaration,
      specificity: [0, 3, 0],
    })),
  'second-query-added': () =>
    grammarMutation((declaration) => ({
      ...declaration,
      conditions: [...declaration.conditions, '@media (max-width: 400px)'],
    })),
  'at-rule-kind-changed': () =>
    verifyCodeMutation((code) =>
      code.replace('@media (min-width: 800px)', '@supports (display: grid)'),
    ),
  'style-key-wiring-changed': () =>
    verifyCodeMutation(
      (code) => code.replace('styles.div)', 'styles.missing)'),
      { preserveStaleBinding: true },
    ),
};

describe('media-query verifier mutation manifest', () => {
  test('has exactly one executable case for every mandatory mutation', () => {
    expect(Object.keys(mutations).sort()).toEqual(
      MEDIA_QUERY_MUTATION_MANIFEST.map((mutation) => mutation.id).sort(),
    );
  });

  test.each(MEDIA_QUERY_MUTATION_MANIFEST)(
    'rejects $id through $expectedGate',
    (mutation) => {
      expect(mutations[mutation.id]()).toBe(mutation.expectedGate);
    },
  );
});

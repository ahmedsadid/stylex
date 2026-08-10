/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  CONDITIONAL_MUTATION_MANIFEST,
  emotionConditionalBaseline,
  observeStyleXCompilation,
  proposeStaticConversion,
  referee,
  verifyConversion,
} from '../src/index';
import { convertSource } from '../src/adapters/emotion/convert';
import type {
  ConditionalMutationGate,
  ConditionalMutationId,
  Proposal,
  RefereeDeclaration,
} from '../src/index';

const PRAGMA = '/** @jsxImportSource @emotion/react */\n';
const FILENAME = 'Conditional.jsx';
const OBJECT =
  "{ color: 'base', ':hover': { color: 'hover' }, ':focus': { color: 'focus' } }";
const SOURCE = `${PRAGMA}export const App = () => <div css={${OBJECT}} />;\n`;
const STYLEX_SOURCE = `import * as stylex from "@stylexjs/stylex";
const styles = stylex.create({ root: { color: { default: "base", ":hover": "hover", ":focus": "focus" } } });
export const props = stylex.props(styles.root);`;

function rejectionGate(proposal: Proposal): ConditionalMutationGate {
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
): ConditionalMutationGate {
  const converted = convertSource(SOURCE, FILENAME);
  if (converted.status !== 'converted')
    throw new Error('fixture did not convert');
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
  const source = emotionConditionalBaseline(OBJECT);
  const target = observeStyleXCompilation(STYLEX_SOURCE, 'target.js');
  if (!source.ok || !target.ok) {
    throw new Error(source.ok ? target.reason : source.reason);
  }
  return { source: source.declarations, target: target.declarations };
}

const mutations: {
  +[ConditionalMutationId]: () => ConditionalMutationGate,
} = {
  'condition-removed': () =>
    verifyCodeMutation((code) =>
      code.replace("      ':hover': 'hover',\n", ''),
    ),
  'condition-renamed': () =>
    verifyCodeMutation((code) => code.replace("':hover'", "':active'")),
  'branch-reordered': () =>
    rejectionGate(
      proposeStaticConversion({
        source: `${PRAGMA}export const App = () => <div css={{ color: 'base', ':focus': { color: 'focus' }, ':hover': { color: 'hover' } }} />;\n`,
        filename: FILENAME,
      }),
    ),
  'property-renamed': () =>
    verifyCodeMutation((code) =>
      code.replace('    color: {', '    opacity: {'),
    ),
  'value-changed': () =>
    verifyCodeMutation((code) =>
      code.replace("':hover': 'hover'", "':hover': 'changed'"),
    ),
  'priority-changed': () => {
    const observed = observedDeclarations();
    const target = observed.target.map((declaration) =>
      declaration.conditions.includes(':hover')
        ? { ...declaration, stylexPriority: 4000 }
        : declaration,
    );
    if (referee(observed.source, target).status !== 'mismatch') {
      throw new Error('priority mutation escaped the referee');
    }
    return 'referee';
  },
  'specificity-changed': () => {
    const observed = observedDeclarations();
    const target: $ReadOnlyArray<RefereeDeclaration> = observed.target.map(
      (declaration) =>
        declaration.conditions.includes(':hover')
          ? { ...declaration, specificity: [0, 3, 0] }
          : declaration,
    );
    if (referee(observed.source, target).status !== 'unsupported') {
      throw new Error('specificity mutation escaped the grammar gate');
    }
    return 'grammar';
  },
  'importance-added': () => {
    const observed = observedDeclarations();
    const target = observed.target.map((declaration) =>
      declaration.conditions.includes(':hover')
        ? { ...declaration, important: true }
        : declaration,
    );
    if (referee(observed.source, target).status !== 'unsupported') {
      throw new Error('importance mutation escaped the grammar gate');
    }
    return 'grammar';
  },
  'pseudo-element-target-changed': () => {
    const observed = observedDeclarations();
    const target = observed.target.map((declaration) =>
      declaration.conditions.includes(':hover')
        ? { ...declaration, pseudoElement: '::before' }
        : declaration,
    );
    if (referee(observed.source, target).status !== 'unsupported') {
      throw new Error('pseudo-element mutation escaped the grammar gate');
    }
    return 'grammar';
  },
  'style-key-wiring-changed': () =>
    verifyCodeMutation(
      (code) => code.replace('styles.div)', 'styles.missing)'),
      { preserveStaleBinding: true },
    ),
};

describe('conditional verifier mutation manifest', () => {
  test('has exactly one executable case for every mandatory mutation', () => {
    expect(Object.keys(mutations).sort()).toEqual(
      CONDITIONAL_MUTATION_MANIFEST.map((mutation) => mutation.id).sort(),
    );
  });

  test.each(CONDITIONAL_MUTATION_MANIFEST)(
    'rejects $id through $expectedGate',
    (mutation) => {
      expect(mutations[mutation.id]()).toBe(mutation.expectedGate);
    },
  );
});

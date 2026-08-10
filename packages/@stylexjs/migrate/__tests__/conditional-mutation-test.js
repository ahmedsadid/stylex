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
import type { ConditionalMutationId, RefereeDeclaration } from '../src/index';

const PRAGMA = '/** @jsxImportSource @emotion/react */\n';
const FILENAME = 'Conditional.jsx';
const OBJECT =
  "{ color: 'base', ':hover': { color: 'hover' }, ':focus': { color: 'focus' } }";
const SOURCE = `${PRAGMA}export const App = () => <div css={${OBJECT}} />;\n`;
const STYLEX_SOURCE = `import * as stylex from "@stylexjs/stylex";
const styles = stylex.create({ root: { color: { default: "base", ":hover": "hover", ":focus": "focus" } } });
export const props = stylex.props(styles.root);`;

function verifyCodeMutation(mutate: (string) => string): boolean {
  const converted = convertSource(SOURCE, FILENAME);
  if (converted.status !== 'converted')
    throw new Error('fixture did not convert');
  const code = mutate(converted.code);
  if (code === converted.code) throw new Error('mutation changed no bytes');
  return (
    verifyConversion({
      source: SOURCE,
      filename: FILENAME,
      converted: { ...converted, code },
    }).status === 'refused'
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
  +[ConditionalMutationId]: () => boolean,
} = {
  'condition-removed': () =>
    verifyCodeMutation((code) =>
      code.replace("      ':hover': 'hover',\n", ''),
    ),
  'condition-renamed': () =>
    verifyCodeMutation((code) => code.replace("':hover'", "':active'")),
  'branch-reordered': () =>
    proposeStaticConversion({
      source: `${PRAGMA}export const App = () => <div css={{ color: 'base', ':focus': { color: 'focus' }, ':hover': { color: 'hover' } }} />;\n`,
      filename: FILENAME,
    }).status === 'refused',
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
    return referee(observed.source, target).status === 'mismatch';
  },
  'specificity-changed': () => {
    const observed = observedDeclarations();
    const target: $ReadOnlyArray<RefereeDeclaration> = observed.target.map(
      (declaration) =>
        declaration.conditions.includes(':hover')
          ? { ...declaration, specificity: [0, 3, 0] }
          : declaration,
    );
    return referee(observed.source, target).status === 'unsupported';
  },
  'importance-added': () =>
    verifyCodeMutation((code) =>
      code.replace("':hover': 'hover'", "':hover': 'hover !important'"),
    ),
  'pseudo-element-target-changed': () =>
    verifyCodeMutation((code) => code.replace("':hover'", "'::before'")),
  'style-key-wiring-changed': () =>
    verifyCodeMutation((code) =>
      code.replace('styles.div)', 'styles.missing)'),
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
      expect(mutations[mutation.id]()).toBe(true);
    },
  );
});

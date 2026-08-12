/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  proposeStaticConversion,
  RENDER_LOCAL_MUTATION_MANIFEST,
  verifyConversion,
} from '../src/index';
import { convertSource } from '../src/adapters/emotion/convert';
import type {
  MutationGate,
  Proposal,
  RenderLocalMutationId,
} from '../src/index';

const PRAGMA = '/** @jsxImportSource @emotion/react */\n';
const FILENAME = 'RenderLocal.jsx';
const SOURCE = `${PRAGMA}import { css as emotionCss } from '@emotion/react';
export const App = () => <div css={emotionCss({ color: 'red' })} />;\n`;

function discoveryGate(source: string): MutationGate {
  const result = proposeStaticConversion({ source, filename: FILENAME });
  if (result.status !== 'unchanged' || result.refusals.length === 0) {
    throw new Error(`discovery mutation escaped as ${result.status}`);
  }
  return 'discovery';
}

function rejectionGate(proposal: Proposal): MutationGate {
  if (proposal.status !== 'refused')
    throw new Error(`mutation was not refused: ${proposal.status}`);
  const failed = proposal.evidence.find((item) => item.result !== 'pass');
  if (failed?.check === 'binding-integrity') return 'binding-integrity';
  if (failed?.check === 'static-css-comparison' && failed.result === 'fail')
    return 'referee';
  return 'observer';
}

function codeMutation(
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

const mutations: { +[RenderLocalMutationId]: () => MutationGate } = {
  'import-source-changed': () =>
    discoveryGate(SOURCE.replace("'@emotion/react'", "'other-library'")),
  'imported-symbol-changed': () =>
    discoveryGate(SOURCE.replace('css as emotionCss', 'cx as emotionCss')),
  'binding-shadowed': () =>
    discoveryGate(SOURCE.replace('() =>', '(emotionCss) =>')),
  'result-stored': () =>
    discoveryGate(
      SOURCE.replace(
        "export const App = () => <div css={emotionCss({ color: 'red' })} />;",
        "const localStyle = emotionCss({ color: 'red' }); export const App = () => <div css={localStyle} />;",
      ),
    ),
  'extra-argument-added': () =>
    discoveryGate(
      SOURCE.replace("{ color: 'red' })", "{ color: 'red' }, extra)"),
    ),
  'dynamic-argument-used': () =>
    discoveryGate(
      SOURCE.replace("emotionCss({ color: 'red' })", 'emotionCss(styles)'),
    ),
  'object-spread-added': () =>
    discoveryGate(
      SOURCE.replace("{ color: 'red' }", "{ ...base, color: 'red' }"),
    ),
  'effectful-value-added': () =>
    discoveryGate(SOURCE.replace("color: 'red'", 'color: sideEffect()')),
  'output-value-changed': () =>
    codeMutation((code) => code.replace("color: 'red'", "color: 'blue'")),
  'style-key-wiring-changed': () =>
    codeMutation(
      (code) => code.replace('styles.div)', 'styles.missing)'),
      true,
    ),
};

describe('render-local css verifier mutation manifest', () => {
  test('has exactly one executable case for every mandatory mutation', () => {
    expect(Object.keys(mutations).sort()).toEqual(
      RENDER_LOCAL_MUTATION_MANIFEST.map((item) => item.id).sort(),
    );
  });
  test.each(RENDER_LOCAL_MUTATION_MANIFEST)(
    'rejects $id through $expectedGate',
    (item) => {
      expect(mutations[item.id]()).toBe(item.expectedGate);
    },
  );
});

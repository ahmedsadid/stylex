/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  emotionKeyframesBaseline,
  KEYFRAMES_MUTATION_MANIFEST,
  observeStyleXKeyframes,
  refereeKeyframes,
  verifyConversion,
} from '../src/index';
import { convertSource } from '../src/adapters/emotion/convert';
import type {
  KeyframesMutationId,
  KeyframesObservation,
  MutationGate,
  Proposal,
} from '../src/index';

const PRAGMA = '/** @jsxImportSource @emotion/react */\n';
const FILENAME = 'Keyframes.jsx';
const OBJECT =
  "{ animationName: 'fade', animationDuration: '1s', '@keyframes fade': { from: { opacity: 0 }, to: { opacity: 1 } } }";
const SOURCE = `${PRAGMA}export const App = () => <div css={${OBJECT}} />;\n`;

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

function verifyCodeMutation(
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

function observations(): {
  +source: KeyframesObservation,
  +target: KeyframesObservation,
} {
  const source = emotionKeyframesBaseline(OBJECT);
  const target = observeStyleXKeyframes(
    `import * as stylex from '@stylexjs/stylex';
const styles = stylex.create({ root: { animationName: stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } }), animationDuration: '1s' } });
export const props = stylex.props(styles.root);`,
    'target.js',
  );
  if (!source.ok || !target.ok)
    throw new Error(source.ok ? target.reason : source.reason);
  return { source: source.observation, target: target.observation };
}

function modelMutation(
  mutate: (KeyframesObservation) => KeyframesObservation,
  expected: 'mismatch' | 'unsupported',
): MutationGate {
  const values = observations();
  const result = refereeKeyframes(values.source, mutate(values.target));
  if (result.status !== expected)
    throw new Error(`mutation escaped with ${result.status}`);
  return expected === 'unsupported' ? 'grammar' : 'referee';
}

const mutations: { +[KeyframesMutationId]: () => MutationGate } = {
  'frame-removed': () =>
    verifyCodeMutation((code) =>
      code.replace('      to: {\n        opacity: 1,\n      },\n', ''),
    ),
  'frame-selector-changed': () =>
    modelMutation(
      (target) => ({
        ...target,
        frames: target.frames.map((frame) =>
          frame.selector === 'to' ? { ...frame, selector: 'from' } : frame,
        ),
      }),
      'mismatch',
    ),
  'frame-property-renamed': () =>
    verifyCodeMutation((code) =>
      code.replace('      opacity: 1,', '      transform: 1,'),
    ),
  'frame-value-changed': () =>
    verifyCodeMutation((code) =>
      code.replace('      opacity: 1,', '      opacity: 0.5,'),
    ),
  'frame-importance-added': () =>
    modelMutation(
      (target) => ({
        ...target,
        frames: target.frames.map((frame) => ({
          ...frame,
          declarations: frame.declarations.map((item) => ({
            ...item,
            important: true,
          })),
        })),
      }),
      'unsupported',
    ),
  'animation-reference-detached': () =>
    modelMutation(
      (target) => ({ ...target, animationName: 'detached' }),
      'unsupported',
    ),
  'animation-duration-changed': () =>
    verifyCodeMutation((code) =>
      code.replace("animationDuration: '1s'", "animationDuration: '2s'"),
    ),
  'keyframes-call-removed': () =>
    verifyCodeMutation((code) =>
      code.replace(/stylex\.keyframes\(\{[\s\S]*?\n {4}\}\),/, "'detached',"),
    ),
  'second-keyframes-added': () =>
    verifyCodeMutation((code) =>
      code.replace(
        'animationDuration:',
        'backgroundImage: stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } }),\n    animationDuration:',
      ),
    ),
  'style-key-wiring-changed': () =>
    verifyCodeMutation(
      (code) => code.replace('styles.div)', 'styles.missing)'),
      true,
    ),
};

describe('keyframes verifier mutation manifest', () => {
  test('has exactly one executable case for every mandatory mutation', () => {
    expect(Object.keys(mutations).sort()).toEqual(
      KEYFRAMES_MUTATION_MANIFEST.map((item) => item.id).sort(),
    );
  });
  test.each(KEYFRAMES_MUTATION_MANIFEST)(
    'rejects $id through $expectedGate',
    (item) => {
      expect(mutations[item.id]()).toBe(item.expectedGate);
    },
  );
});

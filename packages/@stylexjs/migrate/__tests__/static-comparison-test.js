/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  COMPARISON_MODEL,
  canonicalValue,
  compareDeclarations,
  parseDeclarations,
  parseRule,
} from '../src/compare/model';
import { emotionBaseline } from '../src/adapters/emotion/baseline';
import {
  proposeStaticConversion,
  verifyConversion,
} from '../src/proposers/emotionStatic';
import { convertSource } from '../src/adapters/emotion/convert';

const PRAGMA = '/** @jsxImportSource @emotion/react */\n';
const FILENAME = 'Component.jsx';

function file(styleObject: string): string {
  return `${PRAGMA}export const App = () => <div css={${styleObject}} />;\n`;
}

describe('the comparison model', () => {
  test('canonicalises only differences that carry no meaning', () => {
    expect(canonicalValue('  red  ')).toBe('red');
    expect(canonicalValue('rgb(1, 2, 3)')).toBe('rgb(1,2,3)');
    expect(canonicalValue('.5')).toBe('0.5');
    expect(canonicalValue('-.5')).toBe('-0.5');
    expect(canonicalValue('0 .5px')).toBe('0 0.5px');
  });

  test('keeps differences that do carry meaning', () => {
    expect(canonicalValue('12px')).not.toBe(canonicalValue('12'));
    expect(canonicalValue('red')).not.toBe(canonicalValue('RED'));
    expect(canonicalValue('300ms')).not.toBe(canonicalValue('0.3s'));
  });

  test('reads declaration lists and rule bodies', () => {
    expect(parseDeclarations('color:red;font-size:12px;')).toEqual([
      { property: 'color', value: 'red' },
      { property: 'font-size', value: '12px' },
    ]);
    expect(parseRule('.x1abc{color:red}')).toEqual([
      { property: 'color', value: 'red' },
    ]);
  });

  test('reports what differs, in both directions', () => {
    const result = compareDeclarations(
      [
        { property: 'color', value: 'red' },
        { property: 'display', value: 'block' },
      ],
      [
        { property: 'color', value: 'blue' },
        { property: 'z-index', value: '1' },
      ],
    );
    expect(result.equal).toBe(false);
    expect(result.model).toBe(COMPARISON_MODEL);
    expect(result.differences).toEqual([
      { property: 'color', source: 'red', target: 'blue' },
      { property: 'display', source: 'block', target: null },
      { property: 'z-index', source: null, target: '1' },
    ]);
  });
});

describe('the Emotion baseline', () => {
  test('comes from Emotion, including its own unit handling', () => {
    const result = emotionBaseline("{ color: 'red', fontSize: 12 }");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.css).toBe('color:red;font-size:12px;');
    }
  });

  test('refuses to evaluate anything that is not literals', () => {
    expect(emotionBaseline('{ color: doSomething() }').ok).toBe(false);
    expect(emotionBaseline('{ ...spread }').ok).toBe(false);
    expect(emotionBaseline("{ ':hover': { color: 'red' } }").ok).toBe(false);
  });
});

describe('proposing a conversion', () => {
  test('a correct conversion is claimed static-equivalent, and says what it did not check', () => {
    const result = proposeStaticConversion({
      source: file("{ color: 'red', fontSize: 12 }"),
      filename: FILENAME,
    });
    expect(result.status).toBe('proposed');
    if (result.status !== 'proposed') {
      return;
    }
    expect(result.claim).toBe('static-equivalent');
    expect(result.model).toBe(COMPARISON_MODEL);
    expect(result.entries[0].classNames.length).toBe(2);
    expect(result.evidence.map((item) => item.check)).toEqual([
      'stylex-compile',
      'binding-integrity',
      'static-css-comparison',
    ]);
    expect(result.evidence.every((item) => item.result === 'pass')).toBe(true);
    expect(result.uncovered).toContain(
      'no runtime evidence: nothing was rendered',
    );
  });

  test('records which provider produced each result, and its version', () => {
    const result = proposeStaticConversion({
      source: file("{ color: 'red' }"),
      filename: FILENAME,
    });
    if (result.status !== 'proposed') {
      throw new Error('expected a proposal');
    }
    const compile = result.evidence[0];
    expect(compile.provider).toBe('@stylexjs/babel-plugin');
    expect(compile.providerVersion).not.toBe('unknown');
  });

  test('values the two libraries print differently still compare equal', () => {
    // Emotion prints `opacity:0.5`; StyleX prints `opacity:.5`.
    const result = proposeStaticConversion({
      source: file('{ opacity: 0.5, lineHeight: 1.5, zIndex: 10 }'),
      filename: FILENAME,
    });
    expect(result.status).toBe('proposed');
  });

  test('several sites are each compared on their own', () => {
    const source = `${PRAGMA}export const App = () => (
  <div css={{ color: 'red' }}>
    <span css={{ backgroundColor: 'blue' }} />
  </div>
);
`;
    const result = proposeStaticConversion({ source, filename: FILENAME });
    expect(result.status).toBe('proposed');
    if (result.status === 'proposed') {
      const comparisons = result.evidence.filter(
        (item) => item.check === 'static-css-comparison',
      );
      expect(comparisons).toHaveLength(2);
      expect(comparisons.map((item) => item.scope[0])).toEqual([
        `${FILENAME}#div`,
        `${FILENAME}#span`,
      ]);
    }
  });
});

/**
 * The checker is the thing being sold, so it is the thing that gets attacked.
 *
 * Each case takes a conversion that really is correct, corrupts one material
 * field of the generated output, and requires a refusal. A checker that only
 * ever sees correct input has not been tested at all.
 */
describe('mutation testing the checker', () => {
  const source = `${PRAGMA}export const App = () => (
  <div css={{ color: 'red', fontSize: 12 }}>
    <span css={{ backgroundColor: 'blue' }} />
  </div>
);
`;

  function verifyMutated(mutate: (code: string) => string) {
    const converted = convertSource(source, FILENAME);
    if (converted.status !== 'converted') {
      throw new Error('fixture did not convert');
    }
    const mutatedCode = mutate(converted.code);
    expect(mutatedCode).not.toBe(converted.code);
    return verifyConversion({
      source,
      filename: FILENAME,
      converted: { ...converted, code: mutatedCode },
    });
  }

  test('the unmutated fixture passes, so the suite is not vacuous', () => {
    expect(verifyMutated((code) => `${code}\n`).status).toBe('proposed');
  });

  const mutations: $ReadOnlyArray<[string, (string) => string]> = [
    ['a renamed property', (code) => code.replace('color:', 'borderColor:')],
    ['a changed string value', (code) => code.replace("'red'", "'blue'")],
    [
      'a changed number value',
      (code) => code.replace('fontSize: 12', 'fontSize: 13'),
    ],
    [
      'a dropped declaration',
      (code) => code.replace("    color: 'red',\n", ''),
    ],
    [
      'an added declaration',
      (code) =>
        code.replace(
          "    color: 'red',",
          "    color: 'red',\n    display: 'block',",
        ),
    ],
    [
      'a value with its unit changed',
      (code) => code.replace('fontSize: 12', "fontSize: '12em'"),
    ],
    [
      'two style bodies swapped between keys',
      (code) =>
        code
          .replace("color: 'red'", '__TMP__')
          .replace("backgroundColor: 'blue'", "color: 'red'")
          .replace('__TMP__', "backgroundColor: 'blue'"),
    ],
    [
      'a site pointed at the wrong style key',
      (code) => code.replace('styles.div)', 'styles.span)'),
    ],
    [
      'a site pointed at a registry that does not exist',
      (code) => code.replace('styles.div)', 'notStyles.div)'),
    ],
    [
      'the import removed',
      (code) =>
        code.replace("import * as stylex from '@stylexjs/stylex';\n", ''),
    ],
    [
      'the namespace renamed at one use site only',
      (code) => code.replace('{...stylex.props', '{...stylex9.props'),
    ],
  ];

  test.each(mutations)('refuses %s', (_name, mutate) => {
    const result = verifyMutated(mutate);
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).not.toBe('');
      expect(result.evidence.some((item) => item.result !== 'pass')).toBe(true);
    }
  });
});

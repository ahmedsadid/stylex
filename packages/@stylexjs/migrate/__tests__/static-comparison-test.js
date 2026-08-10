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
import {
  emotionBaseline,
  emotionPseudoElementBaseline,
} from '../src/adapters/emotion/baseline';
import {
  proposeStaticConversion,
  verifyConversion,
} from '../src/proposers/emotionStatic';
import { convertSource } from '../src/adapters/emotion/convert';
import {
  PSEUDO_ELEMENT_REFEREE_MODEL,
  REFEREE_MODEL,
} from '../src/referee/model';

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
    expect(parseDeclarations('color:red;font-size:12px;')).toEqual({
      ok: true,
      declarations: [
        { property: 'color', value: 'red' },
        { property: 'font-size', value: '12px' },
      ],
    });
    expect(parseRule('.x1abc{color:red}')).toEqual({
      ok: true,
      declarations: [{ property: 'color', value: 'red' }],
    });
  });

  test('a semicolon inside a quoted value does not split the declaration', () => {
    // Splitting on `;` reduced both of these to `content: "a` and called them
    // equal, which let a changed value through the whole verifier.
    const first = parseDeclarations('content:"a;b";');
    const second = parseDeclarations('content:"a;c";');
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.declarations).toEqual([
        { property: 'content', value: '"a;b"' },
      ]);
      expect(
        compareDeclarations(first.declarations, second.declarations).equal,
      ).toBe(false);
    }
  });

  test('importance is part of declaration identity', () => {
    const important = parseDeclarations('color:red!important;');
    const ordinary = parseDeclarations('color:red;');
    expect(important).toEqual({
      ok: true,
      declarations: [{ property: 'color', value: 'red', important: true }],
    });
    if (important.ok && ordinary.ok) {
      expect(
        compareDeclarations(important.declarations, ordinary.declarations)
          .equal,
      ).toBe(false);
    }
  });

  test('string contents are never canonicalised', () => {
    expect(canonicalValue('"a  b"')).toBe('"a  b"');
    expect(canonicalValue('"a, b"')).toBe('"a, b"');
    expect(canonicalValue('"a .5"')).toBe('"a .5"');
    expect(canonicalValue("'a  b'")).toBe("'a  b'");
    expect(canonicalValue('url(a  b)')).toBe('url(a  b)');
    // ...but formatting outside the string still is.
    expect(canonicalValue('  "a  b"  ')).toBe('"a  b"');
    expect(canonicalValue('0 , "a, b"')).toBe('0,"a, b"');
  });

  test('CSS it cannot model is a failure, not a silent drop', () => {
    const nested = parseDeclarations('@media screen { color: red }');
    expect(nested.ok).toBe(false);
    const notARule = parseRule('color:red');
    expect(notARule.ok).toBe(false);
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

  test('observes only the approved literal pseudo-element shape', () => {
    const result = emotionPseudoElementBaseline(
      "{ color: 'black', '::before': { content: '\"x\"' }, '::after': { opacity: 0.5 } }",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.declarations.map((declaration) => [
          declaration.property,
          declaration.value,
          declaration.pseudoElement,
        ]),
      ).toEqual([
        ['color', 'black', null],
        ['content', '"x"', '::before'],
        ['opacity', '0.5', '::after'],
      ]);
    }
    expect(
      emotionPseudoElementBaseline("{ '::before': { content: sideEffect() } }")
        .ok,
    ).toBe(false);
    expect(
      emotionPseudoElementBaseline(
        "{ '::before': { ':hover': { color: 'red' } } }",
      ).ok,
    ).toBe(false);
    expect(
      emotionPseudoElementBaseline("{ '::placeholder': { color: 'gray' } }").ok,
    ).toBe(false);
  });
});

describe('proposing a conversion', () => {
  test('a correct conversion produces static CSS evidence and says what it did not check', () => {
    const result = proposeStaticConversion({
      source: file("{ color: 'red', fontSize: 12 }"),
      filename: FILENAME,
    });
    expect(result.status).toBe('proposed');
    if (result.status !== 'proposed') {
      return;
    }
    expect(result.model).toBe(COMPARISON_MODEL);
    expect(result.entries[0].classNames.length).toBe(2);
    expect(result.evidence.map((item) => item.check)).toEqual([
      'stylex-plugin-transform',
      'stylex-lint',
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

  test('approved conditions pass the cascade referee', () => {
    const result = proposeStaticConversion({
      source: file(
        "{ color: 'base', ':hover': { color: 'hover' }, ':focus': { color: 'focus' } }",
      ),
      filename: FILENAME,
    });
    expect(result.status).toBe('proposed');
    if (result.status !== 'proposed') return;
    expect(result.model).toBe(REFEREE_MODEL);
    const comparison = result.evidence.find(
      (item) => item.check === 'static-css-comparison',
    );
    expect(comparison?.result).toBe('pass');
    expect(comparison?.subject.model).toBe(REFEREE_MODEL);
    expect(comparison?.limitations.join('\n')).toContain(
      'simultaneous :hover/:focus states',
    );
  });

  test('condition order that changes a simultaneous winner is refused', () => {
    const result = proposeStaticConversion({
      source: file(
        "{ color: 'base', ':focus': { color: 'focus' }, ':hover': { color: 'hover' } }",
      ),
      filename: FILENAME,
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toContain('conditional CSS differs');
    expect(result.reason).toContain(':focus+:hover');
    expect(
      result.evidence.find((item) => item.check === 'static-css-comparison')
        ?.result,
    ).toBe('fail');
  });

  test('approved before and after targets pass their own referee model', () => {
    const result = proposeStaticConversion({
      source: file(
        '{ color: \'black\', \'::before\': { color: \'red\', content: \'"x"\' }, \'::after\': { color: \'blue\' } }',
      ),
      filename: FILENAME,
    });
    expect(result.status).toBe('proposed');
    if (result.status !== 'proposed') return;
    expect(result.model).toBe(PSEUDO_ELEMENT_REFEREE_MODEL);
    const comparison = result.evidence.find(
      (item) => item.check === 'static-css-comparison',
    );
    expect(comparison?.result).toBe('pass');
    expect(comparison?.subject.model).toBe(PSEUDO_ELEMENT_REFEREE_MODEL);
    expect(comparison?.limitations.join('\n')).toContain(
      'root, ::before, and ::after selector targets',
    );
  });

  test('values the two libraries print differently still compare equal', () => {
    // Emotion prints `opacity:0.5`; StyleX prints `opacity:.5`.
    const result = proposeStaticConversion({
      source: file('{ opacity: 0.5, lineHeight: 1.5, zIndex: 10 }'),
      filename: FILENAME,
    });
    expect(result.status).toBe('proposed');
  });

  test('important declarations are refused by the flat mechanical lane', () => {
    const result = proposeStaticConversion({
      source: file('{ color: "red !important" }'),
      filename: FILENAME,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toContain('contains !important');
    }
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

  test('swapping the styles of two sites is caught', () => {
    // Both keys are still referenced and each key's CSS is still correct, so a
    // check that compares an unordered set of references passes. Only a
    // site-by-site binding catches the swap.
    const result = verifyMutated((code) =>
      code
        .replace('styles.div)', 'styles.__TMP__)')
        .replace('styles.span)', 'styles.div)')
        .replace('styles.__TMP__)', 'styles.span)'),
    );
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toContain('instead');
    }
  });

  test('a changed value inside a quoted string is caught', () => {
    const quoted = `${PRAGMA}const A = () => <div css={{ content: '"a;b"' }} />;\n`;
    const converted = convertSource(quoted, FILENAME);
    if (converted.status !== 'converted') {
      throw new Error('fixture did not convert');
    }
    const result = verifyConversion({
      source: quoted,
      filename: FILENAME,
      converted: {
        ...converted,
        code: converted.code.replace('"a;b"', '"a;c"'),
      },
    });
    expect(result.status).toBe('refused');
  });

  test('removing important with an offset-preserving mutation is caught', () => {
    const importantSource = `${PRAGMA}const A = () => <div css={{ color: 'red !important' }} />;\n`;
    const converted = convertSource(importantSource, FILENAME);
    if (converted.status !== 'converted') {
      throw new Error('fixture did not convert');
    }
    const result = verifyConversion({
      source: importantSource,
      filename: FILENAME,
      converted: {
        ...converted,
        code: converted.code.replace('red !important', 'red           '),
      },
    });
    expect(result.status).toBe('refused');
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
      // The CSS is identical either way, so only the lint gate can catch this.
      'style keys emitted out of the order StyleX wants',
      (code) =>
        code.replace(
          "    color: 'red',\n    fontSize: 12,",
          "    fontSize: 12,\n    color: 'red',",
        ),
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

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  allocateKeys,
  isShorthandProperty,
  parseSource,
  sanitizeKey,
  serializeValue,
} from '../src/index';
import { convertSource } from '../src/adapters/emotion/convert';
import { proposeStaticConversion } from '../src/proposers/emotionStatic';

const PRAGMA = '/** @jsxImportSource @emotion/react */\n';

function parses(code: string): boolean {
  return parseSource(code, 'Generated.jsx').ok;
}

describe('serializing values as source', () => {
  test('escapes everything that would break the literal', () => {
    expect(serializeValue('a\nb')).toBe("'a\\nb'");
    expect(serializeValue('a\rb')).toBe("'a\\rb'");
    expect(serializeValue('a\tb')).toBe("'a\\tb'");
    expect(serializeValue("a'b")).toBe("'a\\'b'");
    expect(serializeValue('a\\b')).toBe("'a\\\\b'");
    expect(serializeValue('a\u2028b')).toBe("'a\\u2028b'");
    expect(serializeValue('a\u0000b')).toBe("'a\\u0000b'");
  });

  test('a null byte is not emitted as an octal escape', () => {
    // `\0` followed by a digit would be a legacy octal escape and change the
    // value, so the padded form is used instead.
    expect(serializeValue('\u00007')).toBe("'\\u00007'");
  });

  test('refuses to emit a non-finite number', () => {
    expect(() => serializeValue(Infinity)).toThrow('non-finite');
  });

  test('every escaped value round-trips through the parser', () => {
    for (const value of ['a\nb', "a'b", 'a\\b', 'a\u2028b', 'a\u0001b']) {
      expect(parses(`const a = ${serializeValue(value)};`)).toBe(true);
    }
  });

  test('a style value containing a newline produces source that parses', () => {
    const result = convertSource(
      `${PRAGMA}const A = () => <div css={{ content: "a\\nb" }} />;`,
      'Component.jsx',
    );
    expect(result.status).toBe('converted');
    if (result.status === 'converted') {
      expect(parses(result.code)).toBe(true);
    }
  });

  test('a numeric literal that parses to Infinity is refused', () => {
    const result = convertSource(
      `${PRAGMA}const A = () => <div css={{ zIndex: 1e999 }} />;`,
      'Component.jsx',
    );
    expect(result.status).toBe('unchanged');
    if (result.status === 'unchanged') {
      expect(result.refusals.map((item) => item.reason)).toEqual([
        'non-finite-number',
      ]);
    }
  });
});

describe('allocating style keys', () => {
  test('suffixes are unique across every key, not per name', () => {
    // Counting per name produced div, div2, div2 — two elements sharing one
    // registry entry, with the second silently replacing the first.
    expect(allocateKeys(['div', 'div2', 'div'])).toEqual([
      'div',
      'div2',
      'div3',
    ]);
    expect(allocateKeys(['a', 'a', 'a2', 'a'])).toEqual([
      'a',
      'a2',
      'a22',
      'a3',
    ]);
  });

  test('a JSX tag that is not an identifier becomes one', () => {
    expect(sanitizeKey('my-button')).toBe('myButton');
    expect(sanitizeKey('x-a-b')).toBe('xAB');
    expect(sanitizeKey('---')).toBe('style');
  });

  test('a custom element produces source that parses', () => {
    const result = convertSource(
      `${PRAGMA}const A = () => <my-button css={{ color: 'red' }} />;`,
      'Component.jsx',
    );
    expect(result.status).toBe('converted');
    if (result.status === 'converted') {
      expect(result.code).toContain('myButton: {');
      expect(result.code).toContain('styles.myButton');
      expect(parses(result.code)).toBe(true);
    }
  });

  test('repeated element names all get distinct registry entries', () => {
    const result = proposeStaticConversion({
      source: `${PRAGMA}const A = () => (
  <div>
    <div css={{ color: 'red' }} />
    <div2 css={{ color: 'blue' }} />
    <div css={{ color: 'green' }} />
  </div>
);
`,
      filename: 'Component.jsx',
    });
    expect(result.status).toBe('proposed');
    if (result.status === 'proposed') {
      const keys = result.entries.map((entry) => entry.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('what counts as a shorthand', () => {
  test('comes from StyleX rather than a list kept here', () => {
    expect(isShorthandProperty('margin')).toBe(true);
    expect(isShorthandProperty('borderRadius')).toBe(true);
    expect(isShorthandProperty('gap')).toBe(true);
    expect(isShorthandProperty('color')).toBe(false);
    expect(isShorthandProperty('marginTop')).toBe(false);
  });

  test('covers logical shorthands a handwritten list tended to miss', () => {
    for (const property of [
      'borderBlock',
      'borderInline',
      'borderBlockStart',
      'scrollMarginBlock',
      'scrollPaddingInline',
      'insetInline',
      'containIntrinsicSize',
      'placeItems',
      'maskBorder',
      'gridTemplateAreas',
    ]) {
      expect(isShorthandProperty(property)).toBe(true);
    }
  });
});

describe('sites whose meaning depends on runtime context', () => {
  test('a sibling JSX spread is refused', () => {
    const result = convertSource(
      `${PRAGMA}const A = (props) => <div {...props} css={{ color: 'red' }} />;`,
      'Component.jsx',
    );
    expect(result.status).toBe('unchanged');
    if (result.status === 'unchanged') {
      expect(result.refusals.map((item) => item.reason)).toEqual([
        'css-with-jsx-spread',
      ]);
    }
  });
});

describe('resolving the StyleX binding', () => {
  test('a Flow type-only import is not reused as a runtime binding', () => {
    // Flow spells this `import typeof * as`; `import type * as` is TypeScript.
    const result = convertSource(
      `${PRAGMA}import typeof * as stylex from '@stylexjs/stylex';
const A = () => <div css={{ color: 'red' }} />;
`,
      'Component.js',
    );
    expect(result.status).toBe('converted');
    if (result.status === 'converted') {
      // The type-only name is left alone and a real runtime import is added.
      expect(result.code).toContain(
        "import * as stylex2 from '@stylexjs/stylex';",
      );
      expect(result.code).toContain('stylex2.create({');
      expect(result.code).toContain('import typeof * as stylex from');
    }
  });

  test('a TypeScript type-only import is likewise ignored', () => {
    const result = convertSource(
      `${PRAGMA}import type * as stylex from '@stylexjs/stylex';
const A = () => <div css={{ color: 'red' }} />;
`,
      'Component.tsx',
    );
    expect(result.status).toBe('converted');
    if (result.status === 'converted') {
      expect(result.code).toContain('stylex2.create({');
    }
  });
});

describe('deciding that a file is Emotion', () => {
  test('the pragma is read from comments, not from the raw text', () => {
    const inString = `const s = "@jsxImportSource @emotion/react";
const A = () => <div css={{ color: 'red' }} />;
`;
    const result = convertSource(inString, 'Component.jsx');
    expect(result.status).toBe('unchanged');
    if (result.status === 'unchanged') {
      expect(result.reason).toBe('not-emotion');
    }
  });

  test('@emotion/styled alone does not enable the css prop', () => {
    const result = convertSource(
      `import styled from '@emotion/styled';
const A = () => <div css={{ color: 'red' }} />;
`,
      'Component.jsx',
    );
    expect(result.status).toBe('unchanged');
    if (result.status === 'unchanged') {
      expect(result.reason).toBe('not-emotion');
    }
  });

  test('@emotion/react import alone does not enable it', () => {
    const result = convertSource(
      `import { css } from '@emotion/react';
const A = () => <div css={{ color: 'red' }} />;
`,
      'Component.jsx',
    );
    expect(result.status).toBe('unchanged');
    if (result.status === 'unchanged') {
      expect(result.reason).toBe('not-emotion');
    }
  });

  test('a type-only @emotion/react import never enables it', () => {
    const result = convertSource(
      `import type { Theme } from '@emotion/react';
const A = () => <div css={{ color: 'red' }} />;
`,
      'Component.js',
    );
    expect(result.status).toBe('unchanged');
    if (result.status === 'unchanged') {
      expect(result.reason).toBe('not-emotion');
    }
  });

  test('an unrelated comment containing pragma text does not enable it', () => {
    const result = convertSource(
      `/** Documentation mentioning @jsxImportSource @emotion/react is not configuration. */
const A = () => <div css={{ color: 'red' }} />;
`,
      'Component.jsx',
    );
    expect(result.status).toBe('unchanged');
  });
});

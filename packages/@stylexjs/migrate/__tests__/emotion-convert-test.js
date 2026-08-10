/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { convertSource } from '../src/adapters/emotion/convert';
import { applyEdits } from '../src/static/rewrite';
import { allocateKeys, serializeValue } from '../src/static/emit';
import { freeName } from '../src/static/bindings';

const PRAGMA = '/** @jsxImportSource @emotion/react */\n';

function convert(source: string, filename: string = 'Component.jsx'): string {
  const result = convertSource(source, filename);
  if (result.status !== 'converted') {
    throw new Error(`expected a conversion, got ${result.status}`);
  }
  return result.code;
}

describe('emitting values', () => {
  test('numbers stay bare and strings are single quoted', () => {
    expect(serializeValue(12)).toBe('12');
    expect(serializeValue(0)).toBe('0');
    expect(serializeValue('red')).toBe("'red'");
  });

  test('quotes and backslashes in a value are escaped', () => {
    expect(serializeValue("a'b")).toBe("'a\\'b'");
    expect(serializeValue('a\\b')).toBe("'a\\\\b'");
  });
});

describe('naming', () => {
  test('style keys come from the element, with suffixes for repeats', () => {
    expect(allocateKeys(['div', 'span', 'div', 'div'])).toEqual([
      'div',
      'span',
      'div2',
      'div3',
    ]);
  });

  test('a free name avoids what the file already uses', () => {
    expect(freeName('styles', new Set())).toBe('styles');
    expect(freeName('styles', new Set(['styles']))).toBe('styles2');
    expect(freeName('styles', new Set(['styles', 'styles2']))).toBe('styles3');
  });
});

describe('span editing', () => {
  test('edits apply without disturbing anything else', () => {
    expect(
      applyEdits('abcdef', [
        { start: 1, end: 2, text: 'B' },
        { start: 4, end: 5, text: 'E' },
      ]),
    ).toBe('aBcdEf');
  });

  test('insertions at the same offset keep the given order', () => {
    expect(
      applyEdits('xy', [
        { start: 1, end: 1, text: 'first' },
        { start: 1, end: 1, text: 'second' },
      ]),
    ).toBe('xfirstsecondy');
  });

  test('overlapping edits are a loud bug, not a silent mangling', () => {
    expect(() =>
      applyEdits('abcdef', [
        { start: 1, end: 4, text: 'X' },
        { start: 2, end: 5, text: 'Y' },
      ]),
    ).toThrow('Overlapping edits');
  });
});

describe('converting a file', () => {
  test('a flat css prop becomes a registry entry and a props spread', () => {
    const source = `${PRAGMA}export const App = () => (
  <div css={{ color: 'red', backgroundColor: 'blue' }} />
);
`;
    expect(convert(source))
      .toBe(`${PRAGMA}import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  div: {
    backgroundColor: 'blue',
    color: 'red',
  },
});

export const App = () => (
  <div {...stylex.props(styles.div)} />
);
`);
  });

  test('approved conditions become property-first StyleX values', () => {
    const source = `${PRAGMA}export const App = () => (
  <div css={{ color: 'base', ':hover': { color: 'hover' }, ':focus': { color: 'focus', opacity: 1 } }} />
);
`;
    const converted = convert(source);
    expect(converted).toContain(`color: {
      default: 'base',
      ':hover': 'hover',
      ':focus': 'focus',
    },`);
    expect(converted).toContain(`opacity: {
      ':focus': 1,
    },`);
  });

  test('before and after targets remain selector-keyed StyleX objects', () => {
    const source = `${PRAGMA}export const App = () => (
  <div css={{ color: 'black', '::before': { color: 'red', content: '"x"' }, '::after': { color: 'blue' } }} />
);
`;
    expect(convert(source)).toContain(`div: {
    color: 'black',
    '::after': {
      color: 'blue',
    },
    '::before': {
      color: 'red',
      content: '"x"',
    },
  },`);
  });

  test('one media block becomes a property-first StyleX condition', () => {
    const source = `${PRAGMA}export const App = () => (
  <div css={{ color: 'black', '@media (min-width: 800px)': { color: 'blue', opacity: 0.5 } }} />
);
`;
    const converted = convert(source);
    expect(converted).toContain(`color: {
      default: 'black',
      '@media (min-width: 800px)': 'blue',
    },`);
    expect(converted).toContain(`opacity: {
      '@media (min-width: 800px)': 0.5,
    },`);
  });

  test('everything outside the converted spans is untouched', () => {
    const source = `${PRAGMA}import React from 'react';

//    a comment with    odd   spacing
export const App = () => (
  <div css={{ color: 'red' }}>
    {'   text   '}
  </div>
);
`;
    const converted = convert(source);
    expect(converted).toContain('//    a comment with    odd   spacing');
    expect(converted).toContain("{'   text   '}");
    expect(converted).toContain("import React from 'react';");
  });

  test('the import goes after the last existing import', () => {
    const source = `${PRAGMA}import React from 'react';
import { thing } from './thing';

export const App = () => <div css={{ color: 'red' }} />;
`;
    const converted = convert(source);
    expect(converted).toContain(
      "import { thing } from './thing';\n" +
        "import * as stylex from '@stylexjs/stylex';",
    );
  });

  test('an existing StyleX import is reused under its own name', () => {
    const source = `${PRAGMA}import * as sx from '@stylexjs/stylex';

export const App = () => <div css={{ color: 'red' }} />;
`;
    const converted = convert(source);
    expect(converted).toContain('const styles = sx.create({');
    expect(converted).toContain('{...sx.props(styles.div)}');
    // No second import was added.
    expect(converted.match(/@stylexjs\/stylex/g)).toHaveLength(1);
  });

  test('a taken registry name is avoided', () => {
    const source = `${PRAGMA}const styles = { legacy: true };

export const App = () => <div css={{ color: 'red' }} />;
`;
    const converted = convert(source);
    expect(converted).toContain('const styles2 = stylex.create({');
    expect(converted).toContain('{...stylex.props(styles2.div)}');
    expect(converted).toContain('const styles = { legacy: true };');
  });

  test('a taken stylex name is avoided', () => {
    const source = `${PRAGMA}const stylex = 'not the library';

export const App = () => <div css={{ color: 'red' }} />;
`;
    const converted = convert(source);
    expect(converted).toContain("import * as stylex2 from '@stylexjs/stylex';");
    expect(converted).toContain('stylex2.create({');
  });

  test('several sites share one registry, named after their elements', () => {
    const source = `${PRAGMA}export const App = () => (
  <div css={{ color: 'red' }}>
    <span css={{ color: 'blue' }} />
    <div css={{ color: 'green' }} />
  </div>
);
`;
    const converted = convert(source);
    expect(converted).toContain('div: {');
    expect(converted).toContain('span: {');
    expect(converted).toContain('div2: {');
    expect(converted.match(/stylex\.create/g)).toHaveLength(1);
  });

  test('the registry is declared directly above the statement that uses it', () => {
    const source = `${PRAGMA}import React from 'react';

export function Other() {
  return null;
}

export const App = () => <div css={{ color: 'red' }} />;
`;
    const converted = convert(source);
    const registryAt = converted.indexOf('const styles = stylex.create');
    const otherAt = converted.indexOf('export function Other');
    const appAt = converted.indexOf('export const App');
    expect(otherAt).toBeLessThan(registryAt);
    expect(registryAt).toBeLessThan(appAt);
  });

  test('duplicate properties keep only the one that would have won', () => {
    const source = `${PRAGMA}export const App = () => (
  <div css={{ color: 'red', color: 'blue' }} />
);
`;
    const converted = convert(source);
    expect(converted).toContain("color: 'blue',");
    expect(converted).not.toContain("color: 'red',");
  });

  test('shorthands are refused rather than guessed at', () => {
    const result = convertSource(
      `${PRAGMA}export const App = () => <div css={{ marginTop: 20, margin: 4 }} />;`,
      'Component.jsx',
    );
    expect(result.status).toBe('unchanged');
    if (result.status === 'unchanged') {
      expect(result.reason).toBe('no-supported-sites');
      expect(result.refusals.map((r) => r.reason)).toEqual([
        'shorthand-property',
      ]);
    }
  });

  test('a file without emotion is left alone', () => {
    const result = convertSource(
      'export const App = () => <div css={{ color: "red" }} />;',
      'Component.jsx',
    );
    expect(result.status).toBe('unchanged');
    if (result.status === 'unchanged') {
      expect(result.reason).toBe('not-emotion');
    }
  });

  test('an unparseable file is refused, not crashed on', () => {
    const result = convertSource('const = = =;', 'broken.js');
    expect(result.status).toBe('refused');
  });

  test('converting is idempotent: the output has nothing left to convert', () => {
    const source = `${PRAGMA}export const App = () => (
  <div css={{ color: 'red' }} />
);
`;
    const once = convert(source);
    const again = convertSource(once, 'Component.jsx');
    expect(again.status).toBe('unchanged');
    if (again.status === 'unchanged') {
      expect(again.reason).toBe('no-supported-sites');
    }
  });

  test('a refused site is reported while a supported one still converts', () => {
    const result = convertSource(
      `${PRAGMA}export const App = () => (
  <div css={{ color: 'red' }}>
    <Button css={{ color: 'blue' }} />
  </div>
);
`,
      'Component.jsx',
    );
    expect(result.status).toBe('converted');
    if (result.status === 'converted') {
      expect(result.entries).toHaveLength(1);
      expect(result.refusals.map((r) => r.reason)).toEqual([
        'css-on-component',
      ]);
      expect(result.code).toContain("css={{ color: 'blue' }}");
    }
  });
});

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { discover, parseSource, pluginsForFilename } from '../src/index';
import type { DiscoveryResult } from '../src/index';

const PRAGMA = '/** @jsxImportSource @emotion/react */\n';

function read(
  source: string,
  filename: string = 'Component.jsx',
): DiscoveryResult {
  const parsed = parseSource(source, filename);
  if (!parsed.ok) {
    throw new Error(`fixture failed to parse: ${parsed.reason}`);
  }
  return discover(parsed.ast);
}

function reasons(result: DiscoveryResult): $ReadOnlyArray<string> {
  return result.refusals.map((refusal) => refusal.reason);
}

describe('parsing', () => {
  test('a .ts file is not parsed as .tsx', () => {
    expect(pluginsForFilename('a.ts')).not.toContain('jsx');
    expect(pluginsForFilename('a.tsx')).toContain('jsx');

    // `<number>value` is a type assertion in .ts and a JSX element in .tsx.
    const source = 'const value: mixed = 1;\nconst n = <number>value;\n';
    expect(parseSource(source, 'a.ts').ok).toBe(true);
    expect(parseSource(source, 'a.tsx').ok).toBe(false);
  });

  test('an unparseable file is a refusal, never a crash', () => {
    const result = parseSource('const = = = ;', 'broken.js');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('could not parse file');
    }
  });

  test('flow syntax parses in .js files', () => {
    expect(parseSource('const a: string = "x";', 'a.js').ok).toBe(true);
  });
});

describe('emotion discovery', () => {
  test('a file without emotion has nothing to convert', () => {
    const result = read(
      'export const App = () => <div css={{ color: "red" }} />;',
    );
    expect(result.usesEmotion).toBe(false);
    expect(result.sites).toEqual([]);
    expect(result.refusals).toEqual([]);
  });

  test('the pragma alone marks a file as emotion', () => {
    const result = read(`${PRAGMA}export const App = () => <div />;`);
    expect(result.usesEmotion).toBe(true);
  });

  test('an import of @emotion/react does not prove JSX runtime activation', () => {
    const result = read(
      'import { css } from "@emotion/react";\nexport const App = () => <div />;',
    );
    expect(result.usesEmotion).toBe(false);
  });

  test('reads a flat object literal on a host element', () => {
    const source = `${PRAGMA}export const App = () => (
  <div css={{ color: 'red', fontSize: 12 }} />
);`;
    const result = read(source);
    expect(result.refusals).toEqual([]);
    expect(result.sites).toHaveLength(1);

    const site = result.sites[0];
    expect(site.elementName).toBe('div');
    expect(site.style.declarations).toEqual([
      { property: 'color', value: 'red' },
      { property: 'fontSize', value: 12 },
    ]);
    // The spans point at real source: the attribute, and the object alone.
    expect(source.slice(site.start, site.end)).toBe(
      "css={{ color: 'red', fontSize: 12 }}",
    );
    expect(source.slice(site.objectStart, site.objectEnd)).toBe(
      "{ color: 'red', fontSize: 12 }",
    );
  });

  test('reads several sites in source order', () => {
    const result = read(`${PRAGMA}export const App = () => (
  <div css={{ color: 'red' }}>
    <span css={{ color: 'blue' }} />
  </div>
);`);
    expect(result.sites.map((site) => site.elementName)).toEqual([
      'div',
      'span',
    ]);
    expect(result.sites[0].start).toBeLessThan(result.sites[1].start);
  });

  test('reads the approved hover and focus condition grammar in authored order', () => {
    const result = read(`${PRAGMA}const App = () => (
  <div css={{ color: 'base', ':hover': { color: 'hover' }, ':focus': { color: 'focus', opacity: 1 } }} />
);`);
    expect(result.refusals).toEqual([]);
    expect(result.sites[0].style.declarations).toEqual([
      { property: 'color', value: 'base' },
      { property: 'color', value: 'hover', condition: ':hover' },
      { property: 'color', value: 'focus', condition: ':focus' },
      { property: 'opacity', value: 1, condition: ':focus' },
    ]);
  });

  test('duplicate condition blocks use only the last object value', () => {
    const result = read(`${PRAGMA}const App = () => (
  <div css={{ ':hover': { color: 'discarded' }, ':hover': { opacity: 1 } }} />
);`);
    expect(result.sites[0].style.declarations).toEqual([
      { property: 'opacity', value: 1, condition: ':hover' },
    ]);
  });

  test('reads flat before and after pseudo-element targets', () => {
    const result = read(`${PRAGMA}const App = () => (
  <div css={{ color: 'black', '::before': { color: 'red', content: '"x"' }, '::after': { color: 'blue' } }} />
);`);
    expect(result.refusals).toEqual([]);
    expect(result.sites[0].style.declarations).toEqual([
      { property: 'color', value: 'black' },
      { property: 'color', value: 'red', pseudoElement: '::before' },
      { property: 'content', value: '"x"', pseudoElement: '::before' },
      { property: 'color', value: 'blue', pseudoElement: '::after' },
    ]);
  });

  test('duplicate pseudo-element blocks use only the last object value', () => {
    const result = read(`${PRAGMA}const App = () => (
  <div css={{ '::before': { color: 'discarded' }, '::before': { content: '"x"' } }} />
);`);
    expect(result.sites[0].style.declarations).toEqual([
      { property: 'content', value: '"x"', pseudoElement: '::before' },
    ]);
  });

  test('reads one media-query block in authored order', () => {
    const result = read(`${PRAGMA}const App = () => (
  <div css={{ color: 'black', '@media (min-width: 800px)': { color: 'blue', opacity: 0.5 } }} />
);`);
    expect(result.refusals).toEqual([]);
    expect(result.sites[0].style.declarations).toEqual([
      { property: 'color', value: 'black' },
      {
        property: 'color',
        value: 'blue',
        mediaQuery: '@media (min-width: 800px)',
      },
      {
        property: 'opacity',
        value: 0.5,
        mediaQuery: '@media (min-width: 800px)',
      },
    ]);
  });

  test('reads one supports query with one nested media intersection', () => {
    const result = read(`${PRAGMA}const App = () => (
  <div css={{ color: 'black', '@supports (display: grid)': { display: 'grid', '@media (min-width: 800px)': { color: 'blue' } } }} />
);`);
    expect(result.refusals).toEqual([]);
    expect(result.sites[0].style.declarations).toEqual([
      { property: 'color', value: 'black' },
      {
        property: 'display',
        value: 'grid',
        supportsQuery: '@supports (display: grid)',
      },
      {
        property: 'color',
        value: 'blue',
        supportsQuery: '@supports (display: grid)',
        mediaQuery: '@media (min-width: 800px)',
      },
    ]);
  });

  test('reads the equivalent media then supports nesting order', () => {
    const result = read(`${PRAGMA}const App = () => (
  <div css={{ '@media (min-width: 800px)': { color: 'blue', '@supports (display: grid)': { display: 'grid' } } }} />
);`);
    expect(result.refusals).toEqual([]);
    expect(result.sites[0].style.declarations).toEqual([
      {
        property: 'color',
        value: 'blue',
        mediaQuery: '@media (min-width: 800px)',
      },
      {
        property: 'display',
        value: 'grid',
        supportsQuery: '@supports (display: grid)',
        mediaQuery: '@media (min-width: 800px)',
      },
    ]);
  });

  test('reads one referenced from/to keyframes block', () => {
    const result = read(`${PRAGMA}const App = () => (
  <div css={{ animationName: 'fade', animationDuration: '1s', '@keyframes fade': { from: { opacity: 0 }, to: { opacity: 1 } } }} />
);`);
    expect(result.refusals).toEqual([]);
    expect(result.sites[0].style.declarations).toEqual([
      {
        property: 'animationName',
        value: {
          kind: 'keyframes',
          sourceName: 'fade',
          frames: [
            {
              selector: 'from',
              declarations: [{ property: 'opacity', value: 0 }],
            },
            {
              selector: 'to',
              declarations: [{ property: 'opacity', value: 1 }],
            },
          ],
        },
      },
      { property: 'animationDuration', value: '1s' },
    ]);
  });

  test('refuses an effectful value hidden by a later pseudo-element block', () => {
    const result = read(`${PRAGMA}const App = () => (
  <div css={{ '::after': { color: sideEffect() }, '::after': { opacity: 1 } }} />
);`);
    expect(result.sites).toEqual([]);
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual([
      'non-literal-value',
    ]);
  });

  test('duplicate media blocks use only the last object value', () => {
    const result = read(`${PRAGMA}const App = () => (
  <div css={{ '@media (min-width: 800px)': { color: 'discarded' }, '@media (min-width: 800px)': { opacity: 1 } }} />
);`);
    expect(result.sites[0].style.declarations).toEqual([
      {
        property: 'opacity',
        value: 1,
        mediaQuery: '@media (min-width: 800px)',
      },
    ]);
  });

  test('refuses an effectful value hidden by a later media block', () => {
    const result = read(`${PRAGMA}const App = () => (
  <div css={{ '@media (min-width: 800px)': { color: sideEffect() }, '@media (min-width: 800px)': { opacity: 1 } }} />
);`);
    expect(result.sites).toEqual([]);
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual([
      'non-literal-value',
    ]);
  });

  test('refuses an effectful value hidden by a later supports block', () => {
    const result = read(`${PRAGMA}const App = () => (
  <div css={{ '@supports (display: grid)': { color: sideEffect() }, '@supports (display: grid)': { opacity: 1 } }} />
);`);
    expect(result.sites).toEqual([]);
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual([
      'non-literal-value',
    ]);
  });

  test('refuses an effectful value hidden by a later duplicate property', () => {
    const result = read(`${PRAGMA}const App = () => (
  <div css={{ color: sideEffect(), color: 'red' }} />
);`);
    expect(result.sites).toEqual([]);
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual([
      'non-literal-value',
    ]);
  });

  test('refuses an effectful value hidden inside one condition object', () => {
    const result = read(`${PRAGMA}const App = () => (
  <div css={{ ':hover': { color: sideEffect(), color: 'red' } }} />
);`);
    expect(result.sites).toEqual([]);
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual([
      'non-literal-value',
    ]);
  });

  test('refuses an effectful value hidden by a later condition object', () => {
    const result = read(`${PRAGMA}const App = () => (
  <div css={{ ':hover': { color: sideEffect() }, ':hover': { opacity: 1 } }} />
);`);
    expect(result.sites).toEqual([]);
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual([
      'non-literal-value',
    ]);
  });

  test('string keys are accepted when they are already camelCase', () => {
    const result = read(
      `${PRAGMA}const App = () => <div css={{ 'fontSize': 12 }} />;`,
    );
    expect(result.sites[0].style.declarations).toEqual([
      { property: 'fontSize', value: 12 },
    ]);
  });

  describe('refusals', () => {
    const cases: $ReadOnlyArray<[string, string, string]> = [
      [
        'css on a component',
        `${PRAGMA}const App = () => <Button css={{ color: 'red' }} />;`,
        'css-on-component',
      ],
      [
        'css on a namespaced component',
        `${PRAGMA}const App = () => <UI.Button css={{ color: 'red' }} />;`,
        'css-on-component',
      ],
      [
        'a spread inside the object',
        `${PRAGMA}const App = () => <div css={{ ...base, color: 'red' }} />;`,
        'spread-in-style-object',
      ],
      [
        'a computed key',
        `${PRAGMA}const App = () => <div css={{ [key]: 'red' }} />;`,
        'computed-style-key',
      ],
      [
        'an unapproved condition',
        `${PRAGMA}const App = () => <div css={{ ':active': { color: 'red' } }} />;`,
        'unsupported-condition',
      ],
      [
        'a focus-visible condition pending separate priority review',
        `${PRAGMA}const App = () => <div css={{ ':focus-visible': { color: 'red' } }} />;`,
        'unsupported-condition',
      ],
      [
        'an unsupported at-rule condition',
        `${PRAGMA}const App = () => <div css={{ '@container (min-width: 10px)': { display: 'grid' } }} />;`,
        'unsupported-condition',
      ],
      [
        'more than one supports query',
        `${PRAGMA}const App = () => <div css={{ '@supports (display: grid)': { display: 'grid' }, '@supports (display: flex)': { display: 'flex' } }} />;`,
        'multiple-supports-queries',
      ],
      [
        'more than one media query',
        `${PRAGMA}const App = () => <div css={{ '@media (min-width: 800px)': { color: 'red' }, '@media (min-width: 1200px)': { color: 'blue' } }} />;`,
        'multiple-media-queries',
      ],
      [
        'supports nesting deeper than two at-rules',
        `${PRAGMA}const App = () => <div css={{ '@supports (display: grid)': { '@media (min-width: 800px)': { '@supports (display: flex)': { display: 'flex' } } } }} />;`,
        'nested-style-object',
      ],
      [
        'keyframes without an exact animation name reference',
        `${PRAGMA}const App = () => <div css={{ animationName: 'other', '@keyframes fade': { from: { opacity: 0 }, to: { opacity: 1 } } }} />;`,
        'missing-keyframes-reference',
      ],
      [
        'keyframes without both boundary frames',
        `${PRAGMA}const App = () => <div css={{ animationName: 'fade', '@keyframes fade': { to: { opacity: 1 } } }} />;`,
        'invalid-keyframes',
      ],
      [
        'more than one keyframes rule',
        `${PRAGMA}const App = () => <div css={{ animationName: 'fade', '@keyframes fade': { from: { opacity: 0 }, to: { opacity: 1 } }, '@keyframes slide': { from: { left: 0 }, to: { left: 10 } } }} />;`,
        'multiple-keyframes',
      ],
      [
        'a media query mixed with a pseudo-class',
        `${PRAGMA}const App = () => <div css={{ ':hover': { color: 'red' }, '@media (min-width: 800px)': { color: 'blue' } }} />;`,
        'mixed-media-query-modifier',
      ],
      [
        'a media query mixed with a pseudo-element',
        `${PRAGMA}const App = () => <div css={{ '::before': { color: 'red' }, '@media (min-width: 800px)': { color: 'blue' } }} />;`,
        'mixed-media-query-modifier',
      ],
      [
        'a nested media query',
        `${PRAGMA}const App = () => <div css={{ '@media (min-width: 800px)': { '@media (orientation: landscape)': { color: 'red' } } }} />;`,
        'nested-style-object',
      ],
      [
        'a spread inside a media query',
        `${PRAGMA}const App = () => <div css={{ '@media (min-width: 800px)': { ...wide, color: 'red' } }} />;`,
        'spread-in-style-object',
      ],
      [
        'a dynamic value inside a media query',
        `${PRAGMA}const App = () => <div css={{ '@media (min-width: 800px)': { color: theme.wide } }} />;`,
        'non-literal-value',
      ],
      [
        'an unsupported pseudo-element target',
        `${PRAGMA}const App = () => <input css={{ '::placeholder': { color: 'gray' } }} />;`,
        'unsupported-condition',
      ],
      [
        'a pseudo-element mixed with a pseudo-class condition',
        `${PRAGMA}const App = () => <div css={{ ':hover': { color: 'red' }, '::before': { content: '"x"' } }} />;`,
        'mixed-condition-and-pseudo-element',
      ],
      [
        'a condition nested inside a pseudo-element',
        `${PRAGMA}const App = () => <div css={{ '::before': { ':hover': { color: 'red' } } }} />;`,
        'nested-style-object',
      ],
      [
        'a spread inside a pseudo-element',
        `${PRAGMA}const App = () => <div css={{ '::before': { ...before, color: 'red' } }} />;`,
        'spread-in-style-object',
      ],
      [
        'a dynamic value inside a pseudo-element',
        `${PRAGMA}const App = () => <div css={{ '::after': { color: theme.accent } }} />;`,
        'non-literal-value',
      ],
      [
        'a shorthand inside a pseudo-element',
        `${PRAGMA}const App = () => <div css={{ '::before': { margin: 4 } }} />;`,
        'shorthand-property',
      ],
      [
        'a nested condition',
        `${PRAGMA}const App = () => <div css={{ ':hover': { ':focus': { color: 'red' } } }} />;`,
        'nested-style-object',
      ],
      [
        'a spread inside an approved condition',
        `${PRAGMA}const App = () => <div css={{ ':hover': { ...hover, color: 'red' } }} />;`,
        'spread-in-style-object',
      ],
      [
        'a dynamic value inside an approved condition',
        `${PRAGMA}const App = () => <div css={{ ':hover': { color: theme.hover } }} />;`,
        'non-literal-value',
      ],
      [
        'a template literal value',
        `${PRAGMA}const App = () => <div css={{ width: \`\${w}px\` }} />;`,
        'template-literal-value',
      ],
      [
        'an identifier value',
        `${PRAGMA}const App = () => <div css={{ color: theme.primary }} />;`,
        'non-literal-value',
      ],
      [
        'a negative number, which is an expression not a literal',
        `${PRAGMA}const App = () => <div css={{ marginTop: -4 }} />;`,
        'non-literal-value',
      ],
      [
        'a kebab-case property name',
        `${PRAGMA}const App = () => <div css={{ 'font-size': 12 }} />;`,
        'unsupported-property-name',
      ],
      [
        'a custom property',
        `${PRAGMA}const App = () => <div css={{ '--brand': 'red' }} />;`,
        'unsupported-property-name',
      ],
      [
        'a css prop that is not an object literal',
        `${PRAGMA}const App = () => <div css={styles.row} />;`,
        'css-prop-not-object-literal',
      ],
      [
        'a css prop holding a template literal',
        `${PRAGMA}const App = () => <div css={css\`color: red;\`} />;`,
        'css-prop-not-object-literal',
      ],
      [
        'css alongside className',
        `${PRAGMA}const App = () => <div className="x" css={{ color: 'red' }} />;`,
        'css-with-class-or-style-prop',
      ],
      [
        'css alongside style',
        `${PRAGMA}const App = () => <div style={s} css={{ color: 'red' }} />;`,
        'css-with-class-or-style-prop',
      ],
    ];

    test.each(cases)('refuses %s', (_name, source, reason) => {
      const result = read(source);
      expect(result.sites).toEqual([]);
      expect(reasons(result)).toEqual([reason]);
    });

    test('a refusal points at the attribute it refused', () => {
      const source = `${PRAGMA}const App = () => <Button css={{ color: 'red' }} />;`;
      const result = read(source);
      expect(
        source.slice(result.refusals[0].start, result.refusals[0].end),
      ).toBe("css={{ color: 'red' }}");
    });

    test('one refused site does not block a supported one', () => {
      const result = read(`${PRAGMA}const App = () => (
  <div css={{ color: 'red' }}>
    <Button css={{ color: 'blue' }} />
  </div>
);`);
      expect(result.sites).toHaveLength(1);
      expect(result.sites[0].elementName).toBe('div');
      expect(reasons(result)).toEqual(['css-on-component']);
    });
  });
});

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  analyzeClosedStyledTemplate,
  inventoryReadiness,
  scanRepository,
  STYLED_TEMPLATE_GRAMMAR_MODEL,
} from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

describe('closed @emotion/styled template grammar', () => {
  let repo: string | null = null;

  afterEach(() => {
    if (repo != null) removeTempDir(repo);
    repo = null;
  });

  test('reads a non-empty flat declaration list without assigning CSS meaning', () => {
    expect(
      analyzeClosedStyledTemplate(`
        /* retained behavior, discarded comment */
        display: flex;
        margin-right: 3px;
        -webkit-line-clamp: 2;
        content: "}";
      `),
    ).toEqual({
      supported: true,
      declarations: [
        { authoredProperty: 'display', property: 'display', value: 'flex' },
        {
          authoredProperty: 'margin-right',
          property: 'marginRight',
          value: '3px',
        },
        {
          authoredProperty: '-webkit-line-clamp',
          property: 'WebkitLineClamp',
          value: '2',
        },
        { authoredProperty: 'content', property: 'content', value: '"}"' },
      ],
    });
  });

  test.each([
    [
      'a nested selector',
      '&:hover { color: blue; }',
      'nested-rule-in-template',
    ],
    [
      'an at-rule',
      '@media (min-width: 1px) { color: blue; }',
      'at-rule-in-template',
    ],
    ['an important value', 'color: red !important;', 'important-declaration'],
    [
      'a duplicate fallback',
      'display: block; display: flex;',
      'duplicate-property-fallback',
    ],
    ['a custom property', '--color: red;', 'unsupported-property-name'],
    ['a property hack', '*zoom: 1;', 'legacy-declaration-hack'],
    ['a value hack', 'color: red\\9;', 'legacy-value-hack'],
    ['an empty template', '/* only a comment */', 'empty-template'],
  ])('refuses %s', (_label, css, reason) => {
    expect(analyzeClosedStyledTemplate(css)).toMatchObject({
      supported: false,
      reason,
    });
  });

  test('binds grammar facts to the readiness and usage facts', () => {
    repo = createTempRepo({
      'src/example.tsx': `import styled from '@emotion/styled';
export function Example() { return <Pre>text</Pre>; }
const Pre = styled.pre\`margin: 0; overflow: auto;\`;
`,
    });
    const repositoryRoot = repo;
    const inventory = scanRepository({ repositoryRoot });
    const grammar = inventory.facts.find(
      (fact) => fact.kind === 'emotion-styled-template-grammar',
    );
    expect(grammar).toMatchObject({
      status: 'known',
      value: {
        model: STYLED_TEMPLATE_GRAMMAR_MODEL,
        name: 'Pre',
        supported: true,
        reason: null,
        declarations: [
          { property: 'margin', value: '0' },
          { property: 'overflow', value: 'auto' },
        ],
      },
    });
    if (grammar == null) throw new Error('missing template grammar fact');
    const grammarValue: $FlowFixMe = grammar.value;
    const usage = inventory.facts.find(
      (fact) => fact.id === grammarValue.usageFactId,
    );
    const definition = inventory.facts.find(
      (fact) => fact.id === grammarValue.definitionFactId,
    );
    expect(usage?.kind).toBe('emotion-styled-usage');
    expect(definition?.kind).toBe('emotion-styled-readiness');
    expect(inventoryReadiness(inventory).styled).toMatchObject({
      firstSliceEligible: 1,
      templateGrammarFacts: 1,
      flatTemplateGrammarEligible: 1,
      templateGrammarBlockedReasons: {},
      plannedSites: 1,
    });
  });

  test('reports grammar refusals without promoting sites', () => {
    repo = createTempRepo({
      'src/example.tsx': `import styled from '@emotion/styled';
export function Example() { return <Box>text</Box>; }
const Box = styled.div\`&:hover { color: blue; }\`;
`,
    });
    const repositoryRoot = repo;
    const inventory = scanRepository({ repositoryRoot });
    expect(inventoryReadiness(inventory).styled).toMatchObject({
      firstSliceEligible: 1,
      templateGrammarFacts: 1,
      flatTemplateGrammarEligible: 0,
      templateGrammarBlockedReasons: { 'nested-rule-in-template': 1 },
      plannedSites: 0,
    });
    expect(inventory.sites).toEqual([]);
  });
});

describe('@emotion/styled theme template grammar', () => {
  let repo: string | null = null;

  afterEach(() => {
    if (repo != null) removeTempDir(repo);
    repo = null;
  });

  test('records exact whole-value theme callbacks as a contextual site', () => {
    repo = createTempRepo({
      'src/theme.tsx': `import styled from '@emotion/styled';
const Card = styled.div\`
  color: \${p => p.theme.colors.foreground};
  padding-top: 4px;
\`;
export const App = () => <Card />;
`,
    });
    const inventory = scanRepository({ repositoryRoot: repo });
    const grammar = inventory.facts.find(
      (fact) => fact.kind === 'emotion-styled-theme-template-grammar',
    );
    expect(grammar).toMatchObject({
      status: 'known',
      value: {
        name: 'Card',
        supported: true,
        declarations: [
          {
            property: 'color',
            value: null,
            sourcePath: 'colors.foreground',
          },
          {
            property: 'paddingTop',
            value: '4px',
            sourcePath: null,
          },
        ],
      },
    });
    expect(
      inventory.facts.find((fact) => {
        const value: $FlowFixMe = fact.value;
        return (
          fact.kind === 'theme-read' && value.sourcePath === 'colors.foreground'
        );
      }),
    ).toMatchObject({ value: { source: 'styled-callback' } });
    expect(inventory.sites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'styled-theme-intrinsic',
          classification: 'repeatable-contextual',
          refusalReason: 'approved-theme-decision-required',
        }),
      ]),
    );
  });

  test.each([
    [
      'embedded interpolation',
      'color: color-mix(in srgb, red, ${p => p.theme.colors.foreground});',
    ],
    ['computed callback', 'color: ${p => darken(p.theme.colors.foreground)};'],
    [
      'nested selector',
      '&:hover { color: ${p => p.theme.colors.foreground}; }',
    ],
  ])('refuses %s', (_label, body) => {
    repo = createTempRepo({
      'src/refused.tsx': `import styled from '@emotion/styled';
const Card = styled.div\`${body}\`;
export const App = () => <Card />;
`,
    });
    const grammar = scanRepository({ repositoryRoot: repo }).facts.find(
      (fact) => fact.kind === 'emotion-styled-theme-template-grammar',
    );
    expect(grammar).toMatchObject({ value: { supported: false } });
  });
});

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import fs from 'fs';
import path from 'path';
import { proposeStaticConversion } from '../src/proposers/emotionStatic';
import { walk } from '../src/static/walk';

/**
 * Every input gets a verdict.
 *
 * One unusual file in a repository must never end a migration run. A file the
 * tool cannot read is `refused` with a reason; a file with nothing to do is
 * `unchanged`. Throwing is not one of the options.
 */

const VALID_STATUSES = ['proposed', 'refused', 'unchanged'];

const AWKWARD_INPUTS: $ReadOnlyArray<[string, string, string]> = [
  ['an empty file', '', 'a.js'],
  ['only whitespace', '\n\n   \n', 'a.js'],
  ['only a comment', '// nothing here\n', 'a.js'],
  [
    'only the emotion pragma',
    '/** @jsxImportSource @emotion/react */\n',
    'a.jsx',
  ],
  ['broken syntax', 'const = = =;', 'a.js'],
  ['an unterminated string', 'const a = "oops;', 'a.js'],
  ['an unterminated JSX element', 'const a = <div;', 'a.jsx'],
  ['a lone closing brace', '}', 'a.js'],
  ['a shebang', '#!/usr/bin/env node\nconst a = 1;\n', 'a.js'],
  ['a bare JSX fragment', 'const a = <></>;', 'a.jsx'],
  [
    'a TypeScript type assertion in a .ts file',
    'const value: unknown = 1;\nconst n = <number>value;\n',
    'a.ts',
  ],
  [
    'TypeScript generics in a .tsx file',
    'const f = <T,>(x: T): T => x;',
    'a.tsx',
  ],
  ['unicode identifiers and content', 'const 変数 = "日本語";\n', 'a.js'],
  ['a very long single line', `const a = ${'1+'.repeat(5000)}1;`, 'a.js'],
  ['deep nesting', `${'('.repeat(200)}1${')'.repeat(200)};`, 'a.js'],
  [
    'an emotion file whose css prop is unreadable',
    '/** @jsxImportSource @emotion/react */\nconst A = () => <div css={maybe()} />;',
    'a.jsx',
  ],
  [
    'an emotion pragma inside a string, not a comment',
    'const s = "@jsxImportSource @emotion/react";\nconst A = () => <div />;',
    'a.jsx',
  ],
  ['an unknown extension', 'const a = 1;', 'a.weird'],
  ['no extension at all', 'const a = 1;', 'file'],
];

describe('the AST walk', () => {
  /**
   * A recursive walk overflowed the call stack on deeply nested source, and
   * whether it did depended on how much stack the process had left — an
   * intermittent crash rather than a refusal. The depth here is far past what
   * any recursive version survives, so the regression cannot hide behind luck.
   */
  test('handles a tree far deeper than the call stack allows', () => {
    let node: { +type: string, +inner: mixed } = { type: 'Leaf', inner: null };
    for (let i = 0; i < 200000; i++) {
      node = { type: 'Wrapper', inner: node };
    }

    let visited = 0;
    expect(() => {
      walk(node, () => {
        visited++;
      });
    }).not.toThrow();
    expect(visited).toBe(200001);
  });

  test('visits nodes in source order', () => {
    const tree = {
      type: 'Root',
      body: [
        { type: 'First', value: { type: 'FirstChild' } },
        { type: 'Second' },
      ],
    };
    const seen = [];
    walk(tree, (node) => {
      seen.push(node.type);
    });
    expect(seen).toEqual(['Root', 'First', 'FirstChild', 'Second']);
  });
});

describe('robustness', () => {
  test.each(AWKWARD_INPUTS)(
    'returns a verdict for %s',
    (_name, source, filename) => {
      let result;
      expect(() => {
        result = proposeStaticConversion({ source, filename });
      }).not.toThrow();
      expect(VALID_STATUSES).toContain(result?.status);
    },
  );

  test('every file in this package gets a verdict and none crash', () => {
    const roots = [
      path.join(__dirname, '..', 'src'),
      path.join(__dirname, '..', '__tests__'),
    ];
    const files = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, String(entry.name));
        if (entry.isDirectory()) {
          visit(full);
        } else if (full.endsWith('.js')) {
          files.push(full);
        }
      }
    };
    roots.forEach(visit);
    expect(files.length).toBeGreaterThan(10);

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const result = proposeStaticConversion({ source, filename: file });
      expect(VALID_STATUSES).toContain(result.status);
    }
  });
});

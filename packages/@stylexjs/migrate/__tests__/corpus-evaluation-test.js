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
import {
  evaluateCorpusSources,
  formatCorpusSummary,
} from '../src/evaluation/corpus';
import type { CorpusSource } from '../src/evaluation/corpus';

const PRAGMA = '/** @jsxImportSource @emotion/react */\n';
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  'build',
  'coverage',
  'dist',
  'lib',
  'node_modules',
  'vendor',
]);

function collectSources(root: string): $ReadOnlyArray<CorpusSource> {
  const sources: Array<CorpusSource> = [];
  const pending = [path.resolve(root)];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory == null) {
      continue;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = String(entry.name);
      const absolute = path.join(directory, name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(name)) {
          pending.push(absolute);
        }
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(path.extname(name)) &&
        !name.endsWith('.d.ts')
      ) {
        sources.push({
          filename: path.relative(root, absolute),
          source: fs.readFileSync(absolute, 'utf8'),
        });
      }
    }
  }
  return sources.sort((left, right) =>
    left.filename.localeCompare(right.filename),
  );
}

describe('Phase C corpus evaluation', () => {
  test('reports passing models and precise discovery refusals', () => {
    const summary = evaluateCorpusSources([
      { filename: 'Plain.js', source: 'export const plain = true;\n' },
      {
        filename: 'Flat.jsx',
        source: `${PRAGMA}export const Flat = () => <div css={{ color: 'red' }} />;`,
      },
      {
        filename: 'Mixed.jsx',
        source: `${PRAGMA}export const Mixed = () => <><div css={{ margin: '1px 2px' }} /><Button css={{ color: 'red' }} /></>;`,
      },
      {
        filename: 'Unsupported.jsx',
        source: `${PRAGMA}export const Unsupported = () => <div css={{ ':active': { color: 'red' } }} />;`,
      },
    ]);

    expect(summary.files).toEqual({
      scanned: 4,
      mentioningEmotion: 3,
      recognizedEmotion: 3,
      proposed: 2,
      partiallyProposed: 1,
      noSupportedSites: 1,
      refused: 0,
      notEmotion: 1,
      crashed: 0,
    });
    expect(summary.sites).toEqual({
      proposed: 2,
      refusedDuringDiscovery: 2,
    });
    expect(summary.comparisonModels).toEqual({
      'box-shorthand-referee-v1': 1,
      'static-css-v3': 1,
    });
    expect(summary.discoveryRefusals).toEqual({
      'css-on-component': 1,
      'unsupported-condition': 1,
    });
    expect(summary.crashes).toEqual([]);
  });

  test('formats counts without inventing a coverage percentage', () => {
    const summary = evaluateCorpusSources([
      {
        filename: 'Flat.jsx',
        source: `${PRAGMA}export const Flat = () => <div css={{ color: 'red' }} />;`,
      },
    ]);
    const report = formatCorpusSummary({
      label: 'fixture',
      revision: 'abc123',
      summary,
    });
    expect(report).toContain('correctness-gated proposed sites: 1');
    expect(report).toContain('These are counts, not a conversion percentage');
    expect(report).not.toMatch(/\d+%/);
  });

  test('evaluates a configured repository corpus without crashes', () => {
    const root = process.env.STYLEX_MIGRATE_CORPUS_ROOT;
    if (root == null) {
      return;
    }
    const label =
      process.env.STYLEX_MIGRATE_CORPUS_LABEL ?? path.basename(root);
    const revision = process.env.STYLEX_MIGRATE_CORPUS_REVISION ?? 'unknown';
    const summary = evaluateCorpusSources(collectSources(root));
    const report = formatCorpusSummary({ label, revision, summary });
    process.stdout.write(`\n${report}\n`);
    const reportPath = process.env.STYLEX_MIGRATE_CORPUS_REPORT;
    if (reportPath != null) {
      fs.writeFileSync(reportPath, report, 'utf8');
    }
    expect(summary.files.crashed).toBe(0);
  }, 600000);
});

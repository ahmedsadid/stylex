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
import { runRuntimeCommandProvider } from '../src/index';
import type {
  RepositoryEvidenceSubject,
  RuntimeCommandProviderConfig,
} from '../src/index';
import { createTempDir, removeTempDir } from './utils/tempRepo';
const { browserTest } = require('./utils/playwrightBrowser');

const collector = path.join(__dirname, 'utils/playwrightRuntimeCollector.js');
const testWithBrowser = browserTest(test);

const SUBJECT: RepositoryEvidenceSubject = Object.freeze({
  kind: 'candidate',
  id: 'playwright-subject',
  candidateId: 'candidate-1',
  candidateIds: Object.freeze(['candidate-1']),
  changes: Object.freeze([
    Object.freeze({
      path: 'src/Card.jsx',
      sourceHash: 'source',
      targetHash: 'target',
      siteIds: Object.freeze(['site-card']),
    }),
  ]),
});

const PROVIDER: RuntimeCommandProviderConfig = Object.freeze({
  id: 'playwright-fixture',
  kind: 'runtime-command',
  check: 'runtime-render',
  checkVersion: 'playwright-collector-v1',
  subject: 'candidate',
  cost: 'expensive',
  runtimeInterface: 'playwright',
  argv: Object.freeze([process.execPath, collector]),
  versionArgv: Object.freeze([
    process.execPath,
    '-e',
    "process.stdout.write('playwright-collector-v1')",
  ]),
  cwd: '.',
  allowedEnv: Object.freeze([
    'PATH',
    'STYLEX_MIGRATE_REQUIRE_MANAGED_PLAYWRIGHT',
  ]),
  fileGlobs: Object.freeze(['src/**']),
  limitations: Object.freeze(['real browser fixture']),
  timeoutMs: 30000,
  cases: Object.freeze([
    Object.freeze({
      id: 'card-dark-hover',
      changePaths: Object.freeze(['src/Card.jsx']),
      siteIds: Object.freeze(['site-card']),
      theme: 'dark',
      interaction: 'hover',
      viewport: Object.freeze({
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
      }),
    }),
  ]),
});

function html(color: string): string {
  return `<!doctype html>
<html data-theme="dark">
  <head>
    <style>
      [data-runtime-target="card"] {
        color: ${color};
        background-color: rgb(0, 0, 0);
        display: block;
        padding: 8px;
      }
      [data-runtime-target="card"]:hover { padding-top: 12px; }
    </style>
  </head>
  <body><div data-runtime-target="card" aria-label="Card">Card</div></body>
</html>`;
}

describe('M8 Playwright runtime collector', () => {
  let baseline: string;
  let candidate: string;

  beforeEach(() => {
    baseline = createTempDir('stylex-migrate-playwright-baseline-');
    candidate = createTempDir('stylex-migrate-playwright-candidate-');
    fs.writeFileSync(path.join(baseline, 'fixture.html'), html('red'));
    fs.writeFileSync(path.join(candidate, 'fixture.html'), html('red'));
  });

  afterEach(() => {
    removeTempDir(baseline);
    removeTempDir(candidate);
  });

  testWithBrowser(
    'matches real browser output and catches a seeded computed-style regression',
    async () => {
      const matched = await runRuntimeCommandProvider(PROVIDER, {
        workspaceRoot: candidate,
        baselineWorkspaceRoot: baseline,
        subject: SUBJECT,
      });
      expect(matched.evidence).toMatchObject({
        result: 'pass',
        runtime: {
          baselineKind: 'retained-repository',
          runtimeInterface: 'playwright',
          comparison: {
            result: 'matched',
            coverage: { matchedCaseIds: ['card-dark-hover'] },
          },
        },
      });

      fs.writeFileSync(path.join(candidate, 'fixture.html'), html('blue'));
      const different = await runRuntimeCommandProvider(PROVIDER, {
        workspaceRoot: candidate,
        baselineWorkspaceRoot: baseline,
        subject: SUBJECT,
      });
      expect(different.evidence).toMatchObject({
        result: 'fail',
        runtime: {
          comparison: {
            result: 'different',
            cases: [
              {
                id: 'card-dark-hover',
                differences: [
                  expect.objectContaining({
                    category: 'computedStyles',
                    path: '/card/color',
                  }),
                ],
              },
            ],
          },
        },
      });
    },
    90000,
  );
});

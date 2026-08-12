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
import { spawnSync } from 'child_process';
import { emitGeneratedRuntimeCollector } from '../src/index';
import { createTempDir, removeTempDir } from './utils/tempRepo';

let browserAvailable = false;
let browserUnavailableReason = 'no Playwright browser executable was found';
try {
  const { chromium } = require('playwright');
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    chromium.executablePath(),
  ];
  browserAvailable = candidates.some((candidate) => fs.existsSync(candidate));
  browserUnavailableReason = `none of these paths exists: ${candidates.join(', ')}`;
} catch (error) {
  browserUnavailableReason =
    error instanceof Error ? error.message : 'Playwright could not be loaded';
}
if (
  process.env.STYLEX_MIGRATE_REQUIRE_PLAYWRIGHT === '1' &&
  !browserAvailable
) {
  throw new Error(
    `Playwright is required for this test run, but ${browserUnavailableReason}`,
  );
}
const testWithBrowser = browserAvailable ? test : test.skip;

describe('generated runtime collector in Playwright', () => {
  let fixture: string;

  beforeEach(() => {
    fixture = createTempDir('stylex-migrate-generated-collector-');
  });

  afterEach(() => removeTempDir(fixture));

  testWithBrowser(
    'normalizes source CSS independently and matches candidate computed styles',
    () => {
      const collectorPath = path.join(fixture, 'collector.cjs');
      const serverPath = path.join(fixture, 'server.cjs');
      const configPath = path.join(fixture, 'config.json');
      fs.writeFileSync(collectorPath, emitGeneratedRuntimeCollector());
      fs.writeFileSync(
        serverPath,
        `'use strict';
const http = require('node:http');
http.createServer((_request, response) => {
  response.writeHead(200, {'content-type': 'text/html'});
  response.end('<!doctype html><style>[data-theme-probe]{color:#111}</style><body><div data-theme-probe="root">Root</div></body>');
}).listen(4179, '127.0.0.1');
`,
      );
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          protocolVersion: 'stylex-migrate-evidence-surface-v2',
          packageRoot: '.',
          playwrightPackage: 'playwright',
          nativeSurfaceDisposition: 'none-known',
          server: {
            argv: [process.execPath, serverPath],
            cwd: fixture,
            inputFiles: [serverPath],
            url: 'http://127.0.0.1:4179/',
            timeoutMs: 5000,
          },
          cases: [
            {
              id: 'theme-light-root',
              changePaths: ['src/App.tsx'],
              siteIds: [],
              theme: 'light',
              interaction: 'initial',
              viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
              path: '/',
              actions: [],
              targets: [
                {
                  id: 'root',
                  selector: '[data-theme-probe="root"]',
                  computedProperties: ['color'],
                  attributes: [],
                  observeDom: false,
                  observeRef: false,
                },
              ],
            },
          ],
          syntheticCssExpectations: {
            protocolVersion: 'stylex-migrate-synthetic-css-expectations-v1',
            source: {
              kind: 'theme-decision-draft',
              id: 'theme-draft-1234567890abcdef',
              definitionHash: 'd'.repeat(64),
            },
            cases: [
              {
                id: 'theme-light-root',
                computedStyles: { root: { color: '#111' } },
              },
            ],
          },
        }),
      );

      const result = spawnSync(process.execPath, [collectorPath, configPath], {
        cwd: path.resolve(__dirname, '..', '..', '..', '..'),
        encoding: 'utf8',
        timeout: 30000,
      });
      if (result.status !== 0) {
        throw new Error(result.stderr || `collector exited ${result.status}`);
      }
      const output = JSON.parse(String(result.stdout));
      expect(output).toMatchObject({
        protocolVersion: 'stylex-migrate-generated-runtime-result-v1',
        expected: {
          cases: [
            {
              id: 'theme-light-root',
              observation: {
                computedStyles: { root: { color: 'rgb(17, 17, 17)' } },
                dom: {},
                refs: {},
              },
            },
          ],
        },
        candidate: {
          cases: [
            {
              id: 'theme-light-root',
              observation: {
                computedStyles: { root: { color: 'rgb(17, 17, 17)' } },
                dom: {},
                refs: {},
              },
            },
          ],
        },
      });
    },
    60000,
  );
});

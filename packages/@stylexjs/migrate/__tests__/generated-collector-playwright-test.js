/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawnSync } from 'child_process';
import { emitGeneratedRuntimeCollector } from '../src/index';
import { createTempDir, removeTempDir } from './utils/tempRepo';
const { browserTest } = require('./utils/playwrightBrowser');

const testWithBrowser = browserTest(test);

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const address = server.address();
      if (address == null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a local evidence-server port'));
        return;
      }
      server.close((error) =>
        error == null ? resolve(address.port) : reject(error),
      );
    });
  });
}

describe('generated runtime collector in Playwright', () => {
  let fixture: string;

  beforeEach(() => {
    fixture = createTempDir('stylex-migrate-generated-collector-');
  });

  afterEach(() => removeTempDir(fixture));

  testWithBrowser(
    'normalizes source CSS independently and matches candidate computed styles',
    async () => {
      const port = await availablePort();
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
}).listen(${String(port)}, '127.0.0.1');
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
            url: `http://127.0.0.1:${String(port)}/`,
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

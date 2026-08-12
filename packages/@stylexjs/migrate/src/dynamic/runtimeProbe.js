/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import path from 'path';
import {
  assertCurrentDynamicStrategy,
  loadDynamicStrategyDraft,
} from './decisions';
import {
  EVIDENCE_SURFACE_PROTOCOL_VERSION,
  normalizeEvidenceSurfaceDefinition,
} from '../runtime/evidenceSurfaceModel';
import { openEvidenceSurfaceTask } from '../runtime/evidenceSurfaceTask';
import type { ContextOpenResult } from '../context/lifecycle';
import type { ProjectState } from '../state/project';
import type { EvidenceSurfaceSupportOutput } from '../runtime/evidenceSurfaceTask';

export const DYNAMIC_RUNTIME_PROBE_PROTOCOL_VERSION: string =
  'stylex-migrate-dynamic-runtime-probe-v2';
const ENTRY_PATH = '.stylex-migrate-probes/dynamic-probe-entry.js';
const RSPACK_PATH = '.stylex-migrate-probes/dynamic-probe-rspack.cjs';
const SERVER_PATH = '.stylex-migrate-probes/dynamic-probe-server.cjs';

type DynamicProbeInput = {
  +protocolVersion: string,
  +packageRoot: string,
  +playwrightPackage: 'playwright' | '@playwright/test',
  +nativeSurfaceDisposition: 'none-known' | 'known-insufficient',
  +consumer: { +file: string, +exportName: string },
  +siteIds: $ReadOnlyArray<string>,
  +cases: $ReadOnlyArray<{
    +id: string,
    +props: mixed,
    +theme: string,
    +interaction: string,
  }>,
  +targets: $ReadOnlyArray<mixed>,
  +viewport: { +width: number, +height: number, +deviceScaleFactor: number },
  +rationale: string,
  +limitations: $ReadOnlyArray<string>,
};

function object(value: mixed): boolean {
  return value != null && !Array.isArray(value) && typeof value === 'object';
}

function entries(value: mixed): $ReadOnlyArray<[string, mixed]> {
  if (!object(value)) return [];
  return Object.entries(value as $FlowFixMe);
}

function strings(value: mixed): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => typeof item === 'string' && item !== '' && !item.includes('\0'),
    )
  );
}

function safeValue(value: mixed, depth: number = 0): boolean {
  if (depth > 8) return false;
  return (
    value == null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) &&
      value.every((item) => safeValue(item, depth + 1))) ||
    (object(value) &&
      entries(value).every(
        ([key, item]) =>
          key !== '' && !key.includes('\0') && safeValue(item, depth + 1),
      ))
  );
}

function safeRepositoryPath(value: mixed): boolean {
  if (typeof value !== 'string' || value === '' || value.includes('\\')) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return (
    normalized === value &&
    !path.posix.isAbsolute(value) &&
    value !== '..' &&
    !value.startsWith('../') &&
    !value.includes('/../') &&
    !value.includes('\0')
  );
}

function input(value: mixed): DynamicProbeInput {
  if (!object(value)) throw new Error('Invalid dynamic runtime-probe input');
  const source: $FlowFixMe = value;
  if (
    source.protocolVersion !== DYNAMIC_RUNTIME_PROBE_PROTOCOL_VERSION ||
    !object(source.consumer) ||
    !safeRepositoryPath(source.consumer.file) ||
    !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(source.consumer.exportName) ||
    !strings(source.siteIds) ||
    !Array.isArray(source.cases) ||
    source.cases.length === 0 ||
    !Array.isArray(source.targets) ||
    source.targets.length === 0 ||
    !object(source.viewport) ||
    typeof source.rationale !== 'string' ||
    source.rationale.trim() === '' ||
    !strings(source.limitations)
  ) {
    throw new Error('Invalid dynamic runtime-probe input');
  }
  for (const probeCase of source.cases) {
    if (
      !object(probeCase) ||
      typeof probeCase.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(probeCase.id) ||
      !object(probeCase.props) ||
      !safeValue(probeCase.props) ||
      typeof probeCase.theme !== 'string' ||
      probeCase.theme === '' ||
      typeof probeCase.interaction !== 'string' ||
      probeCase.interaction === ''
    ) {
      throw new Error('Invalid dynamic runtime-probe case');
    }
  }
  return source as $FlowFixMe;
}

function importSpecifier(target: string): string {
  const relative = path.posix.relative(path.posix.dirname(ENTRY_PATH), target);
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function entrySource(definition: DynamicProbeInput): string {
  const propsByCase = Object.fromEntries(
    definition.cases.map((probeCase) => [probeCase.id, probeCase.props]),
  );
  return `import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {${definition.consumer.exportName} as ProbeConsumer} from '${importSpecifier(definition.consumer.file)}';

const caseId = new URLSearchParams(window.location.search).get('case');
const propsByCase = ${JSON.stringify(propsByCase)};
if (caseId == null || propsByCase[caseId] == null) throw new Error('Unknown dynamic probe case');
const stylesheet = document.createElement('link');
stylesheet.rel = 'stylesheet';
stylesheet.href = './style.css';
stylesheet.addEventListener('load', () => {
  const root = document.createElement('main');
  root.dataset.stylexMigrateDynamicRoot = caseId;
  document.body.append(root);
  createRoot(root).render(React.createElement(ProbeConsumer, propsByCase[caseId]));
});
document.head.append(stylesheet);
`;
}

function rspackSource(): string {
  return String.raw`'use strict';
const path = require('node:path');
const moduleSearchPaths = [process.cwd(), process.env.STYLEX_MIGRATE_MODULE_ROOT].filter(Boolean);
const requireFromProbe = name => require(require.resolve(name, {paths: moduleSearchPaths}));
const rspackModule = requireFromProbe('@rspack/core');
const unpluginModule = requireFromProbe('@stylexjs/unplugin');
const stylexPlugin = unpluginModule.default || unpluginModule;
class SeedCssAssetPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('stylex-migrate-dynamic-probe-seed', compilation => {
      compilation.hooks.processAssets.tap(
        {name: 'stylex-migrate-dynamic-probe-seed', stage: rspackModule.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL},
        () => compilation.emitAsset('style.css', new rspackModule.sources.RawSource('/* stylex-migrate-dynamic-probe */\n')),
      );
    });
  }
}
const moduleDirectories = [];
if (process.env.STYLEX_MIGRATE_MODULE_ROOT) {
  moduleDirectories.push(path.join(process.env.STYLEX_MIGRATE_MODULE_ROOT, 'node_modules'));
}
for (let current = process.cwd(); ; current = path.dirname(current)) {
  moduleDirectories.push(path.join(current, 'node_modules'));
  if (path.dirname(current) === current) break;
}
module.exports = {
  mode: 'production', context: process.cwd(), entry: path.join(__dirname, 'dynamic-probe-entry.js'),
  output: {path: path.join(__dirname, 'dynamic-probe-dist'), filename: 'probe.js', clean: true},
  module: {rules: [{test: /\.[jt]sx?$/, exclude: /node_modules/, loader: 'builtin:swc-loader', options: {jsc: {parser: {syntax: 'typescript', tsx: true}, transform: {react: {runtime: 'automatic'}}}}}]},
  resolve: {modules: moduleDirectories, alias: {
    sentry: path.join(process.cwd(), 'static/app'),
    '@sentry/scraps': path.join(process.cwd(), 'static/app/components/core'),
  }, extensions: ['.tsx', '.ts', '.jsx', '.js', '.json']},
  plugins: [new SeedCssAssetPlugin(), stylexPlugin.rspack({dev: false, useCSSLayers: true}), new rspackModule.HtmlRspackPlugin({title: 'StyleX dynamic probe'})],
};
`;
}

function serverSource(port: number): string {
  return String.raw`'use strict';
const fs = require('node:fs'); const http = require('node:http'); const path = require('node:path');
const moduleSearchPaths = [process.cwd(), process.env.STYLEX_MIGRATE_MODULE_ROOT].filter(Boolean);
const requireFromProbe = name => require(require.resolve(name, {paths: moduleSearchPaths}));
const rspackModule = requireFromProbe('@rspack/core'); const config = require('./dynamic-probe-rspack.cjs');
const compiler = rspackModule.rspack(config);
compiler.run((error, stats) => {
  compiler.close(() => {}); if (error) throw error;
  if (!stats || stats.hasErrors()) throw new Error(stats ? stats.toString({colors: false}) : 'Rspack returned no stats');
  const root = path.join(__dirname, 'dynamic-probe-dist');
  http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (filename.includes('/') || filename.includes('\\')) { response.writeHead(404).end(); return; }
    const file = path.join(root, filename);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
    const contentType = filename.endsWith('.css') ? 'text/css' : filename.endsWith('.js') ? 'text/javascript' : 'text/html';
    response.writeHead(200, {'content-type': contentType}); response.end(fs.readFileSync(file));
  }).listen(${String(port)}, '127.0.0.1');
});
`;
}

export function openDynamicRuntimeProbeTask({
  project,
  strategyId,
  assumptionId,
  value,
  goal,
  workspaceRoot,
  now,
}: {
  +project: ProjectState,
  +strategyId: string,
  +assumptionId: string,
  +value: mixed,
  +goal: string,
  +workspaceRoot?: string,
  +now?: () => string,
}): ContextOpenResult {
  const strategy = loadDynamicStrategyDraft(project, strategyId);
  if (strategy == null) {
    return {
      ok: false,
      state: 'blocked',
      reasons: Object.freeze([`No dynamic strategy found for ${strategyId}.`]),
    };
  }
  assertCurrentDynamicStrategy(project, strategy);
  const definition = input(value);
  const port =
    30000 + (Number.parseInt(strategy.definitionHash.slice(0, 8), 16) % 20000);
  const changePaths = [definition.consumer.file];
  const cases = definition.cases.map((probeCase) => ({
    id: probeCase.id,
    changePaths,
    siteIds: definition.siteIds,
    theme: probeCase.theme,
    interaction: probeCase.interaction,
    viewport: definition.viewport,
    path: `/?case=${encodeURIComponent(probeCase.id)}`,
    actions: [] as Array<mixed>,
    targets: definition.targets,
  }));
  const supportOutputs: $ReadOnlyArray<EvidenceSurfaceSupportOutput> =
    Object.freeze([
      {
        path: ENTRY_PATH,
        contents: Buffer.from(entrySource(definition), 'utf8'),
      },
      { path: RSPACK_PATH, contents: Buffer.from(rspackSource(), 'utf8') },
      { path: SERVER_PATH, contents: Buffer.from(serverSource(port), 'utf8') },
    ]);
  return openEvidenceSurfaceTask({
    project,
    assumptionId,
    input: normalizeEvidenceSurfaceDefinition({
      protocolVersion: EVIDENCE_SURFACE_PROTOCOL_VERSION,
      packageRoot: definition.packageRoot,
      playwrightPackage: definition.playwrightPackage,
      nativeSurfaceDisposition: definition.nativeSurfaceDisposition,
      server: {
        argv: ['node', SERVER_PATH],
        cwd: '.',
        inputFiles: [],
        url: `http://127.0.0.1:${String(port)}/`,
        timeoutMs: 120000,
      },
      cases,
      expectedObservations: null,
      syntheticCssExpectations: null,
      rationale: definition.rationale,
      limitations: definition.limitations,
    }),
    supportOutputs,
    goal,
    workspaceRoot,
    now,
  });
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import path from 'path';
import type { ThemeDecisionDraft } from './model';
import type { EvidenceSurfaceSupportOutput } from '../runtime/evidenceSurfaceTask';
import type { ThemeProbeTarget } from './runtimeProbe';

export const THEME_PROBE_ENTRY_PATH: string =
  '.stylex-migrate-probes/theme-probe-entry.js';
export const THEME_PROBE_RSPACK_PATH: string =
  '.stylex-migrate-probes/theme-probe-rspack.cjs';
export const THEME_PROBE_SERVER_PATH: string =
  '.stylex-migrate-probes/theme-probe-server.cjs';

function importSpecifier(from: string, target: string): string {
  const relative = path.posix.relative(path.posix.dirname(from), target);
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function styleDeclarations(
  target: ThemeProbeTarget,
  names: $ReadOnlyMap<string, string>,
): string {
  return target.properties
    .map((property) => {
      const targetName = names.get(property.sourcePath);
      if (targetName == null) {
        throw new Error(
          `Theme runtime probe token ${property.sourcePath} is unavailable`,
        );
      }
      return `    ${JSON.stringify(property.cssProperty)}: themeVars.${targetName},`;
    })
    .join('\n');
}

function entrySource(
  draft: ThemeDecisionDraft,
  targets: { +root: ThemeProbeTarget, +portal: ThemeProbeTarget },
  consumer: { +file: string, +exportName: string } | null,
): string {
  const names = new Map(
    draft.tokens.map((token) => [token.sourcePath, token.targetName]),
  );
  const variants = new Map(
    draft.variants.map((variant) => [variant.name, variant.exportName]),
  );
  const light = variants.get('light');
  const dark = variants.get('dark');
  if (light == null || dark == null) {
    throw new Error('Generated theme harness requires light and dark variants');
  }
  const styleKeys = new Map([
    [draft.varsExport, 'themeVars'],
    [light, 'lightTheme'],
    [dark, 'darkTheme'],
  ]);
  if (styleKeys.size !== 3) {
    throw new Error('Theme runtime probe exports must be distinct');
  }
  const consumerImports =
    consumer == null
      ? ''
      : `import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {${consumer.exportName} as ProbeConsumer} from '${importSpecifier(THEME_PROBE_ENTRY_PATH, consumer.file)}';

`;
  const probeBody =
    consumer == null
      ? `  const element = document.createElement('div');
  element.dataset.stylexMigrateProbe = location;
  element.className = location === 'root'
    ? stylex.props(styles.root).className
    : stylex.props(styles.portal).className;
  element.textContent = location;
  return element;`
      : `  const element = document.createElement('div');
  element.dataset.stylexMigrateProbe = location;
  createRoot(element).render(React.createElement(ProbeConsumer));
  return element;`;
  return `${consumerImports}import * as stylex from '@stylexjs/stylex';

import {
  ${dark} as darkTheme,
  ${light} as lightTheme,
  ${draft.varsExport} as themeVars,
} from '${importSpecifier(THEME_PROBE_ENTRY_PATH, draft.targetModule)}';

const themeName = new URLSearchParams(window.location.search).get('theme') === 'dark'
  ? 'dark'
  : 'light';
const theme = themeName === 'dark' ? darkTheme : lightTheme;
const styles = stylex.create({
  root: {
${styleDeclarations(targets.root, names)}
  },
  portal: {
${styleDeclarations(targets.portal, names)}
  },
});

function probe(location) {
${probeBody}
}

const stylesheet = document.createElement('link');
stylesheet.rel = 'stylesheet';
stylesheet.href = './style.css';
stylesheet.addEventListener('load', () => {
  const themeClassName = stylex.props(theme).className;
  document.body.classList.add(...themeClassName.split(' ').filter(Boolean));
  document.body.dataset.stylexMigrateTheme = themeName;

  const applicationRoot = document.createElement('main');
  applicationRoot.dataset.stylexMigrateRoot = '';
  applicationRoot.append(probe('root'));
  document.body.append(applicationRoot);

  const portalHost = document.createElement('div');
  portalHost.dataset.stylexMigratePortalHost = 'body';
  portalHost.append(probe('portal'));
  document.body.append(portalHost);
});
document.head.append(stylesheet);
`;
}

function rspackSource(): string {
  return String.raw`'use strict';
const path = require('node:path');
const rspackModule = require('@rspack/core');
const unpluginModule = require('@stylexjs/unplugin');
const stylexPlugin = unpluginModule.default || unpluginModule;

class SeedCssAssetPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('stylex-migrate-theme-probe-seed', compilation => {
      compilation.hooks.processAssets.tap(
        {
          name: 'stylex-migrate-theme-probe-seed',
          stage: rspackModule.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        () => compilation.emitAsset(
          'style.css',
          new rspackModule.sources.RawSource('/* stylex-migrate-theme-probe */\n'),
        ),
      );
    });
  }
}

const moduleDirectories = [];
for (let current = process.cwd(); ; current = path.dirname(current)) {
  moduleDirectories.push(path.join(current, 'node_modules'));
  if (path.dirname(current) === current) break;
}

module.exports = {
  mode: 'production',
  context: process.cwd(),
  entry: path.join(__dirname, 'theme-probe-entry.js'),
  output: {
    path: path.join(__dirname, 'theme-probe-dist'),
    filename: 'probe.js',
    clean: true,
  },
  module: {
    rules: [{
      test: /\.[jt]sx?$/,
      exclude: /node_modules/,
      loader: 'builtin:swc-loader',
      options: {
        jsc: {
          parser: {syntax: 'typescript', tsx: true},
          transform: {react: {runtime: 'automatic'}},
        },
      },
    }],
  },
  resolve: {modules: moduleDirectories},
  plugins: [
    new SeedCssAssetPlugin(),
    stylexPlugin.rspack({dev: false, useCSSLayers: true}),
    new rspackModule.HtmlRspackPlugin({title: 'StyleX migration theme probe'}),
  ],
};
`;
}

function serverSource(port: number): string {
  return String.raw`'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const rspackModule = require('@rspack/core');
const config = require('./theme-probe-rspack.cjs');

const compiler = rspackModule.rspack(config);
compiler.run((error, stats) => {
  compiler.close(() => {});
  if (error) throw error;
  if (!stats || stats.hasErrors()) {
    throw new Error(stats ? stats.toString({colors: false}) : 'Rspack returned no stats');
  }
  const root = path.join(__dirname, 'theme-probe-dist');
  http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (filename.includes('/') || filename.includes('\\')) {
      response.writeHead(404).end();
      return;
    }
    const file = path.join(root, filename);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    const contentType = filename.endsWith('.css')
      ? 'text/css'
      : filename.endsWith('.js')
        ? 'text/javascript'
        : 'text/html';
    response.writeHead(200, {'content-type': contentType});
    response.end(fs.readFileSync(file));
  }).listen(${String(port)}, '127.0.0.1');
});
`;
}

export function emitThemeProbeHarness({
  draft,
  targets,
  consumer = null,
  port,
}: {
  +draft: ThemeDecisionDraft,
  +targets: { +root: ThemeProbeTarget, +portal: ThemeProbeTarget },
  +consumer?: { +file: string, +exportName: string } | null,
  +port: number,
}): $ReadOnlyArray<EvidenceSurfaceSupportOutput> {
  return Object.freeze([
    {
      path: THEME_PROBE_ENTRY_PATH,
      contents: Buffer.from(entrySource(draft, targets, consumer), 'utf8'),
    },
    {
      path: THEME_PROBE_RSPACK_PATH,
      contents: Buffer.from(rspackSource(), 'utf8'),
    },
    {
      path: THEME_PROBE_SERVER_PATH,
      contents: Buffer.from(serverSource(port), 'utf8'),
    },
  ]);
}

export function generatedThemeProbeServer(port: number): {
  +argv: $ReadOnlyArray<string>,
  +cwd: string,
  +inputFiles: $ReadOnlyArray<string>,
  +url: string,
  +timeoutMs: number,
} {
  return Object.freeze({
    argv: Object.freeze(['node', THEME_PROBE_SERVER_PATH]),
    cwd: '.',
    inputFiles: Object.freeze([]),
    url: `http://127.0.0.1:${String(port)}/`,
    timeoutMs: 120000,
  });
}

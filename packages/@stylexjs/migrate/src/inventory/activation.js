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
import type { FactProvenance, FactStatus } from './model';

export type ProjectActivation = {
  +status: FactStatus,
  +source: string | null,
  +inputFiles: $ReadOnlyArray<string>,
  +provenance: $ReadOnlyArray<FactProvenance>,
};

const JSON_CONFIGS: $ReadOnlyArray<string> = [
  'tsconfig.json',
  'jsconfig.json',
  '.babelrc',
  '.babelrc.json',
  'package.json',
];

const DYNAMIC_CONFIGS: $ReadOnlyArray<string> = [
  'babel.config.js',
  'babel.config.cjs',
  'babel.config.mjs',
  'babel.config.ts',
];

function emotionImportSource(value: mixed): boolean {
  return value === '@emotion/react';
}

function presetActivatesEmotion(preset: mixed): boolean {
  if (preset === '@emotion/babel-preset-css-prop') {
    return true;
  }
  if (!Array.isArray(preset)) {
    return false;
  }
  const [name, options] = preset;
  if (name === '@emotion/babel-preset-css-prop') {
    return true;
  }
  return (
    (name === '@babel/preset-react' || name === 'preset-react') &&
    options != null &&
    typeof options === 'object' &&
    emotionImportSource(options.importSource)
  );
}

function configActivatesEmotion(config: $FlowFixMe): boolean {
  if (
    config != null &&
    typeof config === 'object' &&
    config.compilerOptions != null &&
    typeof config.compilerOptions === 'object' &&
    emotionImportSource(config.compilerOptions.jsxImportSource)
  ) {
    return true;
  }
  if (emotionImportSource(config?.jsxImportSource)) {
    return true;
  }
  const babel = config?.babel ?? config;
  return Array.isArray(babel?.presets)
    ? babel.presets.some(presetActivatesEmotion)
    : false;
}

export function analyzeProjectActivation(
  repositoryRoot: string,
): ProjectActivation {
  const inputs: Array<string> = [];
  const provenance: Array<FactProvenance> = [];
  let knownSource: string | null = null;
  let failed = false;

  for (const relative of JSON_CONFIGS) {
    const absolute = path.join(repositoryRoot, relative);
    if (!fs.existsSync(absolute)) {
      continue;
    }
    inputs.push(relative);
    try {
      const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
      if (configActivatesEmotion(parsed)) {
        knownSource = relative;
        provenance.push({
          kind: 'config',
          file: relative,
          detail: 'project configuration selects the Emotion JSX runtime',
        });
      } else {
        provenance.push({
          kind: 'config',
          file: relative,
          detail: 'inspected; no Emotion JSX activation found',
        });
      }
    } catch (error) {
      failed = true;
      provenance.push({
        kind: 'config',
        file: relative,
        detail: `could not parse configuration (${error instanceof Error ? error.message : String(error)})`,
      });
    }
  }

  for (const relative of DYNAMIC_CONFIGS) {
    const absolute = path.join(repositoryRoot, relative);
    if (!fs.existsSync(absolute)) {
      continue;
    }
    inputs.push(relative);
    failed = true;
    provenance.push({
      kind: 'config',
      file: relative,
      detail: 'dynamic configuration was not executed during static analysis',
    });
  }

  if (knownSource != null) {
    return Object.freeze({
      status: 'known',
      source: knownSource,
      inputFiles: Object.freeze([...new Set(inputs)].sort()),
      provenance: Object.freeze(provenance),
    });
  }
  if (failed) {
    return Object.freeze({
      status: 'resolution-failed',
      source: null,
      inputFiles: Object.freeze([...new Set(inputs)].sort()),
      provenance: Object.freeze(provenance),
    });
  }
  return Object.freeze({
    status: 'unknown',
    source: null,
    inputFiles: Object.freeze([...new Set(inputs)].sort()),
    provenance: Object.freeze(
      provenance.length > 0
        ? provenance
        : [
            {
              kind: 'config',
              file: null,
              detail: 'no supported project activation configuration found',
            },
          ],
    ),
  });
}

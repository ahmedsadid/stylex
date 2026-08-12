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
import { canonicalRoot, git } from '../kernel/snapshot';
import { hashString, shortHash } from '../kernel/hash';
import { parseSource } from '../static/parse';
import { walk } from '../static/walk';
import { canonicalJson, immutableJson } from '../state/json';
import { matchesGlob } from '../candidate/scope';

export const THEME_TOPOLOGY_MODEL: string = 'stylex-theme-topology-v1';

export type ThemeTopologyKind =
  | 'body-host'
  | 'document-element-host'
  | 'body-portal'
  | 'document-element-portal'
  | 'secondary-window'
  | 'secondary-document'
  | 'theme-class-mutation';

export type ThemeTopologyObservation = {
  +kind: ThemeTopologyKind,
  +file: string,
  +line: number,
  +detail: string,
};

export type ThemeTopologyInspection = {
  +model: string,
  +id: string,
  +repositoryRoot: string,
  +status: 'observed' | 'not-observed' | 'resolution-failed',
  +observations: $ReadOnlyArray<ThemeTopologyObservation>,
  +resolutionFailures: $ReadOnlyArray<{ +file: string, +detail: string }>,
  +inputFiles: $ReadOnlyArray<string>,
  +limitations: $ReadOnlyArray<string>,
  +inspectedAt: string,
};

function member(node: $FlowFixMe, object: string, property: string): boolean {
  return (
    node?.type === 'MemberExpression' &&
    node.computed !== true &&
    node.object?.type === 'Identifier' &&
    node.object.name === object &&
    node.property?.type === 'Identifier' &&
    node.property.name === property
  );
}

function memberProperty(node: $FlowFixMe, property: string): boolean {
  return (
    node?.type === 'MemberExpression' &&
    node.computed !== true &&
    node.property?.type === 'Identifier' &&
    node.property.name === property
  );
}

function callName(node: $FlowFixMe, name: string): boolean {
  return (
    node?.type === 'CallExpression' &&
    ((node.callee?.type === 'Identifier' && node.callee.name === name) ||
      memberProperty(node.callee, name))
  );
}

function line(node: $FlowFixMe): number {
  return Number(node.loc?.start?.line ?? 1);
}

function observation(
  kind: ThemeTopologyKind,
  file: string,
  node: $FlowFixMe,
  detail: string,
): ThemeTopologyObservation {
  return Object.freeze({ kind, file, line: line(node), detail });
}

function expandBraces(pattern: string): $ReadOnlyArray<string> {
  const match = /^(.*)\{([^{}]+)\}(.*)$/.exec(pattern);
  if (match == null) return [pattern];
  return match[2]
    .split(',')
    .flatMap((part) => expandBraces(`${match[1]}${part}${match[3]}`));
}

function inspectSource(
  source: string,
  file: string,
): $ReadOnlyArray<ThemeTopologyObservation> {
  const parsed = parseSource(source, file);
  if (!parsed.ok) throw new Error(parsed.reason);
  const output: Array<ThemeTopologyObservation> = [];
  walk(parsed.ast, (node) => {
    if (member(node, 'document', 'body')) {
      output.push(
        observation(
          'body-host',
          file,
          node,
          'observed a direct document.body reference',
        ),
      );
    }
    if (member(node, 'document', 'documentElement')) {
      output.push(
        observation(
          'document-element-host',
          file,
          node,
          'observed a direct document.documentElement reference',
        ),
      );
    }
    if (callName(node, 'createPortal')) {
      const target = node.arguments?.[1];
      if (member(target, 'document', 'body')) {
        output.push(
          observation(
            'body-portal',
            file,
            node,
            'observed createPortal targeting document.body',
          ),
        );
      } else if (member(target, 'document', 'documentElement')) {
        output.push(
          observation(
            'document-element-portal',
            file,
            node,
            'observed createPortal targeting document.documentElement',
          ),
        );
      }
    }
    if (
      node.type === 'CallExpression' &&
      (member(node.callee, 'window', 'open') ||
        member(node.callee, 'globalThis', 'open'))
    ) {
      output.push(
        observation(
          'secondary-window',
          file,
          node,
          'observed an explicit secondary-window open call',
        ),
      );
    }
    if (
      memberProperty(node, 'ownerDocument') ||
      memberProperty(node, 'contentDocument')
    ) {
      output.push(
        observation(
          'secondary-document',
          file,
          node,
          `observed ${String(node.property.name)} access`,
        ),
      );
    }
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'MemberExpression' &&
      node.callee.object?.type === 'MemberExpression' &&
      memberProperty(node.callee.object, 'classList') &&
      node.callee.property?.type === 'Identifier' &&
      ['add', 'remove', 'replace', 'toggle'].includes(
        String(node.callee.property.name),
      )
    ) {
      output.push(
        observation(
          'theme-class-mutation',
          file,
          node,
          `observed classList.${String(node.callee.property.name)} mutation`,
        ),
      );
    }
  });
  return Object.freeze(output);
}

export function inspectThemeTopology({
  repositoryRoot,
  sourceGlobs = ['**/*.{js,jsx,ts,tsx}'],
  now = () => new Date().toISOString(),
}: {
  +repositoryRoot: string,
  +sourceGlobs?: $ReadOnlyArray<string>,
  +now?: () => string,
}): ThemeTopologyInspection {
  const root = canonicalRoot(repositoryRoot);
  const extensions = new Set(['.js', '.jsx', '.ts', '.tsx']);
  const patterns = sourceGlobs.flatMap(expandBraces);
  // Inventory globs are recorded for identity. This first topology model
  // intentionally limits parsing to tracked JS/TS source files.
  const files = git(root, ['ls-files', '-z'])
    .split('\0')
    .filter(
      (file) =>
        file !== '' &&
        extensions.has(path.extname(file)) &&
        patterns.some((glob) => matchesGlob(glob, file)),
    )
    .sort();
  const observations: Array<ThemeTopologyObservation> = [];
  const failures = [];
  for (const file of files) {
    try {
      observations.push(
        ...inspectSource(fs.readFileSync(path.join(root, file), 'utf8'), file),
      );
    } catch (error) {
      failures.push({
        file,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  observations.sort((left, right) =>
    `${left.file}:${String(left.line).padStart(9, '0')}:${left.kind}`.localeCompare(
      `${right.file}:${String(right.line).padStart(9, '0')}:${right.kind}`,
    ),
  );
  const definition = {
    model: THEME_TOPOLOGY_MODEL,
    repositoryRoot: root,
    sourceGlobs: [...sourceGlobs],
    observations,
    resolutionFailures: failures,
    inputFiles: files,
    limitations: [
      'Syntactic topology observations do not prove reachability, active theme selection, portal ownership, nested scope, SSR, hydration, or runtime behavior.',
      'Aliased DOM hosts and dynamically computed portal targets may remain unobserved.',
    ],
  };
  const identity = hashString(canonicalJson(definition as $FlowFixMe));
  return immutableJson({
    ...definition,
    id: `theme-topology-${shortHash(identity)}`,
    status:
      observations.length > 0
        ? 'observed'
        : failures.length > 0
          ? 'resolution-failed'
          : 'not-observed',
    inspectedAt: now(),
  }) as $FlowFixMe;
}

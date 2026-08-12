/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import fs from 'fs';
import { canonicalRoot, git } from '../kernel/snapshot';
import { hashString, shortHash } from '../kernel/hash';
import { canonicalJson, immutableJson } from '../state/json';
import type { FactStatus } from '../inventory/model';

export const RUNTIME_SURFACE_DISCOVERY_VERSION: string =
  'stylex-migrate-runtime-surface-discovery-v2';

export type RuntimeSurfaceKind = 'playwright' | 'storybook' | 'component-test';

export type RuntimeSurfaceInspection = {
  +kind: RuntimeSurfaceKind,
  +status: FactStatus,
  +configFiles: $ReadOnlyArray<string>,
  +manifestFiles: $ReadOnlyArray<string>,
  +dependencies: $ReadOnlyArray<string>,
  +packageScripts: $ReadOnlyArray<{
    +manifest: string,
    +name: string,
    +command: string,
  }>,
  +detail: string,
};

export type RuntimeSurfaceDiscovery = {
  +protocolVersion: string,
  +id: string,
  +repositoryRoot: string,
  +packageRoot: string,
  +surfaces: $ReadOnlyArray<RuntimeSurfaceInspection>,
  +inputFiles: $ReadOnlyArray<string>,
  +inspectedAt: string,
};

const CONFIG_PATTERNS: {
  +[RuntimeSurfaceKind]: $ReadOnlyArray<RegExp>,
} = {
  playwright: [/(?:^|\/)playwright\.config\.(?:js|jsx|cjs|mjs|ts|tsx)$/],
  storybook: [/(?:^|\/)\.storybook\/main\.(?:js|jsx|cjs|mjs|ts|tsx)$/],
  'component-test': [
    /(?:^|\/)vitest\.config\.(?:js|jsx|cjs|mjs|ts|tsx)$/,
    /(?:^|\/)jest\.config\.(?:js|jsx|cjs|mjs|ts|tsx)$/,
  ],
};

const DEPENDENCIES: { +[RuntimeSurfaceKind]: $ReadOnlyArray<RegExp> } = {
  playwright: [/^playwright$/, /^@playwright\/test$/],
  storybook: [/^storybook$/, /^@storybook\//],
  'component-test': [
    /^@playwright\/experimental-ct-/,
    /^@testing-library\/react$/,
    /^vitest$/,
    /^jest$/,
  ],
};

const SCRIPT_PATTERNS: { +[RuntimeSurfaceKind]: RegExp } = {
  playwright: /(?:^|\s|\/)playwright(?:\s|$)/,
  storybook: /(?:^|\s|\/)storybook(?:\s|$)/,
  'component-test':
    /(?:^|\s|\/)(?:vitest|jest|playwright\s+(?:test\s+)?--ct)(?:\s|$)/,
};

const COMPONENT_RENDER_DEPENDENCY = [
  /^@playwright\/experimental-ct-/,
  /^@testing-library\/react$/,
];

type ManifestObservation = {
  +path: string,
  +status: 'known' | 'resolution-failed',
  +dependencies: $ReadOnlyArray<string>,
  +scripts: $ReadOnlyArray<{ +name: string, +command: string }>,
};

function trackedFiles(root: string): $ReadOnlyArray<string> {
  return Object.freeze(
    git(root, ['ls-files', '-z'])
      .split('\0')
      .filter((file) => file !== '')
      .sort(),
  );
}

function manifest(root: string, file: string): ManifestObservation {
  try {
    const value = JSON.parse(fs.readFileSync(`${root}/${file}`, 'utf8'));
    if (value == null || Array.isArray(value) || typeof value !== 'object') {
      throw new Error('manifest root is not an object');
    }
    const dependencies = [
      ...new Set(
        ['dependencies', 'devDependencies', 'peerDependencies'].flatMap(
          (section) =>
            value[section] != null &&
            !Array.isArray(value[section]) &&
            typeof value[section] === 'object'
              ? Object.keys(value[section])
              : [],
        ),
      ),
    ].sort();
    const scripts =
      value.scripts != null &&
      !Array.isArray(value.scripts) &&
      typeof value.scripts === 'object'
        ? Object.entries(value.scripts)
            .filter((entry) => typeof entry[1] === 'string')
            .map(([name, command]) => ({ name, command: String(command) }))
            .sort((left, right) => left.name.localeCompare(right.name))
        : [];
    return Object.freeze({
      path: file,
      status: 'known',
      dependencies: Object.freeze(dependencies),
      scripts: Object.freeze(scripts),
    });
  } catch (_error) {
    return Object.freeze({
      path: file,
      status: 'resolution-failed',
      dependencies: Object.freeze([]),
      scripts: Object.freeze([]),
    });
  }
}

export function inspectRuntimeSurfaces({
  repositoryRoot,
  packageRoot = '.',
  now = () => new Date().toISOString(),
}: {
  +repositoryRoot: string,
  +packageRoot?: string,
  +now?: () => string,
}): RuntimeSurfaceDiscovery {
  const root = canonicalRoot(repositoryRoot);
  if (
    packageRoot !== '.' &&
    (packageRoot === '' ||
      packageRoot.startsWith('/') ||
      packageRoot.includes('\\') ||
      packageRoot
        .split('/')
        .some((segment) => segment === '' || segment === '..'))
  ) {
    throw new Error(`Invalid runtime package root: ${packageRoot}`);
  }
  const prefix = packageRoot === '.' ? '' : `${packageRoot}/`;
  const tracked = trackedFiles(root).filter((file) =>
    prefix === ''
      ? !file.includes('/')
      : file.startsWith(prefix) && !file.slice(prefix.length).includes('/'),
  );
  const allTracked = trackedFiles(root);
  const selectedManifest = `${prefix}package.json`;
  const nestedPackageRoots = allTracked
    .filter(
      (file) =>
        file.endsWith('/package.json') &&
        file !== selectedManifest &&
        file.startsWith(prefix),
    )
    .map((file) => file.slice(0, -'package.json'.length));
  const manifests = tracked
    .filter((file) => file === 'package.json' || file.endsWith('/package.json'))
    .map((file) => manifest(root, file));
  const surfaces = (Object.keys(CONFIG_PATTERNS) as Array<RuntimeSurfaceKind>)
    .map((kind) => {
      const configFiles = allTracked.filter((file) => {
        const relative =
          prefix === ''
            ? file
            : file.startsWith(prefix)
              ? file.slice(prefix.length)
              : null;
        return (
          relative != null &&
          !relative.startsWith('../') &&
          !nestedPackageRoots.some((nested) => file.startsWith(nested)) &&
          CONFIG_PATTERNS[kind].some((pattern) => pattern.test(relative))
        );
      });
      const dependencies = [
        ...new Set(
          manifests.flatMap((item) =>
            item.dependencies.filter((dependency) =>
              DEPENDENCIES[kind].some((pattern) => pattern.test(dependency)),
            ),
          ),
        ),
      ].sort();
      const packageScripts = manifests
        .flatMap((item) =>
          item.scripts
            .filter(({ command }) => SCRIPT_PATTERNS[kind].test(command))
            .map(({ name, command }) => ({
              manifest: item.path,
              name,
              command,
            })),
        )
        .sort((left, right) =>
          `${left.manifest}:${left.name}`.localeCompare(
            `${right.manifest}:${right.name}`,
          ),
        );
      const manifestFiles = manifests
        .filter(
          (item) =>
            item.dependencies.some((dependency) =>
              dependencies.includes(dependency),
            ) || packageScripts.some((script) => script.manifest === item.path),
        )
        .map((item) => item.path)
        .sort();
      const failed = manifests.some(
        (item) => item.status === 'resolution-failed',
      );
      const hasComponentRenderer = dependencies.some((dependency) =>
        COMPONENT_RENDER_DEPENDENCY.some((pattern) => pattern.test(dependency)),
      );
      const executable = configFiles.length > 0 || packageScripts.length > 0;
      const status: FactStatus =
        executable && (kind !== 'component-test' || hasComponentRenderer)
          ? 'known'
          : failed
            ? 'resolution-failed'
            : dependencies.length > 0
              ? 'inferred'
              : 'unknown';
      const detail =
        status === 'known'
          ? 'repository-native executable surface and required rendering support were observed'
          : status === 'inferred'
            ? 'supporting dependencies were observed, but no executable surface was identified'
            : status === 'resolution-failed'
              ? 'one or more package manifests could not be parsed'
              : 'no repository-native surface was observed';
      return Object.freeze({
        kind,
        status,
        configFiles: Object.freeze(configFiles),
        manifestFiles: Object.freeze(manifestFiles),
        dependencies: Object.freeze(dependencies),
        packageScripts: Object.freeze(packageScripts),
        detail,
      });
    })
    .sort((left, right) => left.kind.localeCompare(right.kind));
  const inputFiles = [
    ...new Set([
      ...manifests.map((item) => item.path),
      ...surfaces.flatMap((surface) => surface.configFiles),
    ]),
  ].sort();
  const definition = {
    protocolVersion: RUNTIME_SURFACE_DISCOVERY_VERSION,
    repositoryRoot: root,
    packageRoot,
    surfaces,
    inputFiles,
  };
  const identity = hashString(canonicalJson(definition as $FlowFixMe));
  return immutableJson({
    ...definition,
    id: `runtime-surfaces-${shortHash(identity)}`,
    inspectedAt: now(),
  }) as $FlowFixMe;
}

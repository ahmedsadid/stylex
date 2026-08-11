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
import { hashString, shortHash } from '../kernel/hash';
import { canonicalRoot } from '../kernel/snapshot';
import { createFact } from '../inventory/model';
import { canonicalJson, immutableJson } from '../state/json';
import type { Fact, FactProvenance, FactStatus } from '../inventory/model';
import type { JsonValue } from '../state/json';

export const BOOTSTRAP_DISCOVERY_PROTOCOL_VERSION: string =
  'stylex-migrate-bootstrap-discovery-v1';

export type PackageManagerName = 'pnpm' | 'yarn' | 'npm';
export type BuildIntegrationKind =
  | 'rspack'
  | 'webpack'
  | 'vite'
  | 'babel'
  | 'next-swc';

export type PackageManagerInspection = {
  +status: FactStatus,
  +name: PackageManagerName | null,
  +version: string | null,
  +source: string | null,
  +lockfile: string | null,
  +inputFiles: $ReadOnlyArray<string>,
};

export type BootstrapPackageInspection = {
  +status: FactStatus,
  +root: string,
  +manifestPath: string,
  +name: string | null,
  +stylexDependencies: { +[name: string]: string },
};

export type BuildIntegrationInspection = {
  +kind: BuildIntegrationKind,
  +status: FactStatus,
  +configFiles: $ReadOnlyArray<string>,
  +packageScripts: $ReadOnlyArray<string>,
  +stylexConfigured: boolean,
  +stylexSources: $ReadOnlyArray<string>,
};

export type BootstrapInspection = {
  +protocolVersion: string,
  +id: string,
  +repositoryRoot: string,
  +packageManager: PackageManagerInspection,
  +packages: $ReadOnlyArray<BootstrapPackageInspection>,
  +integrations: $ReadOnlyArray<BuildIntegrationInspection>,
  +facts: $ReadOnlyArray<Fact>,
  +inputFiles: $ReadOnlyArray<string>,
  +inspectedAt: string,
};

type ManifestRead = {
  +status: 'known' | 'resolution-failed',
  +path: string,
  +value: { +[string]: JsonValue } | null,
  +detail: string | null,
};

const LOCKFILES: $ReadOnlyArray<{
  +name: PackageManagerName,
  +file: string,
}> = [
  { name: 'pnpm', file: 'pnpm-lock.yaml' },
  { name: 'yarn', file: 'yarn.lock' },
  { name: 'npm', file: 'package-lock.json' },
  { name: 'npm', file: 'npm-shrinkwrap.json' },
];

const CONFIG_FILES: { +[BuildIntegrationKind]: $ReadOnlyArray<string> } = {
  rspack: [
    'rspack.config.js',
    'rspack.config.cjs',
    'rspack.config.mjs',
    'rspack.config.ts',
  ],
  webpack: [
    'webpack.config.js',
    'webpack.config.cjs',
    'webpack.config.mjs',
    'webpack.config.ts',
  ],
  vite: [
    'vite.config.js',
    'vite.config.cjs',
    'vite.config.mjs',
    'vite.config.ts',
  ],
  babel: [
    '.babelrc',
    '.babelrc.json',
    '.babelrc.js',
    '.babelrc.cjs',
    'babel.config.js',
    'babel.config.cjs',
    'babel.config.mjs',
    'babel.config.ts',
  ],
  'next-swc': [
    'next.config.js',
    'next.config.cjs',
    'next.config.mjs',
    'next.config.ts',
  ],
};

const STYLEX_PACKAGES: $ReadOnlyArray<string> = [
  '@stylexjs/stylex',
  '@stylexjs/babel-plugin',
  '@stylexjs/unplugin',
  '@stylexjs/nextjs-plugin',
];

function repositoryRelative(root: string, absolute: string): string {
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith('../') ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path is outside the repository: ${absolute}`);
  }
  return relative;
}

function readManifest(root: string, manifestPath: string): ManifestRead {
  const absolute = path.join(root, manifestPath);
  try {
    const bytes = fs.readFileSync(absolute);
    const source = bytes.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(bytes)) {
      return {
        status: 'resolution-failed',
        path: manifestPath,
        value: null,
        detail: 'manifest is not valid UTF-8',
      };
    }
    const parsed = JSON.parse(source);
    if (parsed == null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('manifest root is not an object');
    }
    return {
      status: 'known',
      path: manifestPath,
      value: parsed,
      detail: null,
    };
  } catch (error) {
    return {
      status: 'resolution-failed',
      path: manifestPath,
      value: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function nearestManifest(root: string, sourceFile: string): string | null {
  const absoluteSource = path.resolve(root, sourceFile);
  const relative = path.relative(root, absoluteSource);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Bootstrap source path is outside the repository: ${sourceFile}`,
    );
  }
  let directory = path.dirname(absoluteSource);
  for (;;) {
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest)) {
      return repositoryRelative(root, manifest);
    }
    if (directory === root) {
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory || !parent.startsWith(root)) {
      break;
    }
    directory = parent;
  }
  return null;
}

function packageManagerField(
  manifest: ManifestRead | null,
): { +name: PackageManagerName, +version: string | null } | null {
  const field = manifest?.value?.packageManager;
  if (typeof field !== 'string') {
    return null;
  }
  const match = /^(pnpm|yarn|npm)@([^+\s]+)(?:\+.*)?$/.exec(field);
  if (match == null) {
    return null;
  }
  const name = match[1];
  if (name !== 'pnpm' && name !== 'yarn' && name !== 'npm') {
    return null;
  }
  return { name, version: match[2] };
}

function inspectPackageManager(
  root: string,
  rootManifest: ManifestRead | null,
): PackageManagerInspection {
  const presentLocks = LOCKFILES.filter(({ file }) =>
    fs.existsSync(path.join(root, file)),
  );
  const inputs = [
    ...(rootManifest == null ? [] : [rootManifest.path]),
    ...presentLocks.map(({ file }) => file),
  ].sort();
  const declared = packageManagerField(rootManifest);
  const lockNames = [...new Set(presentLocks.map(({ name }) => name))];

  if (
    rootManifest?.status === 'resolution-failed' ||
    lockNames.length > 1 ||
    (declared != null &&
      lockNames.length === 1 &&
      lockNames[0] !== declared.name)
  ) {
    return Object.freeze({
      status: 'resolution-failed',
      name: declared?.name ?? null,
      version: declared?.version ?? null,
      source: declared == null ? null : (rootManifest?.path ?? null),
      lockfile: presentLocks.length === 1 ? presentLocks[0].file : null,
      inputFiles: Object.freeze(inputs),
    });
  }
  if (declared != null) {
    const matchingLock = presentLocks.find(
      ({ name }) => name === declared.name,
    );
    return Object.freeze({
      status: 'known',
      name: declared.name,
      version: declared.version,
      source: rootManifest?.path ?? null,
      lockfile: matchingLock?.file ?? null,
      inputFiles: Object.freeze(inputs),
    });
  }
  if (lockNames.length === 1) {
    const lock = presentLocks.find(({ name }) => name === lockNames[0]);
    return Object.freeze({
      status: 'inferred',
      name: lockNames[0],
      version: null,
      source: lock?.file ?? null,
      lockfile: lock?.file ?? null,
      inputFiles: Object.freeze(inputs),
    });
  }
  return Object.freeze({
    status: 'unknown',
    name: null,
    version: null,
    source: null,
    lockfile: null,
    inputFiles: Object.freeze(inputs),
  });
}

function dependenciesOf(manifest: ManifestRead): { +[name: string]: string } {
  const output: { [string]: string } = {};
  for (const section of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const values = manifest.value?.[section];
    if (values == null || Array.isArray(values) || typeof values !== 'object') {
      continue;
    }
    for (const name of STYLEX_PACKAGES) {
      const version = values[name];
      if (typeof version === 'string') {
        output[name] = version;
      }
    }
  }
  return Object.freeze(output);
}

function packageInspection(
  root: string,
  manifestPath: string,
): { +inspection: BootstrapPackageInspection, +manifest: ManifestRead } {
  const manifest = readManifest(root, manifestPath);
  const packageRoot = path.posix.dirname(manifestPath);
  const name = manifest.value?.name;
  return {
    inspection: Object.freeze({
      status: manifest.status,
      root: packageRoot === '.' ? '' : packageRoot,
      manifestPath,
      name: typeof name === 'string' ? name : null,
      stylexDependencies: dependenciesOf(manifest),
    }),
    manifest,
  };
}

function scriptsForKind(
  manifests: $ReadOnlyArray<ManifestRead>,
  kind: BuildIntegrationKind,
): $ReadOnlyArray<string> {
  const needle = kind === 'next-swc' ? 'next' : kind;
  const scripts = [];
  for (const manifest of manifests) {
    const values = manifest.value?.scripts;
    if (values == null || Array.isArray(values) || typeof values !== 'object') {
      continue;
    }
    for (const name of Object.keys(values).sort()) {
      const command = values[name];
      if (typeof command === 'string' && command.includes(needle)) {
        scripts.push(`${manifest.path}#scripts.${name}`);
      }
    }
  }
  return Object.freeze([...new Set(scripts)].sort());
}

function stylexConfigured(
  kind: BuildIntegrationKind,
  sources: $ReadOnlyArray<{ +path: string, +source: string }>,
  manifests: $ReadOnlyArray<ManifestRead>,
): { +configured: boolean, +sources: $ReadOnlyArray<string> } {
  const hits = [];
  for (const config of sources) {
    const source = config.source;
    const configured =
      kind === 'babel'
        ? source.includes('@stylexjs/babel-plugin')
        : kind === 'next-swc'
          ? source.includes('@stylexjs/nextjs-plugin') ||
            source.includes('@stylexjs/babel-plugin')
          : source.includes('@stylexjs/unplugin') &&
            source.includes(`.${kind}(`);
    if (configured) {
      hits.push(config.path);
    }
  }
  if (kind === 'babel') {
    for (const manifest of manifests) {
      if (
        canonicalJson(manifest.value?.babel ?? null).includes(
          '@stylexjs/babel-plugin',
        )
      ) {
        hits.push(`${manifest.path}#babel`);
      }
    }
  }
  return {
    configured: hits.length > 0,
    sources: Object.freeze([...new Set(hits)].sort()),
  };
}

function inspectIntegrations(
  root: string,
  packageRoots: $ReadOnlyArray<string>,
  manifests: $ReadOnlyArray<ManifestRead>,
): {
  +integrations: $ReadOnlyArray<BuildIntegrationInspection>,
  +inputFiles: $ReadOnlyArray<string>,
} {
  const searchRoots = [...new Set(['', ...packageRoots])].sort();
  const allInputs = [];
  const integrations: Array<BuildIntegrationInspection> = [];
  for (const kind of Object.keys(CONFIG_FILES) as Array<BuildIntegrationKind>) {
    const configs: Array<{ +path: string, +source: string }> = [];
    let readFailed = false;
    for (const searchRoot of searchRoots) {
      for (const filename of CONFIG_FILES[kind]) {
        const relative =
          searchRoot === '' ? filename : `${searchRoot}/${filename}`;
        const absolute = path.join(root, relative);
        if (!fs.existsSync(absolute)) {
          continue;
        }
        allInputs.push(relative);
        try {
          const bytes = fs.readFileSync(absolute);
          const source = bytes.toString('utf8');
          if (!Buffer.from(source, 'utf8').equals(bytes)) {
            readFailed = true;
          } else {
            configs.push({ path: relative, source });
          }
        } catch (_error) {
          readFailed = true;
        }
      }
    }
    const scripts = scriptsForKind(manifests, kind);
    if (configs.length === 0 && scripts.length === 0 && !readFailed) {
      continue;
    }
    const stylex = stylexConfigured(kind, configs, manifests);
    integrations.push(
      Object.freeze({
        kind,
        status: readFailed
          ? 'resolution-failed'
          : scripts.length > 0
            ? 'known'
            : 'inferred',
        configFiles: Object.freeze(
          configs.map(({ path: file }) => file).sort(),
        ),
        packageScripts: scripts,
        stylexConfigured: stylex.configured,
        stylexSources: stylex.sources,
      }),
    );
  }
  return {
    integrations: Object.freeze(
      integrations.sort((a, b) => a.kind.localeCompare(b.kind)),
    ),
    inputFiles: Object.freeze([...new Set(allInputs)].sort()),
  };
}

function makeFacts({
  manager,
  packages,
  integrations,
}: {
  +manager: PackageManagerInspection,
  +packages: $ReadOnlyArray<BootstrapPackageInspection>,
  +integrations: $ReadOnlyArray<BuildIntegrationInspection>,
}): $ReadOnlyArray<Fact> {
  const facts = [
    createFact({
      kind: 'stylex-bootstrap-package-manager',
      status: manager.status,
      value: {
        name: manager.name,
        version: manager.version,
        source: manager.source,
        lockfile: manager.lockfile,
      },
      provenance: [
        {
          kind: 'config',
          file: manager.source,
          detail: 'package manager declaration and lockfile inspection',
        },
      ],
      inputFiles: manager.inputFiles,
    }),
  ];
  for (const target of packages) {
    facts.push(
      createFact({
        kind: 'stylex-bootstrap-package',
        status: target.status,
        value: {
          root: target.root,
          manifestPath: target.manifestPath,
          name: target.name,
          stylexDependencies: target.stylexDependencies,
        },
        provenance: [
          {
            kind: 'config',
            file: target.manifestPath,
            detail: 'nearest package manifest for selected source files',
          },
        ],
        inputFiles: [target.manifestPath],
      }),
    );
  }
  for (const integration of integrations) {
    const provenance: Array<FactProvenance> = [
      ...integration.configFiles.map(
        (file) =>
          ({
            kind: 'config',
            file,
            detail: `${integration.kind} configuration candidate`,
          }) as FactProvenance,
      ),
      ...integration.packageScripts.map(
        (script) =>
          ({
            kind: 'config',
            file: script.split('#')[0],
            detail: `${integration.kind} package script`,
          }) as FactProvenance,
      ),
    ];
    facts.push(
      createFact({
        kind: 'stylex-bootstrap-build-integration',
        status: integration.status,
        value: integration as $FlowFixMe,
        provenance,
        inputFiles: integration.configFiles.concat(
          integration.packageScripts.map((script) => script.split('#')[0]),
        ),
      }),
    );
  }
  return Object.freeze(facts.sort((a, b) => a.id.localeCompare(b.id)));
}

export function inspectBootstrap({
  repositoryRoot,
  sourceFiles = [],
  now = () => new Date().toISOString(),
}: {
  +repositoryRoot: string,
  +sourceFiles?: $ReadOnlyArray<string>,
  +now?: () => string,
}): BootstrapInspection {
  const root = canonicalRoot(repositoryRoot);
  const rootManifestPath = fs.existsSync(path.join(root, 'package.json'))
    ? 'package.json'
    : null;
  const manifestPaths = new Set<string>();
  if (rootManifestPath != null) {
    manifestPaths.add(rootManifestPath);
  }
  for (const sourceFile of sourceFiles) {
    const manifest = nearestManifest(root, sourceFile);
    if (manifest != null) {
      manifestPaths.add(manifest);
    }
  }
  const packageReads = [...manifestPaths]
    .sort()
    .map((manifestPath) => packageInspection(root, manifestPath));
  const rootManifest =
    packageReads.find(({ manifest }) => manifest.path === 'package.json')
      ?.manifest ?? null;
  const manager = inspectPackageManager(root, rootManifest);
  const packages = Object.freeze(
    packageReads
      .map(({ inspection }) => inspection)
      .sort((a, b) => a.manifestPath.localeCompare(b.manifestPath)),
  );
  const integrationResult = inspectIntegrations(
    root,
    packages.map((target) => target.root),
    packageReads.map(({ manifest }) => manifest),
  );
  const facts = makeFacts({
    manager,
    packages,
    integrations: integrationResult.integrations,
  });
  const inputFiles = Object.freeze(
    [
      ...new Set([
        ...manager.inputFiles,
        ...packages.map((target) => target.manifestPath),
        ...integrationResult.inputFiles,
      ]),
    ].sort(),
  );
  const definition = {
    protocolVersion: BOOTSTRAP_DISCOVERY_PROTOCOL_VERSION,
    repositoryRoot: root,
    packageManager: manager,
    packages,
    integrations: integrationResult.integrations,
    facts,
    inputFiles,
  };
  const id = `bootstrap-${shortHash(hashString(canonicalJson(definition as $FlowFixMe)))}`;
  return immutableJson({
    ...definition,
    id,
    inspectedAt: now(),
  }) as $FlowFixMe;
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { evidence } from '../evidence/claims';
import { hashString } from '../kernel/hash';
import { gitBuffer } from '../kernel/snapshot';
import { parseSource } from '../static/parse';
import { walk } from '../static/walk';
import { canonicalJson } from '../state/json';
import type { CandidatePatch } from '../candidate/patch';
import type { BootstrapContextTaskOrigin } from '../context/capsule';
import type { EvidenceResult } from '../kernel/evidence';

export const BOOTSTRAP_WIRING_MODEL: string = 'stylex-bootstrap-wiring-v1';
export const BOOTSTRAP_WIRING_LIMITATION: string =
  'This frozen-byte check confirms declared StyleX dependencies and syntactic build-plugin wiring. It does not prove dependency installation, compiler execution, CSS emission, repository build success, or runtime behavior.';

export type BootstrapGuardResult = {
  +complete: boolean,
  +violations: $ReadOnlyArray<string>,
  +evidence: $ReadOnlyArray<EvidenceResult>,
};

function sourceAt(candidate: CandidatePatch, file: string): string | null {
  const change = candidate.changes.find((item) => item.path === file);
  if (change != null) {
    return change.status === 'deleted' ? null : change.content;
  }
  try {
    const bytes = gitBuffer(candidate.repositoryRoot, [
      'show',
      `${candidate.baseCommit}:${file}`,
    ]);
    const source = bytes.toString('utf8');
    return Buffer.from(source, 'utf8').equals(bytes) ? source : null;
  } catch (_error) {
    return null;
  }
}

function baseSourceAt(candidate: CandidatePatch, file: string): string | null {
  try {
    const bytes = gitBuffer(candidate.repositoryRoot, [
      'show',
      `${candidate.baseCommit}:${file}`,
    ]);
    const source = bytes.toString('utf8');
    return Buffer.from(source, 'utf8').equals(bytes) ? source : null;
  } catch (_error) {
    return null;
  }
}

function manifestObject(source: string): { [string]: mixed } | null {
  try {
    const value = JSON.parse(source);
    return value != null && !Array.isArray(value) && typeof value === 'object'
      ? value
      : null;
  } catch (_error) {
    return null;
  }
}

function manifestDependencies(source: string): Set<string> | null {
  const manifest = manifestObject(source);
  if (manifest == null) return null;
  try {
    const output = new Set<string>();
    for (const section of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      const values = manifest[section];
      if (
        values == null ||
        Array.isArray(values) ||
        typeof values !== 'object'
      ) {
        continue;
      }
      for (const name of Object.keys(values)) {
        const value = values[name];
        if (typeof value === 'string' && value.length > 0) {
          output.add(name);
        }
      }
    }
    return output;
  } catch (_error) {
    return null;
  }
}

function withoutAllowedDependencies(
  manifest: { [string]: mixed },
  allowed: $ReadOnlyArray<string>,
): mixed {
  const copy: { [string]: mixed } = JSON.parse(JSON.stringify(manifest));
  for (const section of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const values: $FlowFixMe = copy[section];
    if (values == null || Array.isArray(values) || typeof values !== 'object') {
      continue;
    }
    for (const name of allowed) delete values[name];
    if (Object.keys(values).length === 0) delete copy[section];
  }
  return copy;
}

function manifestChangeIsBounded(
  source: string,
  target: string,
  allowed: $ReadOnlyArray<string>,
): boolean {
  const before = manifestObject(source);
  const after = manifestObject(target);
  return (
    before != null &&
    after != null &&
    canonicalJson(withoutAllowedDependencies(before, allowed) as $FlowFixMe) ===
      canonicalJson(withoutAllowedDependencies(after, allowed) as $FlowFixMe)
  );
}

function unpluginBindings(ast: $FlowFixMe): Set<string> {
  const bindings = new Set<string>();
  walk(ast, (node) => {
    if (
      node.type !== 'ImportDeclaration' ||
      node.source?.value !== '@stylexjs/unplugin'
    ) {
      return;
    }
    for (const specifier of node.specifiers ?? []) {
      if (
        (specifier.type === 'ImportDefaultSpecifier' ||
          specifier.type === 'ImportNamespaceSpecifier') &&
        specifier.local?.type === 'Identifier'
      ) {
        bindings.add(String(specifier.local.name));
      }
    }
  });
  return bindings;
}

function rspackAdapterCall(node: $FlowFixMe, bindings: Set<string>): boolean {
  return (
    node?.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    node.callee.computed !== true &&
    node.callee.object?.type === 'Identifier' &&
    bindings.has(String(node.callee.object.name)) &&
    node.callee.property?.type === 'Identifier' &&
    node.callee.property.name === 'rspack'
  );
}

function pluginArray(node: $FlowFixMe): boolean {
  return (
    node?.type === 'ObjectProperty' &&
    node.computed !== true &&
    ((node.key?.type === 'Identifier' && node.key.name === 'plugins') ||
      (node.key?.type === 'StringLiteral' && node.key.value === 'plugins')) &&
    node.value?.type === 'ArrayExpression'
  );
}

function normalizedConfigAst(
  value: mixed,
  bindings: Set<string>,
  inPlugins: boolean = false,
): mixed {
  if (Array.isArray(value)) {
    return value
      .filter((item) => {
        const node: $FlowFixMe = item;
        return (
          !(
            node?.type === 'ImportDeclaration' &&
            node.source?.value === '@stylexjs/unplugin'
          ) && !(inPlugins && rspackAdapterCall(node, bindings))
        );
      })
      .map((item) => normalizedConfigAst(item, bindings, false));
  }
  if (value == null || typeof value !== 'object') return value;
  const node: $FlowFixMe = value;
  if (
    node.type === 'ImportDeclaration' &&
    node.source?.value === '@stylexjs/unplugin'
  ) {
    return null;
  }
  const output: { [string]: mixed } = {};
  for (const key of Object.keys(node).sort()) {
    if (
      key === 'start' ||
      key === 'end' ||
      key === 'loc' ||
      key === 'extra' ||
      key === 'comments' ||
      key === 'leadingComments' ||
      key === 'trailingComments' ||
      key === 'innerComments' ||
      key === 'tokens' ||
      key === 'errors'
    ) {
      continue;
    }
    const childInPlugins =
      (pluginArray(node) && key === 'value') ||
      (inPlugins && node.type === 'ArrayExpression' && key === 'elements');
    output[key] = normalizedConfigAst(node[key], bindings, childInPlugins);
  }
  return output;
}

function rspackConfigChangeIsBounded(
  source: string,
  target: string,
  file: string,
): boolean {
  const before = parseSource(source, file);
  const after = parseSource(target, file);
  if (!before.ok || !after.ok) return false;
  const bindings = unpluginBindings(after.ast);
  if (bindings.size === 0) return false;
  return (
    canonicalJson(normalizedConfigAst(before.ast, new Set()) as $FlowFixMe) ===
    canonicalJson(normalizedConfigAst(after.ast, bindings) as $FlowFixMe)
  );
}

function rspackWired(source: string, file: string): boolean {
  const parsed = parseSource(source, file);
  if (!parsed.ok) return false;
  const bindings = unpluginBindings(parsed.ast);
  let wired = false;
  walk(parsed.ast, (node) => {
    if (
      pluginArray(node) &&
      node.value.elements.some((element) =>
        rspackAdapterCall(element, bindings),
      )
    ) {
      wired = true;
    }
  });
  return wired;
}

function requiredDependencies(
  integration: BootstrapContextTaskOrigin['integration'],
): $ReadOnlyArray<string> {
  if (
    integration === 'rspack' ||
    integration === 'webpack' ||
    integration === 'vite'
  ) {
    return ['@stylexjs/stylex', '@stylexjs/unplugin'];
  }
  if (integration === 'babel') {
    return ['@stylexjs/stylex', '@stylexjs/babel-plugin'];
  }
  return ['@stylexjs/stylex', '@stylexjs/nextjs-plugin'];
}

export function inspectBootstrapCandidate({
  candidate,
  origin,
  bootstrapPaths,
}: {
  +candidate: CandidatePatch,
  +origin: BootstrapContextTaskOrigin,
  +bootstrapPaths: $ReadOnlyArray<string>,
}): BootstrapGuardResult {
  const violations = [];
  const manifestPath =
    origin.packageRoot.length === 0
      ? 'package.json'
      : `${origin.packageRoot}/package.json`;
  const manifest = sourceAt(candidate, manifestPath);
  const dependencies = manifest == null ? null : manifestDependencies(manifest);
  const required = requiredDependencies(origin.integration);
  if (dependencies == null) {
    violations.push(`${manifestPath}: package manifest is missing or invalid.`);
  } else {
    for (const dependency of required) {
      if (!dependencies.has(dependency)) {
        violations.push(`${manifestPath}: missing ${dependency}.`);
      }
    }
  }
  const baseManifest = baseSourceAt(candidate, manifestPath);
  if (
    manifest != null &&
    baseManifest != null &&
    !manifestChangeIsBounded(baseManifest, manifest, required)
  ) {
    violations.push(
      `${manifestPath}: bootstrap may change only the required StyleX dependency entries.`,
    );
  }

  const configPaths = bootstrapPaths.filter((file) =>
    file.includes(`${origin.integration}.config.`),
  );
  if (configPaths.length === 0) {
    violations.push(
      `No ${origin.integration} configuration path was authorized.`,
    );
  } else if (origin.integration === 'rspack') {
    const wired = configPaths.some((file) => {
      const source = sourceAt(candidate, file);
      return source != null && rspackWired(source, file);
    });
    if (!wired) {
      violations.push(
        'No authorized Rspack config imports @stylexjs/unplugin and invokes its rspack adapter.',
      );
    }
    for (const file of configPaths) {
      const source = baseSourceAt(candidate, file);
      const target = sourceAt(candidate, file);
      if (
        source != null &&
        target != null &&
        !rspackConfigChangeIsBounded(source, target, file)
      ) {
        violations.push(
          `${file}: bootstrap may add only the StyleX unplugin import and direct rspack adapter entries in plugins arrays.`,
        );
      }
    }
  } else {
    violations.push(
      `${origin.integration} bootstrap wiring is not implemented by ${BOOTSTRAP_WIRING_MODEL}.`,
    );
  }

  const lockfiles = bootstrapPaths.filter((file) =>
    /(?:^|\/)(?:pnpm-lock\.yaml|yarn\.lock|package-lock\.json|npm-shrinkwrap\.json)$/.test(
      file,
    ),
  );
  if (
    lockfiles.length > 0 &&
    !lockfiles.some((file) => candidate.touchedFiles.includes(file))
  ) {
    violations.push('The package-manager lockfile was not updated.');
  }

  if (violations.length > 0) {
    return Object.freeze({
      complete: false,
      violations: Object.freeze(violations),
      evidence: Object.freeze([]),
    });
  }
  const subjectPath = configPaths[0] ?? manifestPath;
  const subjectSource = sourceAt(candidate, subjectPath);
  const subjectChange = candidate.changes.find(
    (change) => change.path === subjectPath,
  );
  return Object.freeze({
    complete: true,
    violations: Object.freeze([]),
    evidence: Object.freeze([
      evidence({
        check: 'stylex-bootstrap-wiring',
        provider: 'stylex-migrate',
        subject: {
          file: subjectPath,
          sourceHash: null,
          targetHash:
            subjectChange?.contentHash ??
            (subjectSource == null ? null : hashString(subjectSource)),
          model: BOOTSTRAP_WIRING_MODEL,
        },
        scope: bootstrapPaths,
        result: 'pass',
        detail: `The ${origin.integration} candidate declares the required StyleX packages and build-plugin wiring.`,
        limitations: [BOOTSTRAP_WIRING_LIMITATION],
      }),
    ]),
  });
}

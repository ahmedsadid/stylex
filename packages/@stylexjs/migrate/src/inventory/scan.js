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
import { canonicalRoot } from '../kernel/snapshot';
import { hashBytes } from '../kernel/hash';
import { matchesGlob } from '../candidate/scope';
import { discoverSyntax, usesEmotion } from '../adapters/emotion/discover';
import { discoverStyledReadinessFacts } from '../adapters/emotion/styledReadiness';
import { discoverStyledUsageFacts } from '../adapters/emotion/styledUsage';
import { discoverStyledTemplateFacts } from '../adapters/emotion/styledTemplate';
import { parseSource } from '../static/parse';
import { discoverThemeFacts } from '../theme/discover';
import { analyzeProjectActivation } from './activation';
import { analyzeLocalDependencies } from './resolve';
import { createFact, inventoryIdentity, siteIdentity } from './model';
import type {
  Classification,
  Fact,
  Inventory,
  InventoryDiagnostic,
  InventoryFile,
  Site,
} from './model';
import type { ProjectActivation } from './activation';

const SKIPPED_DIRECTORIES: $ReadOnlySet<string> = new Set([
  '.git',
  '.stylex-migrate',
  'node_modules',
]);

const REPEATABLE_REFUSALS: $ReadOnlySet<string> = new Set([
  'css-on-component',
  'css-prop-not-object-literal',
  'spread-in-style-object',
  'nested-style-object',
  'template-literal-value',
  'non-literal-value',
]);

function expandBraces(pattern: string): $ReadOnlyArray<string> {
  const match = /^(.*)\{([^{}]+)\}(.*)$/.exec(pattern);
  if (match == null) {
    return [pattern];
  }
  return match[2]
    .split(',')
    .flatMap((part) => expandBraces(`${match[1]}${part}${match[3]}`));
}

function sourceFiles(
  repositoryRoot: string,
  sourceGlobs: $ReadOnlyArray<string>,
): $ReadOnlyArray<string> {
  const patterns = sourceGlobs.flatMap(expandBraces);
  const files = [];
  const pending = [repositoryRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory == null) {
      continue;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = String(entry.name);
      const absolute = path.join(directory, name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(name)) {
          pending.push(absolute);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relative = path
        .relative(repositoryRoot, absolute)
        .split(path.sep)
        .join('/');
      if (patterns.some((pattern) => matchesGlob(pattern, relative))) {
        files.push(relative);
      }
    }
  }
  return files.sort();
}

function hasEmotionValueImport(ast: $FlowFixMe): boolean {
  return (ast.program?.body ?? []).some((node) => {
    if (
      node.type !== 'ImportDeclaration' ||
      (node.source?.value !== '@emotion/react' &&
        node.source?.value !== '@emotion/core') ||
      node.importKind === 'type' ||
      node.importKind === 'typeof'
    ) {
      return false;
    }
    return (node.specifiers ?? []).some(
      (specifier) =>
        specifier.importKind !== 'type' && specifier.importKind !== 'typeof',
    );
  });
}

function activationFact(
  ast: $FlowFixMe,
  file: string,
  hasSyntax: boolean,
  projectActivation: ProjectActivation,
): Fact | null {
  const localPragma = usesEmotion(ast);
  const valueImport = hasEmotionValueImport(ast);
  if (!hasSyntax && !localPragma && !valueImport) {
    return null;
  }
  if (localPragma) {
    return createFact({
      kind: 'emotion-jsx-activation',
      status: 'known',
      value: { source: 'local-pragma' },
      provenance: [
        { kind: 'source', file, detail: 'exact Emotion JSX pragma' },
      ],
      inputFiles: [file],
    });
  }
  if (projectActivation.status === 'known') {
    return createFact({
      kind: 'emotion-jsx-activation',
      status: 'known',
      value: {
        source: 'project-config',
        config: projectActivation.source,
      },
      provenance: projectActivation.provenance,
      inputFiles: [file, ...projectActivation.inputFiles],
    });
  }
  if (projectActivation.status === 'resolution-failed') {
    return createFact({
      kind: 'emotion-jsx-activation',
      status: 'resolution-failed',
      value: { source: null },
      provenance: projectActivation.provenance,
      inputFiles: [file, ...projectActivation.inputFiles],
    });
  }
  if (valueImport) {
    return createFact({
      kind: 'emotion-jsx-activation',
      status: 'inferred',
      value: { source: 'value-import' },
      provenance: [
        {
          kind: 'source',
          file,
          detail: 'runtime Emotion import does not prove JSX activation',
        },
        ...projectActivation.provenance,
      ],
      inputFiles: [file, ...projectActivation.inputFiles],
    });
  }
  if (!hasSyntax) {
    return null;
  }
  return createFact({
    kind: 'emotion-jsx-activation',
    status: 'unknown',
    value: null,
    provenance: [
      { kind: 'source', file, detail: 'no file-local activation evidence' },
      ...projectActivation.provenance,
    ],
    inputFiles: [file, ...projectActivation.inputFiles],
  });
}

function classificationFor(
  supported: boolean,
  refusalReason: string | null,
  activation: Fact,
  dependencyResolutionFailed: boolean,
): { +classification: Classification, +reasons: $ReadOnlyArray<string> } {
  if (dependencyResolutionFailed) {
    return {
      classification: 'owner-decision',
      reasons: Object.freeze([
        'one or more local dependencies could not be resolved',
      ]),
    };
  }
  if (activation.status !== 'known') {
    return {
      classification: 'owner-decision',
      reasons: Object.freeze([
        `Emotion JSX activation is ${activation.status}`,
      ]),
    };
  }
  if (supported) {
    return {
      classification: 'mechanical',
      reasons: Object.freeze(['flat literal css prop with known activation']),
    };
  }
  const repeatable =
    refusalReason != null && REPEATABLE_REFUSALS.has(refusalReason);
  return {
    classification: repeatable ? 'repeatable-contextual' : 'bespoke-contextual',
    reasons: Object.freeze([
      `mechanical capability refused ${refusalReason ?? 'unknown syntax'}`,
    ]),
  };
}

export function scanRepository({
  repositoryRoot,
  sourceGlobs = ['**/*.{js,jsx,ts,tsx}'],
  now = () => new Date().toISOString(),
}: {
  +repositoryRoot: string,
  +sourceGlobs?: $ReadOnlyArray<string>,
  +now?: () => string,
}): Inventory {
  if (sourceGlobs.length === 0) {
    throw new Error('Inventory requires at least one source glob');
  }
  const root = canonicalRoot(repositoryRoot);
  const files: Array<InventoryFile> = [];
  const sites: Array<Site> = [];
  const facts: Array<Fact> = [];
  const diagnostics: Array<InventoryDiagnostic> = [];
  const projectActivation = analyzeProjectActivation(root);

  for (const file of sourceFiles(root, sourceGlobs)) {
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(root, file));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const fact = createFact({
        kind: 'file-read',
        status: 'resolution-failed',
        value: { detail },
        provenance: [{ kind: 'filesystem', file, detail }],
        inputFiles: [file],
      });
      facts.push(fact);
      diagnostics.push({ file, kind: 'read', detail, factId: fact.id });
      files.push({
        path: file,
        sourceHash: null,
        status: 'read-failed',
        siteIds: Object.freeze([]),
        factIds: Object.freeze([fact.id]),
        dependencies: Object.freeze([]),
      });
      continue;
    }
    const sourceHash = hashBytes(bytes);
    const source = bytes.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(bytes)) {
      const detail = 'file is not valid UTF-8';
      const fact = createFact({
        kind: 'file-read',
        status: 'resolution-failed',
        value: { detail },
        provenance: [{ kind: 'filesystem', file, detail }],
        inputFiles: [file],
      });
      facts.push(fact);
      diagnostics.push({ file, kind: 'read', detail, factId: fact.id });
      files.push({
        path: file,
        sourceHash,
        status: 'read-failed',
        siteIds: Object.freeze([]),
        factIds: Object.freeze([fact.id]),
        dependencies: Object.freeze([]),
      });
      continue;
    }
    const parsed = parseSource(source, file);
    if (!parsed.ok) {
      const fact = createFact({
        kind: 'file-parse',
        status: 'resolution-failed',
        value: { detail: parsed.reason },
        provenance: [{ kind: 'parser', file, detail: parsed.reason }],
        inputFiles: [file],
      });
      facts.push(fact);
      diagnostics.push({
        file,
        kind: 'parse',
        detail: parsed.reason,
        factId: fact.id,
      });
      files.push({
        path: file,
        sourceHash,
        status: 'parse-failed',
        siteIds: Object.freeze([]),
        factIds: Object.freeze([fact.id]),
        dependencies: Object.freeze([]),
      });
      continue;
    }

    const syntax = discoverSyntax(parsed.ast);
    const themeFacts = discoverThemeFacts({ ast: parsed.ast, file });
    const styledReadinessFacts = discoverStyledReadinessFacts({
      ast: parsed.ast,
      file,
    });
    const styledUsageFacts = discoverStyledUsageFacts({
      ast: parsed.ast,
      file,
      readinessFacts: styledReadinessFacts,
    });
    const styledTemplateFacts = discoverStyledTemplateFacts({
      ast: parsed.ast,
      file,
      readinessFacts: styledReadinessFacts,
      usageFacts: styledUsageFacts,
    });
    facts.push(
      ...themeFacts,
      ...styledReadinessFacts,
      ...styledUsageFacts,
      ...styledTemplateFacts,
    );
    const dependencyAnalysis = analyzeLocalDependencies({
      ast: parsed.ast,
      repositoryRoot: root,
      file,
    });
    facts.push(...dependencyAnalysis.facts);
    const dependencyResolutionFailed = dependencyAnalysis.dependencies.some(
      (dependency) => dependency.status === 'resolution-failed',
    );
    const activation = activationFact(
      parsed.ast,
      file,
      syntax.sites.length > 0 || syntax.refusals.length > 0,
      projectActivation,
    );
    const fileSiteIds = [];
    const dependencyFactIds = dependencyAnalysis.facts.map((fact) => fact.id);
    const fileFactIds = [
      ...(activation == null ? [] : [activation.id]),
      ...dependencyFactIds,
      ...themeFacts.map((fact) => fact.id),
      ...styledReadinessFacts.map((fact) => fact.id),
      ...styledUsageFacts.map((fact) => fact.id),
      ...styledTemplateFacts.map((fact) => fact.id),
    ];
    if (activation != null) {
      facts.push(activation);
      for (const raw of syntax.sites) {
        const span = { start: raw.start, end: raw.end };
        const route = classificationFor(
          true,
          null,
          activation,
          dependencyResolutionFailed,
        );
        const site = Object.freeze({
          id: siteIdentity({
            adapter: 'emotion',
            kind: 'css-prop',
            file,
            span,
            sourceHash,
          }),
          adapter: 'emotion',
          kind: 'css-prop',
          file,
          span: Object.freeze(span),
          sourceHash,
          syntax: 'supported',
          refusalReason: null,
          factIds: Object.freeze([
            activation.id,
            ...dependencyFactIds,
            ...themeFacts.map((fact) => fact.id),
          ]),
          classification: route.classification,
          routingReasons: route.reasons,
        });
        sites.push(site);
        fileSiteIds.push(site.id);
      }
      for (const raw of syntax.refusals) {
        const span = { start: raw.start, end: raw.end };
        const route = classificationFor(
          false,
          raw.reason,
          activation,
          dependencyResolutionFailed,
        );
        const site = Object.freeze({
          id: siteIdentity({
            adapter: 'emotion',
            kind: 'css-prop',
            file,
            span,
            sourceHash,
          }),
          adapter: 'emotion',
          kind: 'css-prop',
          file,
          span: Object.freeze(span),
          sourceHash,
          syntax: 'refused',
          refusalReason: raw.reason,
          factIds: Object.freeze([
            activation.id,
            ...dependencyFactIds,
            ...themeFacts.map((fact) => fact.id),
          ]),
          classification: route.classification,
          routingReasons: route.reasons,
        });
        sites.push(site);
        fileSiteIds.push(site.id);
      }
    }
    for (const providerFact of themeFacts.filter(
      (fact) => fact.kind === 'theme-provider',
    )) {
      const value: $FlowFixMe = providerFact.value;
      if (typeof value.start !== 'number' || typeof value.end !== 'number') {
        continue;
      }
      const span = { start: value.start, end: value.end };
      const classification: Classification = dependencyResolutionFailed
        ? 'owner-decision'
        : 'repeatable-contextual';
      const site: Site = Object.freeze({
        id: siteIdentity({
          adapter: 'emotion',
          kind: 'theme-provider',
          file,
          span,
          sourceHash,
        }),
        adapter: 'emotion',
        kind: 'theme-provider',
        file,
        span: Object.freeze(span),
        sourceHash,
        syntax: 'refused',
        refusalReason: 'theme-provider-decision-required',
        factIds: Object.freeze([
          ...dependencyFactIds,
          ...themeFacts.map((fact) => fact.id),
        ]),
        classification,
        routingReasons: Object.freeze([
          dependencyResolutionFailed
            ? 'one or more local dependencies could not be resolved'
            : 'ThemeProvider requires an approved token map',
        ]),
      });
      sites.push(site);
      fileSiteIds.push(site.id);
    }
    files.push({
      path: file,
      sourceHash,
      status: 'scanned',
      siteIds: Object.freeze(fileSiteIds.sort()),
      factIds: Object.freeze(fileFactIds),
      dependencies: dependencyAnalysis.dependencies,
    });
  }

  const stable = {
    repositoryRoot: root,
    sourceGlobs: Object.freeze([...sourceGlobs]),
    files: Object.freeze(files.sort((a, b) => a.path.localeCompare(b.path))),
    sites: Object.freeze(
      sites.sort((a, b) =>
        a.file === b.file
          ? a.span.start - b.span.start
          : a.file.localeCompare(b.file),
      ),
    ),
    facts: Object.freeze(facts.sort((a, b) => a.id.localeCompare(b.id))),
    diagnostics: Object.freeze(
      diagnostics.sort((a, b) => a.file.localeCompare(b.file)),
    ),
    configInputs: projectActivation.inputFiles,
  };
  return Object.freeze({
    id: inventoryIdentity(stable),
    ...stable,
    scannedAt: now(),
  });
}

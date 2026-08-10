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
import { parseSource } from '../static/parse';
import { createFact, inventoryIdentity, siteIdentity } from './model';
import type {
  Classification,
  Fact,
  Inventory,
  InventoryDiagnostic,
  InventoryFile,
  Site,
} from './model';

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
): Fact | null {
  if (usesEmotion(ast)) {
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
  if (hasEmotionValueImport(ast)) {
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
      ],
      inputFiles: [file],
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
    ],
    inputFiles: [file],
  });
}

function classificationFor(
  supported: boolean,
  refusalReason: string | null,
  activation: Fact,
): { +classification: Classification, +reasons: $ReadOnlyArray<string> } {
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
      });
      continue;
    }

    const syntax = discoverSyntax(parsed.ast);
    const activation = activationFact(
      parsed.ast,
      file,
      syntax.sites.length > 0 || syntax.refusals.length > 0,
    );
    const fileSiteIds = [];
    const fileFactIds = activation == null ? [] : [activation.id];
    if (activation != null) {
      facts.push(activation);
      for (const raw of syntax.sites) {
        const span = { start: raw.start, end: raw.end };
        const route = classificationFor(true, null, activation);
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
          factIds: Object.freeze([activation.id]),
          classification: route.classification,
          routingReasons: route.reasons,
        });
        sites.push(site);
        fileSiteIds.push(site.id);
      }
      for (const raw of syntax.refusals) {
        const span = { start: raw.start, end: raw.end };
        const route = classificationFor(false, raw.reason, activation);
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
          factIds: Object.freeze([activation.id]),
          classification: route.classification,
          routingReasons: route.reasons,
        });
        sites.push(site);
        fileSiteIds.push(site.id);
      }
    }
    files.push({
      path: file,
      sourceHash,
      status: 'scanned',
      siteIds: Object.freeze(fileSiteIds.sort()),
      factIds: Object.freeze(fileFactIds),
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
    configInputs: Object.freeze([]),
  };
  return Object.freeze({
    id: inventoryIdentity(stable),
    ...stable,
    scannedAt: now(),
  });
}

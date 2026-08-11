/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { evidence } from '../evidence/claims';
import { gitBuffer } from '../kernel/snapshot';
import { parseSource } from '../static/parse';
import { walk } from '../static/walk';
import type { CandidatePatch } from '../candidate/patch';
import type { EvidenceResult } from '../kernel/evidence';
import type { Fact, Inventory } from '../inventory/model';
import type { DynamicStrategyDraft, DynamicStrategyKind } from './model';

export const DYNAMIC_STRATEGY_WIRING_MODEL: string =
  'dynamic-strategy-wiring-v1';

export const DYNAMIC_STRATEGY_WIRING_LIMITATION: string =
  'This is a frozen-byte syntax check. It checks local definition and consumer replacement, StyleX props wiring, merge surfaces, and obvious prop forwarding. It does not establish runtime value domains, expression equivalence, evaluation timing or count, getter purity, CSS serialization, cascade behavior, or rendered equivalence.';

const MERGE_ATTRIBUTES: $ReadOnlyArray<'className' | 'style'> = Object.freeze([
  'className',
  'style',
]);

type CandidateSource = {
  +file: string,
  +source: string,
  +target: string | null,
  +sourceHash: string | null,
  +targetHash: string | null,
};

export type DynamicStrategyGuardResult = {
  +complete: boolean,
  +violations: $ReadOnlyArray<string>,
  +evidence: $ReadOnlyArray<EvidenceResult>,
};

type SourceShape = {
  +ast: $FlowFixMe,
  +bindingNames: $ReadOnlySet<string>,
  +jsxNames: { +[name: string]: number },
  +intrinsicAttributes: { +[name: string]: number },
  +intrinsicUnknownSpreads: number,
  +stylexPropsSpreads: number,
};

function count(record: { [name: string]: number }, name: string): void {
  record[name] = (record[name] ?? 0) + 1;
}

function runtimeStylexBindings(ast: $FlowFixMe): {
  +namespace: $ReadOnlySet<string>,
  +props: $ReadOnlySet<string>,
} {
  const namespace = new Set<string>();
  const props = new Set<string>();
  walk(ast, (node) => {
    if (
      node.type !== 'ImportDeclaration' ||
      node.source?.value !== '@stylexjs/stylex' ||
      node.importKind === 'type' ||
      node.importKind === 'typeof'
    ) {
      return;
    }
    for (const specifier of node.specifiers ?? []) {
      if (
        specifier.importKind === 'type' ||
        specifier.importKind === 'typeof'
      ) {
        continue;
      }
      if (
        (specifier.type === 'ImportNamespaceSpecifier' ||
          specifier.type === 'ImportDefaultSpecifier') &&
        specifier.local?.type === 'Identifier'
      ) {
        namespace.add(String(specifier.local.name));
      } else if (
        specifier.type === 'ImportSpecifier' &&
        String(specifier.imported?.name ?? specifier.imported?.value) ===
          'props' &&
        specifier.local?.type === 'Identifier'
      ) {
        props.add(String(specifier.local.name));
      }
    }
  });
  return Object.freeze({ namespace, props });
}

function isStylexPropsCall(
  node: $FlowFixMe,
  bindings: {
    +namespace: $ReadOnlySet<string>,
    +props: $ReadOnlySet<string>,
  },
): boolean {
  if (node?.type !== 'CallExpression') return false;
  if (
    node.callee?.type === 'Identifier' &&
    bindings.props.has(String(node.callee.name))
  ) {
    return true;
  }
  return (
    (node.callee?.type === 'MemberExpression' ||
      node.callee?.type === 'OptionalMemberExpression') &&
    node.callee.computed !== true &&
    node.callee.object?.type === 'Identifier' &&
    bindings.namespace.has(String(node.callee.object.name)) &&
    node.callee.property?.type === 'Identifier' &&
    node.callee.property.name === 'props'
  );
}

function sourceShape(source: string, file: string): SourceShape | string {
  const parsed = parseSource(source, file);
  if (!parsed.ok) return parsed.reason;
  const bindings = runtimeStylexBindings(parsed.ast);
  const bindingNames = new Set<string>();
  const jsxNames: { [name: string]: number } = {};
  const intrinsicAttributes: { [name: string]: number } = {};
  let intrinsicUnknownSpreads = 0;
  let stylexPropsSpreads = 0;
  walk(parsed.ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
      bindingNames.add(String(node.id.name));
    }
    if (
      (node.type === 'FunctionDeclaration' ||
        node.type === 'ClassDeclaration') &&
      node.id?.type === 'Identifier'
    ) {
      bindingNames.add(String(node.id.name));
    }
    if (
      node.type !== 'JSXOpeningElement' ||
      node.name?.type !== 'JSXIdentifier'
    ) {
      return;
    }
    const name = String(node.name.name);
    count(jsxNames, name);
    if (!/^[a-z]/.test(name)) return;
    for (const attribute of node.attributes ?? []) {
      if (attribute.type === 'JSXSpreadAttribute') {
        if (isStylexPropsCall(attribute.argument, bindings)) {
          stylexPropsSpreads++;
        } else {
          intrinsicUnknownSpreads++;
        }
      } else if (attribute.name?.type === 'JSXIdentifier') {
        count(intrinsicAttributes, String(attribute.name.name));
      }
    }
  });
  return Object.freeze({
    ast: parsed.ast,
    bindingNames,
    jsxNames: Object.freeze(jsxNames),
    intrinsicAttributes: Object.freeze(intrinsicAttributes),
    intrinsicUnknownSpreads,
    stylexPropsSpreads,
  });
}

function byDefinition(
  strategy: DynamicStrategyDraft,
): Map<string, Array<DynamicStrategyKind>> {
  const output = new Map<string, Array<DynamicStrategyKind>>();
  for (const entry of strategy.entries) {
    const values = output.get(entry.definitionFactId) ?? [];
    values.push(entry.strategy);
    output.set(entry.definitionFactId, values);
  }
  return output;
}

function factById(inventory: Inventory, id: string): Fact | null {
  return inventory.facts.find((fact) => fact.id === id) ?? null;
}

function operationCount(callback: $FlowFixMe): number {
  return (
    Number(callback.calls ?? 0) +
    Number(callback.constructions ?? 0) +
    Number(callback.assignments ?? 0) +
    Number(callback.updates ?? 0) +
    Number(callback.awaits ?? 0) +
    Number(callback.yields ?? 0) +
    Number(callback.nestedFunctions ?? 0) +
    Number(callback.computedAccesses ?? 0)
  );
}

function inspectSources({
  inventory,
  strategy,
  sources,
  scope,
}: {
  +inventory: Inventory,
  +strategy: DynamicStrategyDraft,
  +sources: $ReadOnlyArray<CandidateSource>,
  +scope: $ReadOnlyArray<string>,
}): DynamicStrategyGuardResult {
  const violations = [];
  const evidenceResults = [];
  const sourcesByFile = new Map(sources.map((source) => [source.file, source]));
  const strategies = byDefinition(strategy);
  const inspectedByFile = new Map<string, Array<string>>();
  const requiredByFile = new Map<
    string,
    { stylexProps: number, className: number, style: number },
  >();

  for (const [definitionFactId, kinds] of strategies) {
    const readinessFact = factById(inventory, definitionFactId);
    if (readinessFact?.kind !== 'emotion-styled-readiness') {
      violations.push(`Missing styled definition fact ${definitionFactId}.`);
      continue;
    }
    const readiness: $FlowFixMe = readinessFact.value;
    const dynamicFact = inventory.facts.find((fact) => {
      const value: $FlowFixMe = fact.value;
      return (
        fact.kind === 'emotion-styled-dynamic-value' &&
        value.definitionFactId === definitionFactId
      );
    });
    if (dynamicFact == null) {
      violations.push(`Missing dynamic value fact for ${definitionFactId}.`);
      continue;
    }
    const dynamic: $FlowFixMe = dynamicFact.value;
    const usageFact =
      typeof dynamic.usageFactId === 'string'
        ? factById(inventory, dynamic.usageFactId)
        : null;
    if (usageFact?.kind !== 'emotion-styled-usage') {
      violations.push(
        `Missing styled usage fact for ${String(readiness.name)}.`,
      );
      continue;
    }
    const usage: $FlowFixMe = usageFact.value;
    const file = String(readinessFact.inputFiles[0] ?? '');
    const candidateSource = sourcesByFile.get(file);
    if (candidateSource == null || candidateSource.target == null) {
      violations.push(
        `${file}: dynamic strategy did not produce a source file.`,
      );
      continue;
    }
    const targetText = candidateSource.target;
    const source = sourceShape(candidateSource.source, file);
    const target = sourceShape(targetText, file);
    if (typeof source === 'string') {
      violations.push(`${file}: ${source}.`);
      continue;
    }
    if (typeof target === 'string') {
      violations.push(`${file}: ${target}.`);
      continue;
    }
    const name = String(readiness.name);
    const retain = kinds.every((kind) => kind === 'retain-emotion');
    if (retain) {
      const start = Number(readiness.span?.start);
      const end = Number(readiness.span?.end);
      const initializer = candidateSource.source.slice(start, end);
      if (
        initializer === '' ||
        !targetText.includes(initializer) ||
        (target.jsxNames[name] ?? 0) < (source.jsxNames[name] ?? 0)
      ) {
        violations.push(
          `${file}: retained Emotion definition ${name} or its consumers changed.`,
        );
      }
    } else {
      if (target.bindingNames.has(name) || (target.jsxNames[name] ?? 0) > 0) {
        violations.push(
          `${file}: converted definition ${name} or an old JSX consumer remains.`,
        );
      }
      const consumers = usage.consumers ?? [];
      const required = requiredByFile.get(file) ?? {
        stylexProps: 0,
        className: 0,
        style: 0,
      };
      required.stylexProps += consumers.length;
      required.className += consumers.filter((consumer) =>
        (consumer.attributes ?? []).includes('className'),
      ).length;
      required.style += consumers.filter((consumer) =>
        (consumer.attributes ?? []).includes('style'),
      ).length;
      requiredByFile.set(file, required);
      const propRoots = new Set(
        strategy.entries
          .filter((entry) => entry.definitionFactId === definitionFactId)
          .map((entry) => entry.propPath.split('.')[0]),
      );
      for (const prop of propRoots) {
        if (
          (target.intrinsicAttributes[prop] ?? 0) >
          (source.intrinsicAttributes[prop] ?? 0)
        ) {
          violations.push(
            `${file}: styling prop ${prop} is newly forwarded to an intrinsic element.`,
          );
        }
      }
      if (target.intrinsicUnknownSpreads > source.intrinsicUnknownSpreads) {
        violations.push(
          `${file}: the rewrite adds an uninspected intrinsic JSX spread that may leak styling props.`,
        );
      }
      for (const entry of strategy.entries.filter(
        (item) => item.definitionFactId === definitionFactId,
      )) {
        if (
          entry.strategy !== 'stylex-variants' &&
          entry.strategy !== 'css-variable'
        ) {
          continue;
        }
        const callbacks = (dynamic.callbacks ?? []).filter((callback) =>
          (callback.propPaths ?? []).includes(entry.propPath),
        );
        if (callbacks.some((callback) => operationCount(callback) > 0)) {
          violations.push(
            `${file}: ${entry.strategy} for ${name}.${entry.propPath} is too narrow for a callback containing calls, construction, mutation, nested functions, await/yield, or computed access.`,
          );
        }
      }
    }
    const inspected = inspectedByFile.get(file) ?? [];
    inspected.push(`${name} (${[...new Set(kinds)].sort().join(', ')})`);
    inspectedByFile.set(file, inspected);
  }

  for (const [file, required] of requiredByFile) {
    const candidateSource = sourcesByFile.get(file);
    if (candidateSource?.target == null) continue;
    const target = sourceShape(candidateSource.target, file);
    if (typeof target === 'string') continue;
    if (target.stylexPropsSpreads < required.stylexProps) {
      violations.push(
        `${file}: converted definitions require StyleX props wiring for ${String(required.stylexProps)} consumer(s), but ${String(target.stylexPropsSpreads)} was found.`,
      );
    }
    for (const merge of MERGE_ATTRIBUTES) {
      const requiredCount = required[merge];
      if ((target.intrinsicAttributes[merge] ?? 0) < requiredCount) {
        violations.push(
          `${file}: the rewrite lost the observable ${merge} merge surface for ${String(requiredCount)} consumer(s).`,
        );
      }
    }
  }

  if (violations.length === 0) {
    for (const [file, definitions] of inspectedByFile) {
      const source = sourcesByFile.get(file);
      if (source == null) continue;
      evidenceResults.push(
        evidence({
          check: 'dynamic-strategy-wiring',
          provider: 'stylex-migrate',
          subject: {
            file,
            sourceHash: source.sourceHash,
            targetHash: source.targetHash,
            model: DYNAMIC_STRATEGY_WIRING_MODEL,
          },
          scope,
          result: 'pass',
          detail: `Frozen wiring checks passed for ${definitions.sort().join('; ')}.`,
          limitations: [DYNAMIC_STRATEGY_WIRING_LIMITATION],
        }),
      );
    }
  }
  return Object.freeze({
    complete: violations.length === 0,
    violations: Object.freeze(violations),
    evidence: Object.freeze(evidenceResults),
  });
}

export function inspectDynamicStrategyCandidate({
  candidate,
  inventory,
  strategy,
  sourceHashes,
  scope,
}: {
  +candidate: CandidatePatch,
  +inventory: Inventory,
  +strategy: DynamicStrategyDraft,
  +sourceHashes: { +[path: string]: string | null },
  +scope: $ReadOnlyArray<string>,
}): DynamicStrategyGuardResult {
  const changeByFile = new Map(
    candidate.changes.map((change) => [change.path, change]),
  );
  const files = [
    ...new Set(
      strategy.entries.flatMap((entry) => {
        const fact = factById(inventory, entry.definitionFactId);
        return fact?.inputFiles ?? [];
      }),
    ),
  ];
  const sources = files.map((file) => {
    const change = changeByFile.get(file);
    return Object.freeze({
      file,
      source: gitBuffer(candidate.repositoryRoot, [
        'show',
        `${candidate.baseCommit}:${file}`,
      ]).toString('utf8'),
      target: change == null ? null : change.content,
      sourceHash: sourceHashes[file] ?? null,
      targetHash: change?.contentHash ?? null,
    });
  });
  return inspectSources({ inventory, strategy, sources, scope });
}

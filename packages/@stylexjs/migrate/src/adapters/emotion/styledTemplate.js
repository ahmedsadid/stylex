/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import postcss from 'postcss';
import { createFact } from '../../inventory/model';
import { walk } from '../../static/walk';
import type { Fact } from '../../inventory/model';

export const STYLED_TEMPLATE_GRAMMAR_MODEL: string =
  'emotion-styled-flat-template-v1';

type Declaration = {
  +property: string,
  +authoredProperty: string,
  +value: string,
};

type Analysis =
  | { +supported: true, +declarations: $ReadOnlyArray<Declaration> }
  | { +supported: false, +reason: string };

function propertyName(authored: string): string | null {
  if (authored.startsWith('--') || !/^-?[a-z][a-z0-9-]*$/.test(authored)) {
    return null;
  }
  let value = authored;
  let prefix = '';
  if (value.startsWith('-webkit-')) {
    prefix = 'Webkit';
    value = value.slice('-webkit-'.length);
  } else if (value.startsWith('-moz-')) {
    prefix = 'Moz';
    value = value.slice('-moz-'.length);
  } else if (value.startsWith('-ms-')) {
    prefix = 'ms';
    value = value.slice('-ms-'.length);
  } else if (value.startsWith('-o-')) {
    prefix = 'O';
    value = value.slice('-o-'.length);
  } else if (value.startsWith('-')) {
    return null;
  }
  const camel = value.replace(/-([a-z0-9])/g, (_match, part) =>
    String(part).toUpperCase(),
  );
  if (camel === '') return null;
  return prefix === ''
    ? camel
    : `${prefix}${camel[0].toUpperCase()}${camel.slice(1)}`;
}

export function analyzeClosedStyledTemplate(css: string): Analysis {
  let root;
  try {
    root = postcss.parse(`.__stylex_migrate__ {${css}}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { supported: false, reason: `css-parse-failed: ${message}` };
  }
  const roots = (root.nodes ?? []).filter((node) => node.type !== 'comment');
  if (
    roots.length !== 1 ||
    roots[0].type !== 'rule' ||
    roots[0].selector !== '.__stylex_migrate__'
  ) {
    return { supported: false, reason: 'template-escapes-flat-rule' };
  }
  const declarations = [];
  const seen = new Set<string>();
  for (const node of roots[0].nodes ?? []) {
    if (node.type === 'comment') continue;
    if (node.type !== 'decl') {
      return {
        supported: false,
        reason:
          node.type === 'atrule'
            ? 'at-rule-in-template'
            : 'nested-rule-in-template',
      };
    }
    if (
      !/^\s*$/.test(String(node.raws?.before ?? '')) ||
      !/^\s*:\s*$/.test(String(node.raws?.between ?? ':'))
    ) {
      return { supported: false, reason: 'legacy-declaration-hack' };
    }
    const authoredProperty = String(node.prop);
    const property = propertyName(authoredProperty);
    if (property == null) {
      return { supported: false, reason: 'unsupported-property-name' };
    }
    if (node.important === true) {
      return { supported: false, reason: 'important-declaration' };
    }
    if (seen.has(property)) {
      return { supported: false, reason: 'duplicate-property-fallback' };
    }
    const value = String(node.value).trim();
    if (value === '') {
      return { supported: false, reason: 'empty-declaration-value' };
    }
    if (/\\[0-9]/.test(value)) {
      return { supported: false, reason: 'legacy-value-hack' };
    }
    seen.add(property);
    declarations.push(Object.freeze({ property, authoredProperty, value }));
  }
  if (declarations.length === 0) {
    return { supported: false, reason: 'empty-template' };
  }
  return { supported: true, declarations: Object.freeze(declarations) };
}

function templateTextByStart(ast: $FlowFixMe): Map<number, string | null> {
  const result = new Map<number, string | null>();
  walk(ast, (node) => {
    if (
      node.type !== 'TaggedTemplateExpression' ||
      typeof node.start !== 'number' ||
      (node.quasi?.expressions ?? []).length !== 0 ||
      (node.quasi?.quasis ?? []).length !== 1
    ) {
      return;
    }
    const cooked = node.quasi.quasis[0].value?.cooked;
    result.set(node.start, typeof cooked === 'string' ? cooked : null);
  });
  return result;
}

export function readClosedStyledTemplate(
  ast: $FlowFixMe,
  start: number,
): string | null {
  return templateTextByStart(ast).get(start) ?? null;
}

/** Parse only usage-closed intrinsic templates; this fact still edits nothing. */
export function discoverStyledTemplateFacts({
  ast,
  file,
  readinessFacts,
  usageFacts,
}: {
  +ast: $FlowFixMe,
  +file: string,
  +readinessFacts: $ReadOnlyArray<Fact>,
  +usageFacts: $ReadOnlyArray<Fact>,
}): $ReadOnlyArray<Fact> {
  const readinessById = new Map(readinessFacts.map((fact) => [fact.id, fact]));
  const templates = templateTextByStart(ast);
  const output = [];
  for (const usageFact of usageFacts) {
    const usage: $FlowFixMe = usageFact.value;
    if (usage.firstSliceEligible !== true) continue;
    const readinessFact = readinessById.get(String(usage.definitionFactId));
    if (readinessFact == null) continue;
    const readiness: $FlowFixMe = readinessFact.value;
    const start = Number(readiness.span?.start);
    const css = templates.get(start);
    const analysis: Analysis =
      typeof css === 'string'
        ? analyzeClosedStyledTemplate(css)
        : { supported: false, reason: 'template-cooked-value-unavailable' };
    let reason = null;
    let declarations: $ReadOnlyArray<Declaration> = Object.freeze([]);
    if (analysis.supported) declarations = analysis.declarations;
    else reason = analysis.reason;
    output.push(
      createFact({
        kind: 'emotion-styled-template-grammar',
        status: 'known',
        value: {
          model: STYLED_TEMPLATE_GRAMMAR_MODEL,
          definitionFactId: readinessFact.id,
          usageFactId: usageFact.id,
          name: String(usage.name),
          supported: analysis.supported,
          reason,
          declarations,
        },
        provenance: [
          {
            kind: 'source',
            file,
            detail: `closed styled template grammar for ${String(usage.name)}`,
          },
        ],
        inputFiles: [file],
      }),
    );
  }
  return Object.freeze(
    output.sort((left, right) => left.id.localeCompare(right.id)),
  );
}

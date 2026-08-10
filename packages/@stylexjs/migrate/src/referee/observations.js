/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import postcss from 'postcss';
import { serializeStyles } from '@emotion/serialize';
import { canonicalProperty, canonicalValue } from '../compare/model';
import { compileStyleX } from '../evidence/compile';
import type { CompiledStyleXRule } from '../evidence/compile';
import type { RefereeDeclaration, Specificity } from './model';

export type CascadeObservation =
  | {
      +ok: true,
      +css: string,
      +classNames: $ReadOnlyArray<string>,
      +declarations: $ReadOnlyArray<RefereeDeclaration>,
    }
  | { +ok: false, +reason: string };

type SelectorFacts = {
  +conditions: $ReadOnlyArray<string>,
  +pseudoElement: string | null,
  +specificity: Specificity,
};

function selectorFacts(
  selector: string,
  className?: string,
): SelectorFacts | null {
  const prefix = className == null ? '' : `.${className}`;
  if (selector === prefix || (prefix === '' && selector === 'default')) {
    return { conditions: [], pseudoElement: null, specificity: [0, 1, 0] };
  }
  for (const condition of [':hover', ':focus']) {
    if (
      selector === `${prefix}${condition}` ||
      (prefix === '' && selector === condition)
    ) {
      return {
        conditions: [condition],
        pseudoElement: null,
        specificity: [0, 2, 0],
      };
    }
  }
  const pseudoElement = /^::[a-z-]+$/.test(selector)
    ? selector
    : className != null && selector.startsWith(`.${className}::`)
      ? selector.slice(className.length + 1)
      : null;
  return pseudoElement == null
    ? null
    : { conditions: [], pseudoElement, specificity: [0, 1, 1] };
}

function declarationFacts({
  node,
  selector,
  id,
  sourceOrder,
  stylexPriority,
  className,
  factsOverride,
}: {
  +node: $FlowFixMe,
  +selector: string,
  +id: string,
  +sourceOrder: number,
  +stylexPriority: number | null,
  +className?: string,
  +factsOverride?: SelectorFacts,
}): RefereeDeclaration | null {
  const facts = factsOverride ?? selectorFacts(selector, className);
  if (facts == null) {
    return null;
  }
  return Object.freeze({
    id,
    property: canonicalProperty(String(node.prop)),
    value: canonicalValue(String(node.value)),
    important: node.important === true,
    pseudoElement: facts.pseudoElement,
    specificity: facts.specificity,
    conditions: facts.conditions,
    sourceOrder,
    stylexPriority,
  });
}

/** Observe CSS emitted by Emotion from an already-materialized style value. */
export function observeEmotionSerialization(style: mixed): CascadeObservation {
  let css;
  try {
    css = String(serializeStyles([style]).styles);
  } catch (error) {
    return {
      ok: false,
      reason: `Emotion serialization failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let root;
  try {
    root = postcss.parse(css);
  } catch (error) {
    return {
      ok: false,
      reason: `Emotion CSS could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const declarations = [];
  let sourceOrder = 0;
  for (const node of root.nodes ?? []) {
    if (node.type === 'decl') {
      const declaration = declarationFacts({
        node,
        selector: 'default',
        id: `emotion-${sourceOrder}`,
        sourceOrder,
        stylexPriority: null,
      });
      if (declaration != null) declarations.push(declaration);
      sourceOrder++;
      continue;
    }
    if (node.type !== 'rule') {
      if (
        node.type !== 'atrule' ||
        String(node.name) !== 'media' ||
        String(node.params) === ''
      ) {
        return {
          ok: false,
          reason: `Emotion emitted unsupported ${String(node.type)} node`,
        };
      }
      const condition = `@media ${String(node.params)}`;
      for (const child of node.nodes ?? []) {
        if (child.type !== 'decl') {
          return {
            ok: false,
            reason: `Emotion emitted nested ${String(child.type)} media node`,
          };
        }
        const declaration = declarationFacts({
          node: child,
          selector: 'default',
          id: `emotion-${sourceOrder}`,
          sourceOrder,
          stylexPriority: null,
          factsOverride: {
            conditions: [condition],
            pseudoElement: null,
            specificity: [0, 1, 0],
          },
        });
        if (declaration != null) declarations.push(declaration);
        sourceOrder++;
      }
      continue;
    }
    const selector = String(node.selector);
    if (selectorFacts(selector) == null) {
      return {
        ok: false,
        reason: `Emotion emitted unsupported selector ${selector}`,
      };
    }
    for (const child of node.nodes ?? []) {
      if (child.type !== 'decl') {
        return {
          ok: false,
          reason: `Emotion emitted nested ${String(child.type)} node`,
        };
      }
      const declaration = declarationFacts({
        node: child,
        selector,
        id: `emotion-${sourceOrder}`,
        sourceOrder,
        stylexPriority: null,
      });
      if (declaration == null) {
        return {
          ok: false,
          reason: `Emotion emitted unsupported selector ${selector}`,
        };
      }
      declarations.push(declaration);
      sourceOrder++;
    }
  }
  return Object.freeze({
    ok: true,
    css,
    classNames: Object.freeze([]),
    declarations: Object.freeze(declarations),
  });
}

export function observeStyleXRules(
  rules: $ReadOnlyArray<CompiledStyleXRule>,
): CascadeObservation {
  const declarations = [];
  let sourceOrder = 0;
  for (const rule of rules) {
    let root;
    try {
      root = postcss.parse(rule.ltr);
    } catch (error) {
      return {
        ok: false,
        reason: `StyleX rule could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const nodes = root.nodes ?? [];
    if (nodes.length !== 1) {
      return {
        ok: false,
        reason: 'StyleX emitted an unsupported conditional rule',
      };
    }
    let ruleNode = nodes[0];
    let factsOverride;
    if (ruleNode.type === 'atrule') {
      if (
        String(ruleNode.name) !== 'media' ||
        String(ruleNode.params) === '' ||
        (ruleNode.nodes ?? []).length !== 1 ||
        ruleNode.nodes[0].type !== 'rule'
      ) {
        return {
          ok: false,
          reason: 'StyleX emitted an unsupported at-rule shape',
        };
      }
      const condition = `@media ${String(ruleNode.params)}`;
      ruleNode = ruleNode.nodes[0];
      const expectedSelector = `.${rule.className}.${rule.className}`;
      if (String(ruleNode.selector) !== expectedSelector) {
        return {
          ok: false,
          reason: `StyleX emitted unsupported media selector ${String(ruleNode.selector)}`,
        };
      }
      factsOverride = {
        conditions: [condition],
        pseudoElement: null,
        specificity: [0, 2, 0],
      };
    }
    if (ruleNode.type !== 'rule') {
      return {
        ok: false,
        reason: 'StyleX emitted an unsupported conditional rule',
      };
    }
    const selector = String(ruleNode.selector);
    if (
      factsOverride == null &&
      selectorFacts(selector, rule.className) == null
    ) {
      return {
        ok: false,
        reason: `StyleX emitted unsupported selector ${selector}`,
      };
    }
    for (const node of ruleNode.nodes ?? []) {
      if (node.type !== 'decl') {
        return {
          ok: false,
          reason: `StyleX emitted nested ${String(node.type)} node`,
        };
      }
      const declaration = declarationFacts({
        node,
        selector,
        className: rule.className,
        id: `stylex-${rule.className}-${sourceOrder}`,
        sourceOrder,
        stylexPriority: rule.priority,
        factsOverride,
      });
      if (declaration == null) {
        return {
          ok: false,
          reason: `StyleX emitted unsupported selector ${selector}`,
        };
      }
      declarations.push(declaration);
      sourceOrder++;
    }
  }
  return Object.freeze({
    ok: true,
    css: rules.map((rule) => rule.ltr).join('\n'),
    classNames: Object.freeze(rules.map((rule) => rule.className)),
    declarations: Object.freeze(declarations),
  });
}

/** Observe StyleX selector and priority facts from the actual compiler. */
export function observeStyleXCompilation(
  source: string,
  filename: string,
): CascadeObservation {
  const compiled = compileStyleX(source, filename);
  return compiled.ok ? observeStyleXRules(compiled.ruleMetadata) : compiled;
}

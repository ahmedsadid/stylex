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
import type { CompiledStyleXRule } from '../evidence/compile';

export const DIRECTIONAL_REFEREE_MODEL: string = 'directional-referee-v1';

export type DirectionalState = {
  +id: string,
  +direction: 'ltr' | 'rtl',
  +writingMode: 'horizontal-tb' | 'vertical-rl' | 'vertical-lr',
};

export type DirectionalDeclaration = {
  +id: string,
  +property: string,
  +value: string,
  +important: boolean,
  +sourceOrder: number,
  +stylexPriority: number | null,
};

export type DirectionalObservation =
  | { +ok: true, +declarations: $ReadOnlyArray<DirectionalDeclaration> }
  | { +ok: false, +reason: string };

export type DirectionalDifference = {
  +stateId: string,
  +property: string,
  +sourceValue: string | null,
  +targetValue: string | null,
};

export type DirectionalRefereeResult =
  | { +status: 'unsupported', +model: string, +reasons: $ReadOnlyArray<string> }
  | {
      +status: 'equivalent' | 'mismatch',
      +model: string,
      +states: $ReadOnlyArray<DirectionalState>,
      +differences: $ReadOnlyArray<DirectionalDifference>,
    };

export const DIRECTIONAL_STATES: $ReadOnlyArray<DirectionalState> =
  Object.freeze([
    { id: 'ltr+horizontal-tb', direction: 'ltr', writingMode: 'horizontal-tb' },
    { id: 'rtl+horizontal-tb', direction: 'rtl', writingMode: 'horizontal-tb' },
    { id: 'ltr+vertical-rl', direction: 'ltr', writingMode: 'vertical-rl' },
    { id: 'rtl+vertical-rl', direction: 'rtl', writingMode: 'vertical-rl' },
    { id: 'ltr+vertical-lr', direction: 'ltr', writingMode: 'vertical-lr' },
    { id: 'rtl+vertical-lr', direction: 'rtl', writingMode: 'vertical-lr' },
  ]);

const LOGICAL = /^(margin|padding)-(inline|block)-(start|end)$/;
const PHYSICAL = /^(margin|padding)-(top|right|bottom|left)$/;
const LOGICAL_SIZE = /^(inline|block)-size$/;
const PHYSICAL_SIZE = /^(width|height)$/;

function physicalProperty(property: string, state: DirectionalState): string {
  const match = property.match(LOGICAL);
  if (match == null) {
    if (property === 'inline-size') {
      return state.writingMode === 'horizontal-tb' ? 'width' : 'height';
    }
    if (property === 'block-size') {
      return state.writingMode === 'horizontal-tb' ? 'height' : 'width';
    }
    return property;
  }
  const [, family, axis, edge] = match;
  let start;
  let end;
  if (axis === 'inline') {
    if (state.writingMode === 'horizontal-tb') {
      [start, end] =
        state.direction === 'ltr' ? ['left', 'right'] : ['right', 'left'];
    } else {
      [start, end] =
        state.direction === 'ltr' ? ['top', 'bottom'] : ['bottom', 'top'];
    }
  } else if (state.writingMode === 'horizontal-tb') {
    [start, end] = ['top', 'bottom'];
  } else if (state.writingMode === 'vertical-rl') {
    [start, end] = ['right', 'left'];
  } else {
    [start, end] = ['left', 'right'];
  }
  return `${family}-${edge === 'start' ? start : end}`;
}

function declarationsFromNodes(
  nodes: $ReadOnlyArray<$FlowFixMe>,
  stylexPriority: number | null,
  prefix: string,
  startOrder: number,
): DirectionalDeclaration[] | null {
  const result: Array<DirectionalDeclaration> = [];
  for (const node of nodes) {
    if (node.type !== 'decl') return null;
    result.push({
      id: `${prefix}-${startOrder + result.length}`,
      property: canonicalProperty(String(node.prop)),
      value: canonicalValue(String(node.value)),
      important: node.important === true,
      sourceOrder: startOrder + result.length,
      stylexPriority,
    });
  }
  return result;
}

export function observeEmotionDirectional(
  style: mixed,
): DirectionalObservation {
  let css;
  try {
    css = String(serializeStyles([style]).styles);
  } catch (error) {
    return {
      ok: false,
      reason: `Emotion directional serialization failed: ${String(error)}`,
    };
  }
  let root;
  try {
    root = postcss.parse(css);
  } catch (error) {
    return {
      ok: false,
      reason: `Emotion directional CSS could not be parsed: ${String(error)}`,
    };
  }
  const declarations = declarationsFromNodes(
    root.nodes ?? [],
    null,
    'emotion',
    0,
  );
  return declarations == null
    ? { ok: false, reason: 'Emotion emitted unsupported directional CSS' }
    : { ok: true, declarations: Object.freeze(declarations) };
}

export function observeStyleXDirectionalRules(
  rules: $ReadOnlyArray<CompiledStyleXRule>,
): DirectionalObservation {
  const declarations: Array<DirectionalDeclaration> = [];
  for (const rule of rules) {
    let root;
    try {
      root = postcss.parse(rule.ltr);
    } catch (error) {
      return {
        ok: false,
        reason: `StyleX directional CSS could not be parsed: ${String(error)}`,
      };
    }
    const node = root.nodes?.[0];
    if (root.nodes?.length !== 1 || node?.type !== 'rule') {
      return {
        ok: false,
        reason: 'StyleX emitted unsupported directional rule',
      };
    }
    const observed = declarationsFromNodes(
      node.nodes ?? [],
      rule.priority,
      `stylex-${rule.className}`,
      declarations.length,
    );
    if (observed == null)
      return {
        ok: false,
        reason: 'StyleX emitted unsupported directional declarations',
      };
    declarations.push(...observed);
  }
  return { ok: true, declarations: Object.freeze(declarations) };
}

function winner(
  declarations: $ReadOnlyArray<DirectionalDeclaration>,
  property: string,
  state: DirectionalState,
  target: boolean,
): DirectionalDeclaration | null {
  let result = null;
  for (const declaration of declarations) {
    if (physicalProperty(declaration.property, state) !== property) continue;
    if (
      result == null ||
      (target &&
        (declaration.stylexPriority ?? 0) > (result.stylexPriority ?? 0)) ||
      ((!target || declaration.stylexPriority === result.stylexPriority) &&
        declaration.sourceOrder > result.sourceOrder)
    ) {
      result = declaration;
    }
  }
  return result;
}

export function refereeDirectional(
  source: $ReadOnlyArray<DirectionalDeclaration>,
  target: $ReadOnlyArray<DirectionalDeclaration>,
): DirectionalRefereeResult {
  const reasons = [];
  for (const declaration of [...source, ...target]) {
    if (
      !LOGICAL.test(declaration.property) &&
      !PHYSICAL.test(declaration.property) &&
      !LOGICAL_SIZE.test(declaration.property) &&
      !PHYSICAL_SIZE.test(declaration.property)
    ) {
      reasons.push(`unsupported directional property ${declaration.property}`);
    }
    if (declaration.important)
      reasons.push('!important is outside the directional grammar');
  }
  if (
    source.some((item) => item.stylexPriority != null) ||
    target.some((item) => item.stylexPriority == null)
  ) {
    reasons.push('invalid StyleX priority provenance');
  }
  if (reasons.length > 0) {
    return {
      status: 'unsupported',
      model: DIRECTIONAL_REFEREE_MODEL,
      reasons: Object.freeze([...new Set(reasons)].sort()),
    };
  }
  const differences = [];
  for (const state of DIRECTIONAL_STATES) {
    const properties = new Set(
      [...source, ...target].map((item) =>
        physicalProperty(item.property, state),
      ),
    );
    for (const property of [...properties].sort()) {
      const sourceWinner = winner(source, property, state, false);
      const targetWinner = winner(target, property, state, true);
      if (sourceWinner?.value !== targetWinner?.value) {
        differences.push({
          stateId: state.id,
          property,
          sourceValue: sourceWinner?.value ?? null,
          targetValue: targetWinner?.value ?? null,
        });
      }
    }
  }
  return {
    status: differences.length === 0 ? 'equivalent' : 'mismatch',
    model: DIRECTIONAL_REFEREE_MODEL,
    states: DIRECTIONAL_STATES,
    differences: Object.freeze(differences),
  };
}

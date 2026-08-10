/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { canonicalProperty, canonicalValue } from '../compare/model';

export const REFEREE_MODEL: string = 'cascade-referee-v1-spec';

export type Specificity = $ReadOnly<[number, number, number]>;

export type RefereeDeclaration = {
  +id: string,
  +property: string,
  +value: string,
  +important: boolean,
  +pseudoElement: string | null,
  +specificity: Specificity,
  +conditions: $ReadOnlyArray<string>,
  +sourceOrder: number,
  // Present only on the StyleX side. It is observed from compiler metadata.
  +stylexPriority: number | null,
};

export type ActivationState = {
  +id: string,
  +activeConditions: $ReadOnlyArray<string>,
};

export type WinnerDifference = {
  +stateId: string,
  +property: string,
  +pseudoElement: string | null,
  +sourceWinner: string | null,
  +targetWinner: string | null,
  +sourceValue: string | null,
  +targetValue: string | null,
};

export type RefereeResult =
  | {
      +status: 'unsupported',
      +model: string,
      +reasons: $ReadOnlyArray<string>,
    }
  | {
      +status: 'equivalent' | 'mismatch',
      +model: string,
      +states: $ReadOnlyArray<ActivationState>,
      +differences: $ReadOnlyArray<WinnerDifference>,
    };

const FIRST_CONDITIONS = new Set([':hover', ':focus']);

function compareSpecificity(first: Specificity, second: Specificity): number {
  for (let index = 0; index < 3; index++) {
    if (first[index] !== second[index]) {
      return first[index] - second[index];
    }
  }
  return 0;
}

function active(
  declaration: RefereeDeclaration,
  conditions: Set<string>,
): boolean {
  return declaration.conditions.every((condition) => conditions.has(condition));
}

function winner(
  declarations: $ReadOnlyArray<RefereeDeclaration>,
  conditions: Set<string>,
): RefereeDeclaration | null {
  let result = null;
  for (const declaration of declarations) {
    if (!active(declaration, conditions)) {
      continue;
    }
    if (result == null) {
      result = declaration;
      continue;
    }
    if (declaration.important !== result.important) {
      if (declaration.important) {
        result = declaration;
      }
      continue;
    }
    const specificity = compareSpecificity(
      declaration.specificity,
      result.specificity,
    );
    if (
      specificity > 0 ||
      (specificity === 0 && declaration.sourceOrder > result.sourceOrder)
    ) {
      result = declaration;
    }
  }
  return result;
}

function stateId(activeConditions: $ReadOnlyArray<string>): string {
  return activeConditions.length === 0 ? 'default' : activeConditions.join('+');
}

export function activationStates(
  declarations: $ReadOnlyArray<RefereeDeclaration>,
): $ReadOnlyArray<ActivationState> {
  const conditions = [
    ...new Set(declarations.flatMap((declaration) => declaration.conditions)),
  ].sort();
  if (conditions.length > 8) {
    throw new Error('Referee activation state space exceeds 256 states');
  }
  const states = [];
  for (let mask = 0; mask < 2 ** conditions.length; mask++) {
    const activeConditions = conditions.filter(
      (_condition, index) => (mask & (1 << index)) !== 0,
    );
    states.push(
      Object.freeze({
        id: stateId(activeConditions),
        activeConditions: Object.freeze(activeConditions),
      }),
    );
  }
  return Object.freeze(states);
}

function grammarReasons(
  side: 'source' | 'target',
  declarations: $ReadOnlyArray<RefereeDeclaration>,
): $ReadOnlyArray<string> {
  const reasons = new Set<string>();
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const declaration of declarations) {
    if (declaration.id === '' || ids.has(declaration.id)) {
      reasons.add(`${side}: declaration ids must be non-empty and unique`);
    }
    ids.add(declaration.id);
    if (
      declaration.property !== canonicalProperty(declaration.property) ||
      declaration.property.startsWith('--')
    ) {
      reasons.add(`${side}: unsupported property ${declaration.property}`);
    }
    if (declaration.value !== canonicalValue(declaration.value)) {
      reasons.add(
        `${side}: value is not canonical for ${declaration.property}`,
      );
    }
    if (declaration.important) {
      reasons.add(`${side}: !important is outside the first grammar`);
    }
    if (declaration.pseudoElement != null) {
      reasons.add(`${side}: pseudo-elements are outside the first grammar`);
    }
    if (
      declaration.conditions.length > 1 ||
      declaration.conditions.some(
        (condition) => !FIRST_CONDITIONS.has(condition),
      )
    ) {
      reasons.add(`${side}: unsupported condition set`);
    }
    const expectedSpecificity: Specificity =
      declaration.conditions.length === 0 ? [0, 1, 0] : [0, 2, 0];
    if (
      compareSpecificity(declaration.specificity, expectedSpecificity) !== 0
    ) {
      reasons.add(`${side}: unexpected selector specificity`);
    }
    if (
      !Number.isInteger(declaration.sourceOrder) ||
      declaration.sourceOrder < 0
    ) {
      reasons.add(`${side}: invalid source order`);
    }
    if (
      (side === 'source' && declaration.stylexPriority != null) ||
      (side === 'target' &&
        (declaration.stylexPriority == null ||
          !Number.isFinite(declaration.stylexPriority)))
    ) {
      reasons.add(`${side}: invalid StyleX priority provenance`);
    }
    const identity = [
      declaration.property,
      declaration.pseudoElement ?? '',
      ...declaration.conditions,
    ].join('\0');
    if (identities.has(identity)) {
      reasons.add(
        `${side}: duplicate declaration condition for ${declaration.property}`,
      );
    }
    identities.add(identity);
  }
  return Object.freeze([...reasons].sort());
}

function partitions(
  declarations: $ReadOnlyArray<RefereeDeclaration>,
): $ReadOnlyArray<{ +property: string, +pseudoElement: string | null }> {
  const values = new Map<
    string,
    { +property: string, +pseudoElement: string | null },
  >();
  for (const declaration of declarations) {
    const key = `${declaration.property}\0${declaration.pseudoElement ?? ''}`;
    values.set(key, {
      property: declaration.property,
      pseudoElement: declaration.pseudoElement,
    });
  }
  return [...values.values()].sort((first, second) =>
    `${first.property}\0${first.pseudoElement ?? ''}`.localeCompare(
      `${second.property}\0${second.pseudoElement ?? ''}`,
    ),
  );
}

function winnerValue(declaration: RefereeDeclaration | null): string | null {
  return declaration == null
    ? null
    : `${declaration.value}${declaration.important ? ' !important' : ''}`;
}

/**
 * StyleX's extracted stylesheet is ordered by compiler priority. The original
 * object order is not the target cascade order, so the referee derives it and
 * never lets a caller assert it independently.
 *
 * Equal-priority declarations keep their observed order. In the first grammar
 * equal-priority declarations never compete within one property/state; a later
 * grammar must model StyleX's full rule-text tie-break before admitting such a
 * case.
 */
export function orderStyleXDeclarations(
  declarations: $ReadOnlyArray<RefereeDeclaration>,
): $ReadOnlyArray<RefereeDeclaration> {
  return Object.freeze(
    [...declarations]
      .sort(
        (first, second) =>
          (first.stylexPriority ?? 0) - (second.stylexPriority ?? 0) ||
          first.sourceOrder - second.sourceOrder,
      )
      .map((declaration, sourceOrder) =>
        Object.freeze({ ...declaration, sourceOrder }),
      ),
  );
}

export function referee(
  source: $ReadOnlyArray<RefereeDeclaration>,
  target: $ReadOnlyArray<RefereeDeclaration>,
): RefereeResult {
  const reasons = [
    ...grammarReasons('source', source),
    ...grammarReasons('target', target),
  ];
  if (reasons.length > 0) {
    return Object.freeze({
      status: 'unsupported',
      model: REFEREE_MODEL,
      reasons: Object.freeze(reasons.sort()),
    });
  }
  const orderedTarget = orderStyleXDeclarations(target);
  const states = activationStates([...source, ...orderedTarget]);
  const differences = [];
  for (const partition of partitions([...source, ...orderedTarget])) {
    const sourceDeclarations = source.filter(
      (declaration) =>
        declaration.property === partition.property &&
        declaration.pseudoElement === partition.pseudoElement,
    );
    const targetDeclarations = orderedTarget.filter(
      (declaration) =>
        declaration.property === partition.property &&
        declaration.pseudoElement === partition.pseudoElement,
    );
    for (const state of states) {
      const activeConditions = new Set(state.activeConditions);
      const sourceWinner = winner(sourceDeclarations, activeConditions);
      const targetWinner = winner(targetDeclarations, activeConditions);
      if (winnerValue(sourceWinner) !== winnerValue(targetWinner)) {
        differences.push(
          Object.freeze({
            stateId: state.id,
            property: partition.property,
            pseudoElement: partition.pseudoElement,
            sourceWinner: sourceWinner?.id ?? null,
            targetWinner: targetWinner?.id ?? null,
            sourceValue: winnerValue(sourceWinner),
            targetValue: winnerValue(targetWinner),
          }),
        );
      }
    }
  }
  return Object.freeze({
    status: differences.length === 0 ? 'equivalent' : 'mismatch',
    model: REFEREE_MODEL,
    states,
    differences: Object.freeze(differences),
  });
}

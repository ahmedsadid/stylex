/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

/**
 * The neutral style representation.
 *
 * It models CSS meaning and nothing else. It deliberately cannot express
 * evaluation order, purity, or binding identity — those are JavaScript
 * semantics, they cannot be confirmed by comparing stylesheets, and a
 * representation that pretended to hold them would invite the mechanical lane
 * to convert things it cannot check.
 *
 * The representation grows only with independently versioned comparison
 * models. It currently admits flat literals, the first hover/focus condition
 * grammar, flat before/after selector targets, and one exact media query.
 * Keyframes, shorthands, multiple queries, and combinations of modifiers
 * remain outside it.
 */

export type StaticValue = string | number;
export type Condition = ':hover' | ':focus';
export type PseudoElement = '::before' | '::after';

export type Declaration = {
  // The property name exactly as authored (camelCase, as both libraries take).
  +property: string,
  +value: StaticValue,
  +condition?: Condition,
  +pseudoElement?: PseudoElement,
  +mediaQuery?: string,
};

export type StyleObject = {
  +declarations: $ReadOnlyArray<Declaration>,
};

export function styleObject(
  declarations: $ReadOnlyArray<Declaration>,
): StyleObject {
  return Object.freeze({ declarations: Object.freeze([...declarations]) });
}

export function isEmptyStyle(style: StyleObject): boolean {
  return style.declarations.length === 0;
}

export function hasConditions(style: StyleObject): boolean {
  return style.declarations.some(
    (declaration) => declaration.condition != null,
  );
}

export function hasPseudoElements(style: StyleObject): boolean {
  return style.declarations.some(
    (declaration) => declaration.pseudoElement != null,
  );
}

export function hasMediaQueries(style: StyleObject): boolean {
  return style.declarations.some(
    (declaration) => declaration.mediaQuery != null,
  );
}

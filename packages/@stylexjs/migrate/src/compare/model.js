/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

/**
 * Comparison model `static-css-v1`.
 *
 * This module decides whether two stylesheets say the same thing. It is
 * comparison-only: it never produces CSS, and neither the Emotion side nor the
 * StyleX side is built from it. Both sides arrive as finished CSS text from
 * their own library, and this model's whole job is to strip differences that
 * are known to carry no meaning.
 *
 * What it canonicalises, and why each is safe:
 *
 *   - Surrounding and repeated whitespace.
 *   - Whitespace around commas, so `rgb(1, 2, 3)` and `rgb(1,2,3)` agree.
 *   - A missing leading zero, so `.5` and `0.5` agree. The two libraries
 *     genuinely differ here: Emotion prints `opacity:0.5` and StyleX prints
 *     `opacity:.5`.
 *
 * What it does NOT do, deliberately: it does not reorder or merge
 * declarations, resolve shorthands, convert units, or lowercase values. Every
 * one of those would let a real difference through, and the supported subset
 * is drawn so that none of them is needed.
 *
 * The model is versioned because admitting a new construct means changing what
 * counts as equal, and a claim that does not name its model is not a claim.
 */

export const COMPARISON_MODEL: string = 'static-css-v1';

export type CssDeclaration = {
  +property: string,
  +value: string,
};

export type Difference = {
  +property: string,
  +source: string | null,
  +target: string | null,
};

export type ComparisonResult = {
  +equal: boolean,
  +model: string,
  +differences: $ReadOnlyArray<Difference>,
};

export function canonicalValue(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .replace(/(^|[\s(,:])(-?)\.(\d)/g, '$1$20.$3');
}

export function canonicalProperty(property: string): string {
  return property.trim().toLowerCase();
}

/**
 * Parse a declaration list such as `color:red;font-size:12px;`.
 */
export function parseDeclarations(
  cssText: string,
): $ReadOnlyArray<CssDeclaration> {
  const declarations = [];
  for (const chunk of cssText.split(';')) {
    const text = chunk.trim();
    if (text === '') {
      continue;
    }
    const separator = text.indexOf(':');
    if (separator === -1) {
      continue;
    }
    declarations.push({
      property: canonicalProperty(text.slice(0, separator)),
      value: canonicalValue(text.slice(separator + 1)),
    });
  }
  return declarations;
}

/**
 * Parse the body of a single rule such as `.x1abc{color:red}`.
 */
export function parseRule(rule: string): $ReadOnlyArray<CssDeclaration> {
  const open = rule.indexOf('{');
  const close = rule.lastIndexOf('}');
  if (open === -1 || close === -1 || close < open) {
    return [];
  }
  return parseDeclarations(rule.slice(open + 1, close));
}

function toMap(
  declarations: $ReadOnlyArray<CssDeclaration>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const declaration of declarations) {
    // A later declaration for the same property wins, as in a stylesheet.
    map.set(declaration.property, declaration.value);
  }
  return map;
}

export function compareDeclarations(
  source: $ReadOnlyArray<CssDeclaration>,
  target: $ReadOnlyArray<CssDeclaration>,
): ComparisonResult {
  const sourceMap = toMap(source);
  const targetMap = toMap(target);
  const properties = [
    ...new Set([...sourceMap.keys(), ...targetMap.keys()]),
  ].sort();

  const differences = [];
  for (const property of properties) {
    const sourceValue = sourceMap.get(property) ?? null;
    const targetValue = targetMap.get(property) ?? null;
    if (sourceValue !== targetValue) {
      differences.push({ property, source: sourceValue, target: targetValue });
    }
  }

  return Object.freeze({
    equal: differences.length === 0,
    model: COMPARISON_MODEL,
    differences: Object.freeze(differences),
  });
}

export function describeDifferences(
  differences: $ReadOnlyArray<Difference>,
): string {
  return differences
    .map((difference) => {
      if (difference.source == null) {
        return `${difference.property}: only StyleX emits it (${String(difference.target)})`;
      }
      if (difference.target == null) {
        return `${difference.property}: only Emotion emits it (${difference.source})`;
      }
      return `${difference.property}: Emotion ${difference.source} vs StyleX ${difference.target}`;
    })
    .join('; ');
}

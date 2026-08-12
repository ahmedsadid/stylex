/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import postcss from 'postcss';

/**
 * Comparison model `static-css-v3`.
 *
 * This module decides whether two stylesheets say the same thing. It is
 * comparison-only: it never produces CSS, and neither the Emotion side nor the
 * StyleX side is built from it. Both sides arrive as finished CSS text from
 * their own library, and this model's whole job is to strip differences that
 * are known to carry no meaning.
 *
 * Parsing is delegated to postcss. The previous version split declarations on
 * `;` and canonicalised values with plain string replacement, which is wrong
 * the moment a value contains one: `content: "a;b"` and `content: "a;c"` both
 * reduced to `content: "a` and compared equal. Getting CSS syntax right is not
 * this project's contribution, and a hand-rolled splitter is exactly the sort
 * of thing that diverges quietly.
 *
 * What canonicalisation does, and why each step is safe:
 *
 *   - Collapses whitespace runs **outside strings and `url()`**.
 *   - Removes whitespace around commas, outside strings, so `rgb(1, 2, 3)` and
 *     `rgb(1,2,3)` agree.
 *   - Adds a missing leading zero, outside strings, so `.5` and `0.5` agree.
 *     The two libraries genuinely differ here: Emotion prints `opacity:0.5`
 *     and StyleX prints `opacity:.5`.
 *
 * Everything inside a quoted string or a `url()` is copied verbatim, because a
 * space or a leading zero there is content rather than formatting.
 *
 * What it does NOT do, deliberately: it does not reorder or merge
 * declarations, resolve shorthands, convert units, or lowercase values. Every
 * one of those would let a real difference through, and the supported subset is
 * drawn so that none of them is needed.
 *
 * v3 adds declaration importance to the comparison identity. The model is
 * versioned because admitting a construct — or fixing what counts as equal —
 * changes the meaning of the claim, and a claim that does not name its model is
 * not a claim.
 */

export const COMPARISON_MODEL: string = 'static-css-v3';

export type CssDeclaration = {
  +property: string,
  +value: string,
  +important?: boolean,
};

export type ParsedCss =
  | { +ok: true, +declarations: $ReadOnlyArray<CssDeclaration> }
  | { +ok: false, +reason: string };

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

const QUOTES = new Set(["'", '"']);

/**
 * Canonicalise a declaration value without touching the inside of strings or
 * `url()`.
 */
export function canonicalValue(value: string): string {
  let result = '';
  let index = 0;

  const copyQuoted = (quote: string) => {
    result += value[index];
    index++;
    while (index < value.length) {
      const character = value[index];
      result += character;
      index++;
      if (character === '\\' && index < value.length) {
        // An escaped character cannot end the string.
        result += value[index];
        index++;
        continue;
      }
      if (character === quote) {
        return;
      }
    }
  };

  while (index < value.length) {
    const character = value[index];

    if (QUOTES.has(character)) {
      copyQuoted(character);
      continue;
    }

    if (value.startsWith('url(', index)) {
      const close = value.indexOf(')', index);
      const end = close === -1 ? value.length : close + 1;
      result += value.slice(index, end);
      index = end;
      continue;
    }

    if (/\s/.test(character)) {
      // Collapse a run of whitespace, and drop it entirely next to a comma.
      let lookahead = index;
      while (lookahead < value.length && /\s/.test(value[lookahead])) {
        lookahead++;
      }
      const previous = result[result.length - 1];
      const next = value[lookahead];
      if (
        previous !== ',' &&
        next !== ',' &&
        previous != null &&
        next != null
      ) {
        result += ' ';
      }
      index = lookahead;
      continue;
    }

    if (character === ',') {
      // Drop whitespace already emitted before the comma.
      result = result.replace(/\s+$/, '');
      result += ',';
      index++;
      continue;
    }

    if (
      character === '.' &&
      /\d/.test(value[index + 1] ?? '') &&
      !/[\d.]/.test(result[result.length - 1] ?? '')
    ) {
      result += '0.';
      index++;
      continue;
    }

    result += character;
    index++;
  }

  return result.trim();
}

export function canonicalProperty(property: string): string {
  return property.trim().toLowerCase();
}

function collect(root: $FlowFixMe): ParsedCss {
  const declarations = [];
  for (const node of root.nodes ?? []) {
    if (node.type !== 'decl') {
      // Anything that is not a plain declaration is outside what this model
      // claims to understand. Silently dropping it would let real CSS go
      // uncompared while the result still read as a match.
      return {
        ok: false,
        reason: `unsupported CSS node of type "${String(node.type)}"`,
      };
    }
    declarations.push({
      property: canonicalProperty(String(node.prop)),
      value: canonicalValue(String(node.value)),
      ...(node.important === true ? { important: true } : {}),
    });
  }
  return { ok: true, declarations };
}

/**
 * Parse a declaration list such as `color:red;font-size:12px;`.
 */
export function parseDeclarations(cssText: string): ParsedCss {
  let root;
  try {
    root = postcss.parse(cssText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `could not parse CSS: ${message}` };
  }
  return collect(root);
}

/**
 * Parse the body of a single rule such as `.x1abc{color:red}`.
 */
export function parseRule(rule: string): ParsedCss {
  let root;
  try {
    root = postcss.parse(rule);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `could not parse CSS rule: ${message}` };
  }
  const nodes = root.nodes ?? [];
  if (nodes.length !== 1 || nodes[0].type !== 'rule') {
    return {
      ok: false,
      reason: 'expected exactly one CSS rule',
    };
  }
  return collect(nodes[0]);
}

function toMap(
  declarations: $ReadOnlyArray<CssDeclaration>,
): Map<string, CssDeclaration> {
  const map = new Map<string, CssDeclaration>();
  for (const declaration of declarations) {
    // A later declaration for the same property wins, as in a stylesheet.
    map.set(declaration.property, declaration);
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
    const sourceDeclaration = sourceMap.get(property) ?? null;
    const targetDeclaration = targetMap.get(property) ?? null;
    const sourceValue =
      sourceDeclaration == null
        ? null
        : `${sourceDeclaration.value}${
            sourceDeclaration.important === true ? ' !important' : ''
          }`;
    const targetValue =
      targetDeclaration == null
        ? null
        : `${targetDeclaration.value}${
            targetDeclaration.important === true ? ' !important' : ''
          }`;
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

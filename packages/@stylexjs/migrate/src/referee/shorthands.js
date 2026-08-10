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
import {
  canonicalProperty,
  canonicalValue,
  compareDeclarations,
} from '../compare/model';
import type { CssDeclaration, Difference } from '../compare/model';

export const BOX_SHORTHAND_REFEREE_MODEL: string = 'box-shorthand-referee-v1';

export type BoxShorthandObservation =
  | { +ok: true, +declarations: $ReadOnlyArray<CssDeclaration>, +css: string }
  | { +ok: false, +reason: string };

export type BoxShorthandRefereeResult = {
  +status: 'equivalent' | 'mismatch',
  +model: string,
  +differences: $ReadOnlyArray<Difference>,
};

const BOX_LONGHANDS: { +[string]: $ReadOnlyArray<string> } = {
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
};

function fourSides(values: $ReadOnlyArray<string>): $ReadOnlyArray<string> {
  if (values.length === 1) return [values[0], values[0], values[0], values[0]];
  if (values.length === 2) return [values[0], values[1], values[0], values[1]];
  if (values.length === 3) return [values[0], values[1], values[2], values[1]];
  return values;
}

export function expandBoxShorthand(
  property: string,
  value: string,
): $ReadOnlyArray<CssDeclaration> | null {
  const longhands = BOX_LONGHANDS[property];
  if (longhands == null) return null;
  const values = value.trim().split(/\s+/);
  if (values.length < 1 || values.length > 4) return null;
  const expanded = fourSides(values);
  return longhands.map((longhand, index) => ({
    property: longhand,
    value: canonicalValue(expanded[index]),
  }));
}

export function observeEmotionBoxShorthands(
  style: mixed,
): BoxShorthandObservation {
  let css;
  try {
    css = String(serializeStyles([style]).styles);
  } catch (error) {
    return {
      ok: false,
      reason: `Emotion shorthand serialization failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let root;
  try {
    root = postcss.parse(css);
  } catch (error) {
    return {
      ok: false,
      reason: `Emotion shorthand CSS could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const winners = new Map<string, CssDeclaration>();
  for (const node of root.nodes ?? []) {
    if (node.type !== 'decl' || node.important === true) {
      return { ok: false, reason: 'unsupported shorthand CSS shape' };
    }
    const property = canonicalProperty(String(node.prop));
    const value = canonicalValue(String(node.value));
    const expanded = expandBoxShorthand(property, value);
    const values = expanded ?? [{ property, value }];
    for (const declaration of values) {
      winners.set(declaration.property, declaration);
    }
  }
  return {
    ok: true,
    css,
    declarations: Object.freeze([...winners.values()]),
  };
}

export function refereeBoxShorthands(
  source: $ReadOnlyArray<CssDeclaration>,
  target: $ReadOnlyArray<CssDeclaration>,
): BoxShorthandRefereeResult {
  const compared = compareDeclarations(source, target);
  return {
    status: compared.equal ? 'equivalent' : 'mismatch',
    model: BOX_SHORTHAND_REFEREE_MODEL,
    differences: compared.differences,
  };
}

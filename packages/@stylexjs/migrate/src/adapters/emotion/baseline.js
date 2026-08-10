/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { serializeStyles } from '@emotion/serialize';
import { parseSource } from '../../static/parse';
import { walk } from '../../static/walk';
import { parseDeclarations } from '../../compare/model';
import { observeEmotionSerialization } from '../../referee/observations';
import type { CssDeclaration } from '../../compare/model';
import type { CascadeObservation } from '../../referee/observations';

/**
 * The independent Emotion baseline.
 *
 * The CSS that the original code meant is produced by **Emotion's own
 * serializer**, from the authored source text. Nothing in this package decides
 * what `fontSize: 12` means — that `font-size:12px` rather than `font-size:12`
 * is Emotion's answer, taken from Emotion.
 *
 * This is the independence rule the comparison depends on. Discovery and this
 * module share a parser, which is allowed; they must never share the code that
 * assigns meaning to a declaration, because a single bug in shared meaning
 * would make wrong output look perfect on both sides.
 *
 * The authored object is evaluated to a runtime value, which is what a
 * serializer needs. That is only safe because the span is checked first: every
 * key is a plain name and every value is a string or number literal, so there
 * is nothing to execute. The check is repeated here rather than assumed, so
 * the function is safe on its own terms.
 */

export type BaselineResult =
  | { +ok: true, +css: string, +declarations: $ReadOnlyArray<CssDeclaration> }
  | { +ok: false, +reason: string };

function isLiteralOnlyObject(objectSource: string): boolean {
  const parsed = parseSource(`(${objectSource})`, 'baseline-guard.js');
  if (!parsed.ok) {
    return false;
  }
  let objects = 0;
  let safe = true;
  walk(parsed.ast, (node) => {
    if (node.type === 'ObjectExpression') {
      objects++;
      for (const property of node.properties ?? []) {
        if (
          property.type !== 'ObjectProperty' ||
          property.computed === true ||
          (property.key.type !== 'Identifier' &&
            property.key.type !== 'StringLiteral') ||
          (property.value.type !== 'StringLiteral' &&
            property.value.type !== 'NumericLiteral')
        ) {
          safe = false;
        }
      }
    }
  });
  return safe && objects === 1;
}

function staticKey(property: $FlowFixMe): string | null {
  if (property.type !== 'ObjectProperty' || property.computed === true) {
    return null;
  }
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'StringLiteral') return property.key.value;
  return null;
}

function literalValue(node: $FlowFixMe): boolean {
  return (
    node.type === 'StringLiteral' ||
    (node.type === 'NumericLiteral' && Number.isFinite(node.value))
  );
}

function isApprovedConditionalObject(objectSource: string): boolean {
  const parsed = parseSource(`(${objectSource})`, 'cascade-baseline-guard.js');
  if (!parsed.ok) return false;
  const expression = parsed.ast.program?.body?.[0]?.expression;
  if (expression?.type !== 'ObjectExpression') return false;
  for (const property of expression.properties ?? []) {
    const name = staticKey(property);
    if (name == null) return false;
    if (literalValue(property.value)) continue;
    if (
      property.value?.type !== 'ObjectExpression' ||
      (name !== ':hover' && name !== ':focus')
    ) {
      return false;
    }
    for (const nested of property.value.properties ?? []) {
      if (staticKey(nested) == null || !literalValue(nested.value)) {
        return false;
      }
    }
  }
  return true;
}

function isApprovedPseudoElementObject(objectSource: string): boolean {
  const parsed = parseSource(`(${objectSource})`, 'pseudo-baseline-guard.js');
  if (!parsed.ok) return false;
  const expression = parsed.ast.program?.body?.[0]?.expression;
  if (expression?.type !== 'ObjectExpression') return false;
  for (const property of expression.properties ?? []) {
    const name = staticKey(property);
    if (name == null) return false;
    if (literalValue(property.value)) continue;
    if (
      property.value?.type !== 'ObjectExpression' ||
      (name !== '::before' && name !== '::after')
    ) {
      return false;
    }
    for (const nested of property.value.properties ?? []) {
      if (staticKey(nested) == null || !literalValue(nested.value)) {
        return false;
      }
    }
  }
  return true;
}

export function emotionBaseline(objectSource: string): BaselineResult {
  if (!isLiteralOnlyObject(objectSource)) {
    return {
      ok: false,
      reason:
        'refusing to evaluate a style object that is not made only of literal ' +
        'keys and literal values',
    };
  }

  let styleValue: mixed;
  try {
    // eslint-disable-next-line no-new-func
    styleValue = new Function(`return (${objectSource});`)();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `could not evaluate the style object: ${message}`,
    };
  }

  try {
    const serialized = serializeStyles([styleValue]);
    const css = String(serialized.styles);
    const parsed = parseDeclarations(css);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: `could not read the CSS Emotion produced: ${parsed.reason}`,
      };
    }
    return { ok: true, css, declarations: parsed.declarations };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `Emotion could not serialize the style: ${message}`,
    };
  }
}

export function emotionConditionalBaseline(
  objectSource: string,
): CascadeObservation {
  if (!isApprovedConditionalObject(objectSource)) {
    return {
      ok: false,
      reason:
        'refusing to evaluate a conditional style outside the approved literal grammar',
    };
  }
  let styleValue: mixed;
  try {
    // eslint-disable-next-line no-new-func
    styleValue = new Function(`return (${objectSource});`)();
  } catch (error) {
    return {
      ok: false,
      reason: `could not evaluate the conditional style object: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return observeEmotionSerialization(styleValue);
}

export function emotionPseudoElementBaseline(
  objectSource: string,
): CascadeObservation {
  if (!isApprovedPseudoElementObject(objectSource)) {
    return {
      ok: false,
      reason:
        'refusing to evaluate a pseudo-element style outside the approved literal grammar',
    };
  }
  let styleValue: mixed;
  try {
    // eslint-disable-next-line no-new-func
    styleValue = new Function(`return (${objectSource});`)();
  } catch (error) {
    return {
      ok: false,
      reason: `could not evaluate the pseudo-element style object: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return observeEmotionSerialization(styleValue);
}

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
import type { CssDeclaration } from '../../compare/model';

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
    return { ok: true, css, declarations: parseDeclarations(css) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `Emotion could not serialize the style: ${message}`,
    };
  }
}

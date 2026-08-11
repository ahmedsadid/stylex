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
import { observeEmotionKeyframes } from '../../referee/keyframes';
import { observeEmotionBoxShorthands } from '../../referee/shorthands';
import { observeEmotionDirectional } from '../../referee/directional';
import type { CssDeclaration } from '../../compare/model';
import type { CascadeObservation } from '../../referee/observations';
import type { KeyframesObservationResult } from '../../referee/keyframes';
import type { BoxShorthandObservation } from '../../referee/shorthands';
import type { DirectionalObservation } from '../../referee/directional';

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

function isApprovedMediaQueryObject(objectSource: string): boolean {
  const parsed = parseSource(`(${objectSource})`, 'media-baseline-guard.js');
  if (!parsed.ok) return false;
  const expression = parsed.ast.program?.body?.[0]?.expression;
  if (expression?.type !== 'ObjectExpression') return false;
  const mediaQueries = new Set<string>();
  for (const property of expression.properties ?? []) {
    const name = staticKey(property);
    if (name == null) return false;
    if (literalValue(property.value)) continue;
    if (
      property.value?.type !== 'ObjectExpression' ||
      !/^@media [^\r\n{}]+$/.test(name)
    ) {
      return false;
    }
    mediaQueries.add(name);
    for (const nested of property.value.properties ?? []) {
      if (staticKey(nested) == null || !literalValue(nested.value)) {
        return false;
      }
    }
  }
  return mediaQueries.size === 1;
}

function isApprovedSupportsNestingObject(objectSource: string): boolean {
  const parsed = parseSource(`(${objectSource})`, 'supports-baseline-guard.js');
  if (!parsed.ok) return false;
  const expression = parsed.ast.program?.body?.[0]?.expression;
  if (expression?.type !== 'ObjectExpression') return false;
  const supports = new Set<string>();
  const media = new Set<string>();
  const visit = (
    object: $FlowFixMe,
    atRules: $ReadOnlyArray<string>,
  ): boolean => {
    for (const property of object.properties ?? []) {
      const name = staticKey(property);
      if (name == null) return false;
      if (literalValue(property.value)) continue;
      if (property.value?.type !== 'ObjectExpression' || atRules.length >= 2) {
        return false;
      }
      const isSupports = /^@supports [^\r\n{}]+$/.test(name);
      const isMedia = /^@media [^\r\n{}]+$/.test(name);
      if (!isSupports && !isMedia) return false;
      if (
        atRules.some((atRule) =>
          isSupports
            ? atRule.startsWith('@supports ')
            : atRule.startsWith('@media '),
        )
      ) {
        return false;
      }
      if (isSupports) supports.add(name);
      if (isMedia) media.add(name);
      if (!visit(property.value, [...atRules, name])) return false;
    }
    return true;
  };
  return visit(expression, []) && supports.size === 1 && media.size <= 1;
}

function isApprovedKeyframesObject(objectSource: string): boolean {
  const parsed = parseSource(
    `(${objectSource})`,
    'keyframes-baseline-guard.js',
  );
  if (!parsed.ok) return false;
  const expression = parsed.ast.program?.body?.[0]?.expression;
  if (expression?.type !== 'ObjectExpression') return false;
  let keyframes = 0;
  for (const property of expression.properties ?? []) {
    const name = staticKey(property);
    if (name == null) return false;
    if (literalValue(property.value)) continue;
    if (
      property.value?.type !== 'ObjectExpression' ||
      !/^@keyframes [A-Za-z_][A-Za-z0-9_-]*$/.test(name)
    ) {
      return false;
    }
    keyframes++;
    const selectors = new Set<string>();
    for (const frame of property.value.properties ?? []) {
      const selector = staticKey(frame);
      if (
        (selector !== 'from' && selector !== 'to') ||
        frame.value?.type !== 'ObjectExpression'
      ) {
        return false;
      }
      selectors.add(selector);
      for (const declaration of frame.value.properties ?? []) {
        if (
          staticKey(declaration) == null ||
          !literalValue(declaration.value)
        ) {
          return false;
        }
      }
    }
    if (selectors.size !== 2) return false;
  }
  return keyframes === 1;
}

function isApprovedBoxShorthandObject(objectSource: string): boolean {
  const parsed = parseSource(
    `(${objectSource})`,
    'shorthand-baseline-guard.js',
  );
  if (!parsed.ok) return false;
  const expression = parsed.ast.program?.body?.[0]?.expression;
  if (expression?.type !== 'ObjectExpression') return false;
  let shorthand = false;
  for (const property of expression.properties ?? []) {
    const name = staticKey(property);
    if (name == null || !literalValue(property.value)) return false;
    if (name === 'margin' || name === 'padding') shorthand = true;
  }
  return shorthand;
}

function isApprovedDirectionalObject(objectSource: string): boolean {
  const parsed = parseSource(
    `(${objectSource})`,
    'directional-baseline-guard.js',
  );
  if (!parsed.ok) return false;
  const expression = parsed.ast.program?.body?.[0]?.expression;
  if (expression?.type !== 'ObjectExpression') return false;
  let directional = false;
  for (const property of expression.properties ?? []) {
    const name = staticKey(property);
    if (name == null || !literalValue(property.value)) return false;
    if (
      /^(?:(?:margin|padding)(?:Inline|Block)(?:Start|End)|(?:inline|block)Size)$/.test(
        name,
      )
    ) {
      directional = true;
    }
  }
  return directional;
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
    // `serializeStyles` retains Emotion's `label` metadata in its intermediate
    // string so it can contribute to the generated class name. Emotion's cache
    // removes that pseudo-declaration before CSS reaches the browser. Compare
    // rendered declarations, not the serializer's class-name bookkeeping.
    const declarations = parsed.declarations.filter(
      (declaration) => declaration.property !== 'label',
    );
    return { ok: true, css, declarations };
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

export function emotionMediaQueryBaseline(
  objectSource: string,
): CascadeObservation {
  if (!isApprovedMediaQueryObject(objectSource)) {
    return {
      ok: false,
      reason:
        'refusing to evaluate a media-query style outside the approved literal grammar',
    };
  }
  let styleValue: mixed;
  try {
    // eslint-disable-next-line no-new-func
    styleValue = new Function(`return (${objectSource});`)();
  } catch (error) {
    return {
      ok: false,
      reason: `could not evaluate the media-query style object: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return observeEmotionSerialization(styleValue);
}

export function emotionSupportsNestingBaseline(
  objectSource: string,
): CascadeObservation {
  if (!isApprovedSupportsNestingObject(objectSource)) {
    return {
      ok: false,
      reason:
        'refusing to evaluate a supports style outside the approved bounded literal grammar',
    };
  }
  let styleValue: mixed;
  try {
    // eslint-disable-next-line no-new-func
    styleValue = new Function(`return (${objectSource});`)();
  } catch (error) {
    return {
      ok: false,
      reason: `could not evaluate the supports style object: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return observeEmotionSerialization(styleValue);
}

export function emotionKeyframesBaseline(
  objectSource: string,
): KeyframesObservationResult {
  if (!isApprovedKeyframesObject(objectSource)) {
    return {
      ok: false,
      reason:
        'refusing to evaluate keyframes outside the approved literal from/to grammar',
    };
  }
  let styleValue: mixed;
  try {
    // eslint-disable-next-line no-new-func
    styleValue = new Function(`return (${objectSource});`)();
  } catch (error) {
    return {
      ok: false,
      reason: `could not evaluate the keyframes style object: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return observeEmotionKeyframes(styleValue);
}

export function emotionBoxShorthandBaseline(
  objectSource: string,
): BoxShorthandObservation {
  if (!isApprovedBoxShorthandObject(objectSource)) {
    return {
      ok: false,
      reason:
        'refusing to evaluate a box shorthand outside the approved flat literal grammar',
    };
  }
  let styleValue: mixed;
  try {
    // eslint-disable-next-line no-new-func
    styleValue = new Function(`return (${objectSource});`)();
  } catch (error) {
    return {
      ok: false,
      reason: `could not evaluate the shorthand style object: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return observeEmotionBoxShorthands(styleValue);
}

export function emotionDirectionalBaseline(
  objectSource: string,
): DirectionalObservation {
  if (!isApprovedDirectionalObject(objectSource)) {
    return {
      ok: false,
      reason:
        'refusing to evaluate directional styles outside the approved flat literal grammar',
    };
  }
  let styleValue: mixed;
  try {
    // eslint-disable-next-line no-new-func
    styleValue = new Function(`return (${objectSource});`)();
  } catch (error) {
    return {
      ok: false,
      reason: `could not evaluate the directional style object: ${String(error)}`,
    };
  }
  return observeEmotionDirectional(styleValue);
}

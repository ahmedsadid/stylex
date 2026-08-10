/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { getPriority } from '@stylexjs/shared';
import { walk } from '../../static/walk';
import { styleObject } from '../../static/ir';
import type {
  Condition,
  Declaration,
  PseudoElement,
  StaticKeyframesValue,
  StaticKeyframe,
  StyleObject,
} from '../../static/ir';

/**
 * Emotion discovery for the mechanical lane.
 *
 * The mechanical lane began with a `css` prop holding an object literal on a
 * plain HTML element, with literal keys and literal values. Later capabilities
 * extend that shape only after an independent comparison model exists.
 *
 * Refusing is not failure. A refusal with a precise reason is a useful result;
 * a conversion we cannot independently confirm is not.
 */

export type RefusalReason =
  | 'css-on-component'
  | 'css-prop-not-object-literal'
  | 'spread-in-style-object'
  | 'computed-style-key'
  | 'nested-style-object'
  | 'unsupported-condition'
  | 'mixed-condition-and-pseudo-element'
  | 'mixed-media-query-modifier'
  | 'multiple-media-queries'
  | 'multiple-supports-queries'
  | 'multiple-keyframes'
  | 'invalid-keyframes'
  | 'missing-keyframes-reference'
  | 'mixed-keyframes-modifier'
  | 'template-literal-value'
  | 'non-literal-value'
  | 'css-with-class-or-style-prop'
  | 'duplicate-css-prop'
  | 'unsupported-property-name'
  | 'shorthand-property'
  | 'invalid-box-shorthand'
  | 'mixed-shorthand-modifier'
  | 'non-finite-number'
  | 'css-with-jsx-spread';

export type EmotionSite = {
  // Span of the whole `css={{...}}` attribute, for replacement.
  +start: number,
  +end: number,
  // Span of just the object literal, for the independent Emotion baseline.
  +objectStart: number,
  +objectEnd: number,
  +elementName: string,
  +style: StyleObject,
};

export type EmotionRefusal = {
  +start: number,
  +end: number,
  +elementName: string,
  +reason: RefusalReason,
};

export type DiscoveryResult = {
  +usesEmotion: boolean,
  +sites: $ReadOnlyArray<EmotionSite>,
  +refusals: $ReadOnlyArray<EmotionRefusal>,
};

// M2 accepts only file-local JSX runtime directives. Imports are ordinary
// bindings, not proof of how JSX is compiled.
const JSX_IMPORT_SOURCE_PRAGMA = '@jsxImportSource @emotion/react';
const CLASSIC_JSX_PRAGMA = '@jsx jsx';

function commentDirectiveLines(value: string): $ReadOnlyArray<string> {
  return value.split(/\r?\n/).map((line) =>
    line
      .trim()
      // Block comments expose their formatting `*` through Babel's comment
      // value. It is not part of the directive.
      .replace(/^\*\s?/, '')
      .trim(),
  );
}

// Emotion accepts `fontSize` and `'font-size'` alike; StyleX takes the
// camelCase form. Rather than translate between them here — which would be this
// module deciding what a declaration means — the mechanical lane handles only
// names that are already in the shape StyleX wants.
const SUPPORTED_PROPERTY_NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;
const SUPPORTED_CONDITIONS: $ReadOnlySet<string> = new Set([
  ':hover',
  ':focus',
]);
const SUPPORTED_PSEUDO_ELEMENTS: $ReadOnlySet<string> = new Set([
  '::before',
  '::after',
]);
const MEDIA_QUERY = /^@media [^\r\n{}]+$/;
const SUPPORTS_QUERY = /^@supports [^\r\n{}]+$/;
const KEYFRAMES = /^@keyframes ([A-Za-z_][A-Za-z0-9_-]*)$/;

type DeclarationTarget =
  | { +kind: 'root' }
  | { +kind: 'condition', +condition: Condition }
  | { +kind: 'pseudo-element', +pseudoElement: PseudoElement }
  | { +kind: 'media-query', +mediaQuery: string }
  | { +kind: 'supports-query', +supportsQuery: string }
  | {
      +kind: 'supports-media-query',
      +supportsQuery: string,
      +mediaQuery: string,
    };

/**
 * Shorthands are refused wholesale.
 *
 * A shorthand and a longhand for the same box interact through the cascade:
 * in Emotion `{marginTop: 20, margin: 4}` ends up with every margin at 4,
 * because the later shorthand resets them. StyleX resolves the same pair by
 * fixed priority, where the longhand outranks the shorthand, and margin-top
 * stays 20. Both stylesheets then contain the same two declarations, so a
 * comparison that comes down to a set of declarations would call this a match
 * and be wrong.
 *
 * Which properties those are is asked of StyleX itself rather than kept in a
 * list here. StyleX assigns a lower priority to a property precisely when it
 * can be reset by something more specific, so its priority table *is* the
 * shorthand boundary — and unlike a hand-maintained list it does not fall
 * behind as CSS grows. `getPriority` expects kebab-case; a camelCase name it
 * does not recognise silently returns the default, which is why the name is
 * converted first.
 *
 * A later capability can admit shorthands with a comparison model that
 * understands the interaction. Until then the honest answer is a refusal.
 */
const LONGHAND_PRIORITY = 3000;

function toKebabCase(property: string): string {
  return property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export function isShorthandProperty(property: string): boolean {
  return getPriority(toKebabCase(property)) < LONGHAND_PRIORITY;
}

function isHostElementName(name: string): boolean {
  const first = name[0];
  return first != null && first === first.toLowerCase();
}

function elementNameOf(opening: $FlowFixMe): string | null {
  const name = opening.name;
  if (name == null || typeof name !== 'object') {
    return null;
  }
  if (name.type === 'JSXIdentifier' && typeof name.name === 'string') {
    return name.name;
  }
  return null;
}

/**
 * Whether this file's `css` props are handled by Emotion.
 *
 * The pragma is read from parsed comments rather than searched for in the raw
 * text, because the same characters inside a string or an unrelated sentence
 * prove nothing.
 *
 * This is evidence, not proof, and it errs toward doing nothing. A project can
 * configure the Emotion JSX runtime globally, in which case a file with neither
 * pragma nor import still has Emotion semantics and will be reported as having
 * nothing to convert. Reading build configuration is a later, project-wide
 * concern; being wrong in that direction costs coverage, while the opposite
 * would rewrite files whose `css` prop means something else entirely.
 */
export function usesEmotion(ast: $FlowFixMe): boolean {
  for (const comment of ast.comments ?? []) {
    const value = String(comment.value ?? '');
    if (
      commentDirectiveLines(value).some(
        (line) =>
          line === JSX_IMPORT_SOURCE_PRAGMA || line === CLASSIC_JSX_PRAGMA,
      )
    ) {
      return true;
    }
  }
  // An import is not JSX-runtime configuration. This is especially clear for
  // `import type`, but a value import alone also does not establish that the
  // Emotion Babel transform or JSX runtime handles host-element `css` props.
  // Project-wide configuration becomes a separate, explicit fact in M4.
  return false;
}

function propertyName(property: $FlowFixMe): string | null {
  if (property.type !== 'ObjectProperty' || property.computed === true) {
    return null;
  }
  const key = property.key;
  if (key.type === 'Identifier' && typeof key.name === 'string') {
    return key.name;
  }
  if (key.type === 'StringLiteral' && typeof key.value === 'string') {
    return key.value;
  }
  return null;
}

/** Return the authored positions whose static keys survive object construction. */
function lastPropertyIndexes(
  properties: $ReadOnlyArray<$FlowFixMe>,
): $ReadOnlySet<number> {
  const seen = new Set<string>();
  const result = new Set<number>();
  for (let index = properties.length - 1; index >= 0; index--) {
    const property = properties[index];
    const name = propertyName(property);
    if (name == null || seen.has(name)) continue;
    seen.add(name);
    result.add(index);
  }
  return result;
}

/** Apply last-key-wins only after every authored value has been inspected. */
function lastDeclarations(
  declarations: $ReadOnlyArray<Declaration>,
): $ReadOnlyArray<Declaration> {
  const seen = new Set<string>();
  const result: Array<Declaration> = [];
  for (let index = declarations.length - 1; index >= 0; index--) {
    const declaration = declarations[index];
    if (seen.has(declaration.property)) continue;
    seen.add(declaration.property);
    result.unshift(declaration);
  }
  return result;
}

function declarationIdentity(declaration: Declaration): string {
  return [
    declaration.property,
    declaration.condition ?? '',
    declaration.pseudoElement ?? '',
    declaration.mediaQuery ?? '',
    declaration.supportsQuery ?? '',
  ].join('\0');
}

function lastDeclarationsByTarget(
  declarations: $ReadOnlyArray<Declaration>,
): $ReadOnlyArray<Declaration> {
  const seen = new Set<string>();
  const result = [];
  for (let index = declarations.length - 1; index >= 0; index--) {
    const declaration = declarations[index];
    const identity = declarationIdentity(declaration);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.unshift(declaration);
  }
  return result;
}

function expandAuthoredBoxShorthand(
  property: 'margin' | 'padding',
  value: string | number,
): $ReadOnlyArray<{ +property: string, +value: string | number }> | null {
  const values =
    typeof value === 'number' ? [value] : value.trim().split(/\s+/);
  if (
    values.length < 1 ||
    values.length > 4 ||
    values.some(
      (item) =>
        typeof item === 'string' &&
        (item === '' || /[;{}]/.test(item) || /\s/.test(item)),
    )
  ) {
    return null;
  }
  const sides =
    values.length === 1
      ? [values[0], values[0], values[0], values[0]]
      : values.length === 2
        ? [values[0], values[1], values[0], values[1]]
        : values.length === 3
          ? [values[0], values[1], values[2], values[1]]
          : values;
  const prefix = property === 'margin' ? 'margin' : 'padding';
  return ['Top', 'Right', 'Bottom', 'Left'].map((side, index) => ({
    property: `${prefix}${side}`,
    value: sides[index],
  }));
}

function readLiteralDeclarations(
  objectExpression: $FlowFixMe,
  target: DeclarationTarget = { kind: 'root' },
):
  | { +ok: true, +declarations: $ReadOnlyArray<Declaration> }
  | { +ok: false, +reason: RefusalReason } {
  const declarations: Array<Declaration> = [];
  // JavaScript evaluates every object value, including a value overwritten by
  // a duplicate key. Validate them all before retaining only the winner, or a
  // conversion could silently erase an effectful expression.
  for (const property of objectExpression.properties) {
    if (property.type === 'SpreadElement') {
      return { ok: false, reason: 'spread-in-style-object' };
    }
    if (property.type !== 'ObjectProperty') {
      return { ok: false, reason: 'non-literal-value' };
    }
    if (property.computed === true) {
      return { ok: false, reason: 'computed-style-key' };
    }
    const name = propertyName(property);
    if (name == null) {
      return { ok: false, reason: 'computed-style-key' };
    }
    const value = property.value;
    if (
      (value.type === 'StringLiteral' && typeof value.value === 'string') ||
      (value.type === 'NumericLiteral' && typeof value.value === 'number')
    ) {
      if (!SUPPORTED_PROPERTY_NAME.test(name)) {
        return { ok: false, reason: 'unsupported-property-name' };
      }
      if (typeof value.value === 'number' && !Number.isFinite(value.value)) {
        return { ok: false, reason: 'non-finite-number' };
      }
      let authoredDeclarations = [{ property: name, value: value.value }];
      if (isShorthandProperty(name)) {
        if (name !== 'margin' && name !== 'padding') {
          return { ok: false, reason: 'shorthand-property' };
        }
        const expanded = expandAuthoredBoxShorthand(name, value.value);
        if (expanded == null) {
          return { ok: false, reason: 'invalid-box-shorthand' };
        }
        authoredDeclarations = expanded;
      }
      for (const authored of authoredDeclarations) {
        let declaration: Declaration;
        if (target.kind === 'condition') {
          declaration = {
            property: authored.property,
            value: authored.value,
            condition: target.condition,
          };
        } else if (target.kind === 'pseudo-element') {
          declaration = {
            property: authored.property,
            value: authored.value,
            pseudoElement: target.pseudoElement,
          };
        } else if (target.kind === 'media-query') {
          declaration = {
            property: authored.property,
            value: authored.value,
            mediaQuery: target.mediaQuery,
          };
        } else if (target.kind === 'supports-query') {
          declaration = {
            property: authored.property,
            value: authored.value,
            supportsQuery: target.supportsQuery,
          };
        } else if (target.kind === 'supports-media-query') {
          declaration = {
            property: authored.property,
            value: authored.value,
            supportsQuery: target.supportsQuery,
            mediaQuery: target.mediaQuery,
          };
        } else {
          declaration = { property: authored.property, value: authored.value };
        }
        if (name === 'margin' || name === 'padding') {
          declaration = { ...declaration, expandedFrom: name };
        }
        declarations.push(declaration);
      }
    } else if (value.type === 'ObjectExpression') {
      return { ok: false, reason: 'nested-style-object' };
    } else if (value.type === 'TemplateLiteral') {
      return { ok: false, reason: 'template-literal-value' };
    } else {
      return { ok: false, reason: 'non-literal-value' };
    }
  }
  return {
    ok: true,
    declarations: Object.freeze(lastDeclarations(declarations)),
  };
}

function readAtRuleDeclarations(
  objectExpression: $FlowFixMe,
  atRule: string,
):
  | { +ok: true, +declarations: $ReadOnlyArray<Declaration> }
  | { +ok: false, +reason: RefusalReason } {
  const declarations: Array<Declaration> = [];
  const lastIndexes = lastPropertyIndexes(objectExpression.properties);
  for (let index = 0; index < objectExpression.properties.length; index++) {
    const property = objectExpression.properties[index];
    if (property.type === 'SpreadElement') {
      return { ok: false, reason: 'spread-in-style-object' };
    }
    if (property.type !== 'ObjectProperty') {
      return { ok: false, reason: 'non-literal-value' };
    }
    const name = propertyName(property);
    if (name == null) return { ok: false, reason: 'computed-style-key' };
    if (property.value.type === 'ObjectExpression') {
      const outerSupports = SUPPORTS_QUERY.test(atRule);
      const validInner = outerSupports
        ? MEDIA_QUERY.test(name)
        : SUPPORTS_QUERY.test(name);
      if (!validInner) return { ok: false, reason: 'nested-style-object' };
      const nested = readLiteralDeclarations(property.value, {
        kind: 'supports-media-query',
        supportsQuery: outerSupports ? atRule : name,
        mediaQuery: outerSupports ? name : atRule,
      });
      if (!nested.ok) return nested;
      if (lastIndexes.has(index)) declarations.push(...nested.declarations);
      continue;
    }
    const nested = readLiteralDeclarations(
      { properties: [property] },
      SUPPORTS_QUERY.test(atRule)
        ? { kind: 'supports-query', supportsQuery: atRule }
        : { kind: 'media-query', mediaQuery: atRule },
    );
    if (!nested.ok) return nested;
    if (lastIndexes.has(index)) declarations.push(...nested.declarations);
  }
  return { ok: true, declarations: Object.freeze(declarations) };
}

function readKeyframesValue(
  objectExpression: $FlowFixMe,
  sourceName: string,
):
  | { +ok: true, +value: StaticKeyframesValue }
  | { +ok: false, +reason: RefusalReason } {
  const frames: Array<StaticKeyframe> = [];
  const lastIndexes = lastPropertyIndexes(objectExpression.properties);
  for (let index = 0; index < objectExpression.properties.length; index++) {
    const property = objectExpression.properties[index];
    if (property.type === 'SpreadElement') {
      return { ok: false, reason: 'spread-in-style-object' };
    }
    const selector = propertyName(property);
    if (
      selector == null ||
      (selector !== 'from' && selector !== 'to') ||
      property.value?.type !== 'ObjectExpression'
    ) {
      return { ok: false, reason: 'invalid-keyframes' };
    }
    const declarations = readLiteralDeclarations(property.value);
    if (!declarations.ok) return declarations;
    if (lastIndexes.has(index)) {
      const frameDeclarations = [];
      for (const declaration of declarations.declarations) {
        if (typeof declaration.value === 'object') {
          return { ok: false, reason: 'invalid-keyframes' };
        }
        frameDeclarations.push({
          property: declaration.property,
          value: declaration.value,
        });
      }
      frames.push({ selector, declarations: frameDeclarations });
    }
  }
  if (
    frames.length !== 2 ||
    !frames.some((frame) => frame.selector === 'from') ||
    !frames.some((frame) => frame.selector === 'to')
  ) {
    return { ok: false, reason: 'invalid-keyframes' };
  }
  return {
    ok: true,
    value: {
      kind: 'keyframes',
      sourceName,
      frames: Object.freeze(
        [...frames].sort((first) => (first.selector === 'from' ? -1 : 1)),
      ),
    },
  };
}

function readDeclarations(
  objectExpression: $FlowFixMe,
): { +ok: true, +style: StyleObject } | { +ok: false, +reason: RefusalReason } {
  const declarations: Array<Declaration> = [];
  const keyframes: Array<StaticKeyframesValue> = [];
  const lastIndexes = lastPropertyIndexes(objectExpression.properties);
  for (let index = 0; index < objectExpression.properties.length; index++) {
    const property = objectExpression.properties[index];
    if (property.type === 'SpreadElement') {
      return { ok: false, reason: 'spread-in-style-object' };
    }
    if (property.type !== 'ObjectProperty') {
      return { ok: false, reason: 'non-literal-value' };
    }
    if (property.computed === true) {
      return { ok: false, reason: 'computed-style-key' };
    }
    const name = propertyName(property);
    if (name == null) {
      return { ok: false, reason: 'computed-style-key' };
    }
    if (property.value.type === 'ObjectExpression') {
      const keyframesMatch = name.match(KEYFRAMES);
      if (keyframesMatch != null) {
        const read = readKeyframesValue(property.value, keyframesMatch[1]);
        if (!read.ok) return read;
        if (lastIndexes.has(index)) keyframes.push(read.value);
        continue;
      }
      if (
        !SUPPORTED_CONDITIONS.has(name) &&
        !SUPPORTED_PSEUDO_ELEMENTS.has(name) &&
        !MEDIA_QUERY.test(name) &&
        !SUPPORTS_QUERY.test(name)
      ) {
        return { ok: false, reason: 'unsupported-condition' };
      }
      const nested = SUPPORTED_CONDITIONS.has(name)
        ? readLiteralDeclarations(property.value, {
            kind: 'condition',
            condition: name === ':hover' ? ':hover' : ':focus',
          })
        : SUPPORTED_PSEUDO_ELEMENTS.has(name)
          ? readLiteralDeclarations(property.value, {
              kind: 'pseudo-element',
              pseudoElement: name === '::before' ? '::before' : '::after',
            })
          : MEDIA_QUERY.test(name) || SUPPORTS_QUERY.test(name)
            ? readAtRuleDeclarations(property.value, name)
            : readLiteralDeclarations(property.value, {
                kind: 'media-query',
                mediaQuery: name,
              });
      if (!nested.ok) return nested;
      // A later duplicate selector key replaces this entire object. The
      // earlier object was still evaluated, so it was validated above even
      // though none of its declarations survive.
      if (lastIndexes.has(index)) {
        declarations.push(...nested.declarations);
      }
      continue;
    }
    const ordinary = readLiteralDeclarations({ properties: [property] });
    if (!ordinary.ok) return ordinary;
    if (lastIndexes.has(index)) {
      declarations.push(...ordinary.declarations);
    }
  }
  if (
    declarations.some((declaration) => declaration.condition != null) &&
    declarations.some((declaration) => declaration.pseudoElement != null)
  ) {
    return { ok: false, reason: 'mixed-condition-and-pseudo-element' };
  }
  const mediaQueries = new Set(
    declarations.flatMap((declaration) =>
      declaration.mediaQuery == null ? [] : [declaration.mediaQuery],
    ),
  );
  if (mediaQueries.size > 1) {
    return { ok: false, reason: 'multiple-media-queries' };
  }
  const supportsQueries = new Set(
    declarations.flatMap((declaration) =>
      declaration.supportsQuery == null ? [] : [declaration.supportsQuery],
    ),
  );
  if (supportsQueries.size > 1) {
    return { ok: false, reason: 'multiple-supports-queries' };
  }
  if (
    (mediaQueries.size > 0 || supportsQueries.size > 0) &&
    declarations.some(
      (declaration) =>
        declaration.condition != null || declaration.pseudoElement != null,
    )
  ) {
    return { ok: false, reason: 'mixed-media-query-modifier' };
  }
  if (keyframes.length > 1) {
    return { ok: false, reason: 'multiple-keyframes' };
  }
  if (
    declarations.some((declaration) => declaration.expandedFrom != null) &&
    declarations.some(
      (declaration) =>
        declaration.condition != null ||
        declaration.pseudoElement != null ||
        declaration.mediaQuery != null ||
        declaration.supportsQuery != null,
    )
  ) {
    return { ok: false, reason: 'mixed-shorthand-modifier' };
  }
  if (keyframes.length === 1) {
    if (
      declarations.some(
        (declaration) =>
          declaration.condition != null ||
          declaration.pseudoElement != null ||
          declaration.mediaQuery != null ||
          declaration.supportsQuery != null,
      )
    ) {
      return { ok: false, reason: 'mixed-keyframes-modifier' };
    }
    const animationNames = declarations.filter(
      (declaration) => declaration.property === 'animationName',
    );
    if (
      animationNames.length !== 1 ||
      animationNames[0].value !== keyframes[0].sourceName
    ) {
      return { ok: false, reason: 'missing-keyframes-reference' };
    }
    const withKeyframes = lastDeclarationsByTarget(declarations).map(
      (declaration) =>
        declaration === animationNames[0]
          ? { ...declaration, value: keyframes[0] }
          : declaration,
    );
    return { ok: true, style: styleObject(withKeyframes) };
  }
  return {
    ok: true,
    style: styleObject(lastDeclarationsByTarget(declarations)),
  };
}

function discoverActive(ast: $FlowFixMe): DiscoveryResult {
  const sites: Array<EmotionSite> = [];
  const refusals: Array<EmotionRefusal> = [];

  walk(ast, (node) => {
    if (node.type !== 'JSXOpeningElement') {
      return;
    }
    const attributes = node.attributes ?? [];
    const cssAttributes = attributes.filter(
      (attribute) =>
        attribute.type === 'JSXAttribute' &&
        attribute.name != null &&
        attribute.name.type === 'JSXIdentifier' &&
        attribute.name.name === 'css',
    );
    if (cssAttributes.length === 0) {
      return;
    }

    const rawName = elementNameOf(node);
    const elementName = rawName ?? '(expression)';

    if (cssAttributes.length > 1) {
      refusals.push({
        start: cssAttributes[0].start,
        end: cssAttributes[cssAttributes.length - 1].end,
        elementName,
        reason: 'duplicate-css-prop',
      });
      return;
    }
    const attribute = cssAttributes[0];

    if (rawName == null || !isHostElementName(rawName)) {
      // Styling a component means the class has to reach whatever that
      // component does with `className`, which cannot be established from this
      // file alone.
      refusals.push({
        start: attribute.start,
        end: attribute.end,
        elementName,
        reason: 'css-on-component',
      });
      return;
    }

    const collides = attributes.some(
      (other) =>
        other.type === 'JSXAttribute' &&
        other.name != null &&
        other.name.type === 'JSXIdentifier' &&
        (other.name.name === 'className' || other.name.name === 'style'),
    );
    if (collides) {
      refusals.push({
        start: attribute.start,
        end: attribute.end,
        elementName,
        reason: 'css-with-class-or-style-prop',
      });
      return;
    }

    // A sibling spread can carry `className` or `style` whose values are only
    // known at runtime. Emotion's JSX runtime merges those with the `css` prop;
    // `stylex.props` would overwrite them. Whether that changes the result
    // depends on what the spread contains, which makes the site contextual
    // rather than mechanical — and a CSS comparison cannot establish
    // prop-merging equivalence.
    if (attributes.some((other) => other.type === 'JSXSpreadAttribute')) {
      refusals.push({
        start: attribute.start,
        end: attribute.end,
        elementName,
        reason: 'css-with-jsx-spread',
      });
      return;
    }

    const container = attribute.value;
    if (
      container == null ||
      container.type !== 'JSXExpressionContainer' ||
      container.expression == null ||
      container.expression.type !== 'ObjectExpression'
    ) {
      refusals.push({
        start: attribute.start,
        end: attribute.end,
        elementName,
        reason: 'css-prop-not-object-literal',
      });
      return;
    }

    const read = readDeclarations(container.expression);
    if (!read.ok) {
      refusals.push({
        start: attribute.start,
        end: attribute.end,
        elementName,
        reason: read.reason,
      });
      return;
    }

    sites.push({
      start: attribute.start,
      end: attribute.end,
      objectStart: container.expression.start,
      objectEnd: container.expression.end,
      elementName: rawName,
      style: read.style,
    });
  });

  const byPosition = (a: { +start: number, ... }, b: { +start: number, ... }) =>
    a.start - b.start;

  return Object.freeze({
    usesEmotion: true,
    sites: Object.freeze([...sites].sort(byPosition)),
    refusals: Object.freeze([...refusals].sort(byPosition)),
  });
}

/** Inspect `css` syntax without making an activation claim. */
export function discoverSyntax(ast: $FlowFixMe): DiscoveryResult {
  return discoverActive(ast);
}

export function discover(ast: $FlowFixMe): DiscoveryResult {
  if (!usesEmotion(ast)) {
    return Object.freeze({
      usesEmotion: false,
      sites: Object.freeze([]),
      refusals: Object.freeze([]),
    });
  }
  return discoverActive(ast);
}

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
import type { Declaration, StyleObject } from '../../static/ir';

/**
 * Emotion discovery for the mechanical lane.
 *
 * The supported shape in M2 is intentionally the least interesting one that
 * exists: a `css` prop holding an object literal, on a plain HTML element, with
 * literal keys and literal values. Everything else is refused with a reason.
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
  | 'template-literal-value'
  | 'non-literal-value'
  | 'css-with-class-or-style-prop'
  | 'duplicate-css-prop'
  | 'unsupported-property-name'
  | 'shorthand-property'
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

/**
 * Shorthands are refused wholesale in M2.
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
 * M3 admits shorthands with a comparison model that understands the
 * interaction. Until then the honest answer is a refusal.
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

function readDeclarations(
  objectExpression: $FlowFixMe,
): { +ok: true, +style: StyleObject } | { +ok: false, +reason: RefusalReason } {
  const declarations: Array<Declaration> = [];
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

    const key = property.key;
    let name: string;
    if (key.type === 'Identifier' && typeof key.name === 'string') {
      name = key.name;
    } else if (key.type === 'StringLiteral' && typeof key.value === 'string') {
      name = key.value;
    } else {
      return { ok: false, reason: 'computed-style-key' };
    }
    // The value is classified before the name, because when the value is a
    // nested block the key is a selector rather than a property, and
    // "unsupported property name" would be a misleading way to say
    // "conditions are not supported yet".
    const value = property.value;
    if (
      (value.type === 'StringLiteral' && typeof value.value === 'string') ||
      (value.type === 'NumericLiteral' && typeof value.value === 'number')
    ) {
      if (!SUPPORTED_PROPERTY_NAME.test(name)) {
        return { ok: false, reason: 'unsupported-property-name' };
      }
      if (isShorthandProperty(name)) {
        return { ok: false, reason: 'shorthand-property' };
      }
      // `1e999` is a numeric literal that parses to Infinity, which has no
      // style meaning and cannot be emitted back as source.
      if (typeof value.value === 'number' && !Number.isFinite(value.value)) {
        return { ok: false, reason: 'non-finite-number' };
      }
      declarations.push({ property: name, value: value.value });
    } else if (value.type === 'ObjectExpression') {
      return { ok: false, reason: 'nested-style-object' };
    } else if (value.type === 'TemplateLiteral') {
      return { ok: false, reason: 'template-literal-value' };
    } else {
      // Identifiers, calls, member expressions, unary minus and everything
      // else: their CSS meaning cannot be established without running the
      // program, so the mechanical lane does not touch them.
      return { ok: false, reason: 'non-literal-value' };
    }
  }
  return { ok: true, style: styleObject(lastWins(declarations)) };
}

/**
 * `{color: 'red', color: 'blue'}` is a single-property object by the time any
 * styling library sees it — the engine resolves the duplicate before Emotion is
 * called. Keeping only the last occurrence reproduces that, rather than
 * inventing a second declaration that never existed at runtime.
 */
function lastWins(
  declarations: $ReadOnlyArray<Declaration>,
): $ReadOnlyArray<Declaration> {
  const seenLater = new Set<string>();
  const result: Array<Declaration> = [];
  for (let i = declarations.length - 1; i >= 0; i--) {
    const declaration = declarations[i];
    if (seenLater.has(declaration.property)) {
      continue;
    }
    seenLater.add(declaration.property);
    result.unshift(declaration);
  }
  return result;
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

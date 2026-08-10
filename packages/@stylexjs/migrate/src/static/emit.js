/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import type {
  Declaration,
  PseudoElement,
  StaticValue,
  StyleObject,
} from './ir';

/**
 * Turning the neutral representation into StyleX source text.
 *
 * Output is plain text rather than a printed AST, so the rest of each file
 * stays byte-for-byte untouched. A pretty-printer would reformat code it was
 * never asked to change, which turns every review into a hunt for the real
 * edit.
 */

export type StyleEntry = {
  +key: string,
  +style: StyleObject,
  // Callers carry their own bookkeeping on these; emission reads only the two
  // fields above.
  ...
};

export const STYLEX_MODULE: string = '@stylexjs/stylex';

const SHORT_ESCAPES: { +[string]: string } = {
  '\\': '\\\\',
  "'": "\\'",
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
  '\v': '\\v',
};

// Control characters, quote, backslash, and the two line separators that are
// legal in a string but not in every consumer of one. Matching control
// characters is the entire point here, so the rule against it does not apply.
// eslint-disable-next-line no-control-regex
const NEEDS_ESCAPE = /[\\'\u0000-\u001f\u007f\u2028\u2029]/g;

/**
 * Serialize a value as JavaScript source.
 *
 * A style value is arbitrary text from the user's code, so this has to produce
 * a valid literal for anything a string can hold. Escaping only quotes and
 * backslashes was not enough: `content: "a\nb"` is a perfectly ordinary style,
 * and emitting its newline raw produces source that does not parse.
 *
 * `\0` is deliberately not used as a short escape, because `\0` followed by a
 * digit is a legacy octal escape and would change the value.
 */
export function serializeValue(value: StaticValue): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(
        `Cannot emit the non-finite number ${String(value)} as a style value.`,
      );
    }
    return String(value);
  }
  const escaped = value.replace(NEEDS_ESCAPE, (character) => {
    const short = SHORT_ESCAPES[character];
    if (short != null) {
      return short;
    }
    const code = character.charCodeAt(0).toString(16).padStart(4, '0');
    return `\\u${code}`;
  });
  return `'${escaped}'`;
}

/**
 * Keys are emitted in alphabetical order.
 *
 * This is only safe because the supported subset excludes shorthands: with
 * every declaration addressing an independent property, no ordering of them
 * can change the result, and sorted keys satisfy StyleX's own lint rule without
 * anyone having to run an autofix over the file.
 */
function sortedProperties(
  declarations: $ReadOnlyArray<Declaration>,
): $ReadOnlyArray<string> {
  return [
    ...new Set(declarations.map((declaration) => declaration.property)),
  ].sort();
}

function declarationLines(
  input: $ReadOnlyArray<Declaration>,
  indent: string,
): $ReadOnlyArray<string> {
  return sortedProperties(input).flatMap((property) => {
    const declarations = input.filter(
      (declaration) => declaration.property === property,
    );
    if (
      declarations.every(
        (declaration) =>
          declaration.condition == null &&
          declaration.mediaQuery == null &&
          declaration.supportsQuery == null,
      )
    ) {
      const declaration = declarations[declarations.length - 1];
      return [`${indent}  ${property}: ${serializeValue(declaration.value)},`];
    }
    // StyleX's lint contract requires this key order. Semantic comparison does
    // not trust it: the referee still uses Emotion's authored source order and
    // StyleX's observed compiler priorities.
    const conditionOrder = new Map([
      ['default', 0],
      [':hover', 1],
      [':focus', 2],
    ]);
    const modifier = (declaration: Declaration): string =>
      declaration.condition ?? declaration.mediaQuery ?? 'default';
    if (declarations.some((declaration) => declaration.supportsQuery != null)) {
      const root = declarations.find(
        (declaration) =>
          declaration.supportsQuery == null &&
          declaration.mediaQuery == null &&
          declaration.condition == null,
      );
      const supportsOnly = declarations.find(
        (declaration) =>
          declaration.supportsQuery != null && declaration.mediaQuery == null,
      );
      const mediaOnly = declarations.find(
        (declaration) =>
          declaration.supportsQuery == null && declaration.mediaQuery != null,
      );
      const intersection = declarations.find(
        (declaration) =>
          declaration.supportsQuery != null && declaration.mediaQuery != null,
      );
      const lines = [`${indent}  ${property}: {`];
      if (root != null) {
        lines.push(`${indent}    default: ${serializeValue(root.value)},`);
      }
      if (supportsOnly != null || intersection != null) {
        const supportsQuery = (supportsOnly ?? intersection)?.supportsQuery;
        if (supportsQuery == null) throw new Error('missing supports query');
        if (intersection == null) {
          lines.push(
            `${indent}    ${serializeValue(supportsQuery)}: ${serializeValue(supportsOnly?.value ?? '')},`,
          );
        } else {
          lines.push(`${indent}    ${serializeValue(supportsQuery)}: {`);
          if (supportsOnly != null) {
            lines.push(
              `${indent}      default: ${serializeValue(supportsOnly.value)},`,
            );
          }
          lines.push(
            `${indent}      ${serializeValue(intersection.mediaQuery ?? '')}: ${serializeValue(intersection.value)},`,
            `${indent}    },`,
          );
        }
      }
      if (mediaOnly != null) {
        lines.push(
          `${indent}    ${serializeValue(mediaOnly.mediaQuery ?? '')}: ${serializeValue(mediaOnly.value)},`,
        );
      }
      lines.push(`${indent}  },`);
      return lines;
    }
    const values = [...declarations]
      .sort(
        (first, second) =>
          (conditionOrder.get(modifier(first)) ?? 99) -
          (conditionOrder.get(modifier(second)) ?? 99),
      )
      .map((declaration) => {
        const condition = modifier(declaration);
        const key =
          condition === 'default' ? condition : serializeValue(condition);
        return `${indent}    ${key}: ${serializeValue(declaration.value)},`;
      });
    return [`${indent}  ${property}: {`, ...values, `${indent}  },`];
  });
}

export function emitStyleObject(style: StyleObject, indent: string): string {
  const rootDeclarations = style.declarations.filter(
    (declaration) => declaration.pseudoElement == null,
  );
  const lines = [...declarationLines(rootDeclarations, indent)];
  const pseudoElements: $ReadOnlyArray<PseudoElement> = ['::after', '::before'];
  for (const pseudoElement of pseudoElements) {
    const declarations = style.declarations.filter(
      (declaration) => declaration.pseudoElement === pseudoElement,
    );
    if (declarations.length === 0) continue;
    lines.push(
      `${indent}  '${pseudoElement}': {`,
      ...declarationLines(declarations, `${indent}  `),
      `${indent}  },`,
    );
  }
  return `{\n${lines.join('\n')}\n${indent}}`;
}

export function emitCreateCall(
  namespace: string,
  registryName: string,
  entries: $ReadOnlyArray<StyleEntry>,
): string {
  const body = entries
    .map((entry) => `  ${entry.key}: ${emitStyleObject(entry.style, '  ')},`)
    .join('\n');
  return `const ${registryName} = ${namespace}.create({\n${body}\n});`;
}

export function emitPropsSpread(
  namespace: string,
  registryName: string,
  key: string,
): string {
  return `{...${namespace}.props(${registryName}.${key})}`;
}

export function emitImport(namespace: string): string {
  return `import * as ${namespace} from '${STYLEX_MODULE}';`;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Turn a JSX tag name into something that can be an object key and a property
 * access.
 *
 * A tag is not an identifier. `my-button` is a valid custom element and would
 * emit `styles.my-button`, which is a subtraction. Dots and dashes are folded
 * into camelCase, anything else is dropped, and a name that survives as
 * nothing falls back to a fixed prefix.
 */
export function sanitizeKey(elementName: string): string {
  const camel = elementName
    .split(/[^A-Za-z0-9_$]+/)
    .filter((part) => part !== '')
    .map((part, index) =>
      index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join('');
  if (camel === '' || !IDENTIFIER.test(camel)) {
    return `style${camel.replace(/^[^A-Za-z_$]+/, '')}`;
  }
  return camel;
}

/**
 * Style keys are named after the element they came from, so a reviewer reading
 * `styles.button` can tell what it belongs to.
 *
 * Suffixes are allocated against every key already handed out, not against a
 * per-name counter. Counting per name collides: `div`, `div2`, `div` used to
 * produce `div`, `div2`, `div2`, where the second entry silently replaced the
 * first in the registry and two elements shared one style.
 */
export function allocateKeys(
  elementNames: $ReadOnlyArray<string>,
): $ReadOnlyArray<string> {
  const used = new Set<string>();
  return elementNames.map((name) => {
    const base = sanitizeKey(name);
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    let suffix = 2;
    while (used.has(`${base}${suffix}`)) {
      suffix++;
    }
    const key = `${base}${suffix}`;
    used.add(key);
    return key;
  });
}

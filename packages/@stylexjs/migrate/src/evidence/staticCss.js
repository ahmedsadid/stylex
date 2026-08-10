/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { compileStyleX } from './compile';
import { parseSource } from '../static/parse';
import { walk } from '../static/walk';
import { parseRule } from '../compare/model';
import { observeStyleXRules } from '../referee/observations';
import { observeStyleXKeyframes } from '../referee/keyframes';
import type { CssDeclaration } from '../compare/model';
import type { CascadeObservation } from '../referee/observations';
import type { KeyframesObservation } from '../referee/keyframes';

/**
 * The CSS StyleX actually produces for one style key.
 *
 * The registry text handed in here is sliced out of the converted file rather
 * than re-generated, so what gets measured is the code that would be written,
 * not a second rendering of the same intent that could differ from it.
 *
 * A style key is isolated by compiling a probe module that declares that
 * registry and reads exactly one entry from it. StyleX inlines the resulting
 * class names, which gives an unambiguous mapping from one key to its rules —
 * the compiled application file cannot provide that, because by then the
 * registry has been erased and only class strings remain.
 */

export type StyleXCssResult =
  | {
      +ok: true,
      +classNames: $ReadOnlyArray<string>,
      +declarations: $ReadOnlyArray<CssDeclaration>,
    }
  | { +ok: false, +reason: string };

function probeClassNames(compiledCode: string): $ReadOnlyArray<string> | null {
  const parsed = parseSource(compiledCode, 'probe-output.js');
  if (!parsed.ok) {
    return null;
  }
  let classNames = null;
  walk(parsed.ast, (node) => {
    if (
      node.type !== 'VariableDeclarator' ||
      node.id == null ||
      node.id.name !== 'probe' ||
      node.init == null ||
      node.init.type !== 'ObjectExpression'
    ) {
      return;
    }
    for (const property of node.init.properties ?? []) {
      if (
        property.type === 'ObjectProperty' &&
        property.key != null &&
        (property.key.name === 'className' ||
          property.key.value === 'className') &&
        property.value != null &&
        property.value.type === 'StringLiteral'
      ) {
        classNames = String(property.value.value)
          .split(/\s+/)
          .filter((name) => name !== '');
      }
    }
  });
  // A style object that produces nothing compiles to an object with no
  // className at all, which is an empty class list rather than a failure.
  return classNames ?? [];
}

export function stylexCssForKey({
  importText,
  registryName,
  createCallText,
  namespace,
  key,
}: {
  +importText: string,
  +registryName: string,
  +createCallText: string,
  +namespace: string,
  +key: string,
}): StyleXCssResult {
  const probe = [
    importText,
    `const ${registryName} = ${createCallText};`,
    `export const probe = ${namespace}.props(${registryName}.${key});`,
    '',
  ].join('\n');

  const compiled = compileStyleX(probe, 'probe.js');
  if (!compiled.ok) {
    return { ok: false, reason: compiled.reason };
  }

  const classNames = probeClassNames(compiled.code);
  if (classNames == null) {
    return { ok: false, reason: 'could not read the compiled probe output' };
  }

  const declarations: Array<CssDeclaration> = [];
  for (const className of classNames) {
    const rule = compiled.rules.get(className);
    if (rule == null) {
      return {
        ok: false,
        reason: `StyleX referenced class ${className} but generated no rule for it`,
      };
    }
    const parsed = parseRule(rule);
    if (!parsed.ok) {
      // CSS the comparison model cannot represent must stop the comparison
      // rather than contribute nothing to it.
      return {
        ok: false,
        reason: `could not read the rule StyleX generated for ${className}: ${parsed.reason}`,
      };
    }
    for (const declaration of parsed.declarations) {
      declarations.push(declaration);
    }
  }

  return { ok: true, classNames, declarations };
}

export function stylexCascadeForKey({
  importText,
  registryName,
  createCallText,
  namespace,
  key,
}: {
  +importText: string,
  +registryName: string,
  +createCallText: string,
  +namespace: string,
  +key: string,
}): CascadeObservation {
  const probe = [
    importText,
    `const ${registryName} = ${createCallText};`,
    `export const probe = ${namespace}.props(${registryName}.${key});`,
    '',
  ].join('\n');
  const compiled = compileStyleX(probe, 'cascade-probe.js');
  if (!compiled.ok) return compiled;
  const classNames = probeClassNames(compiled.code);
  if (classNames == null) {
    return { ok: false, reason: 'could not read the compiled cascade probe' };
  }
  const rules = new Map(
    compiled.ruleMetadata.map((rule) => [rule.className, rule]),
  );
  const selected = [];
  for (const className of classNames) {
    const rule = rules.get(className);
    if (rule == null) {
      return {
        ok: false,
        reason: `StyleX referenced class ${className} but generated no cascade rule`,
      };
    }
    selected.push(rule);
  }
  return observeStyleXRules(selected);
}

export function stylexKeyframesForKey({
  importText,
  registryName,
  createCallText,
  namespace,
  key,
}: {
  +importText: string,
  +registryName: string,
  +createCallText: string,
  +namespace: string,
  +key: string,
}):
  | {
      +ok: true,
      +classNames: $ReadOnlyArray<string>,
      +observation: KeyframesObservation,
    }
  | { +ok: false, +reason: string } {
  const probe = [
    importText,
    `const ${registryName} = ${createCallText};`,
    `export const probe = ${namespace}.props(${registryName}.${key});`,
    '',
  ].join('\n');
  const compiled = compileStyleX(probe, 'keyframes-probe.js');
  if (!compiled.ok) return compiled;
  const classNames = probeClassNames(compiled.code);
  if (classNames == null) {
    return { ok: false, reason: 'could not read compiled keyframes classes' };
  }
  const observed = observeStyleXKeyframes(probe, 'keyframes-probe.js');
  return observed.ok
    ? { ok: true, classNames, observation: observed.observation }
    : observed;
}

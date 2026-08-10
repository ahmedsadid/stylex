/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { convertSource } from '../adapters/emotion/convert';
import { emotionBaseline } from '../adapters/emotion/baseline';
import { compileStyleX } from '../evidence/compile';
import { describeLintMessages, lintStyleX } from '../evidence/lint';
import { stylexCssForKey } from '../evidence/staticCss';
import { allPassed, evidence, packageVersion } from '../evidence/claims';
import {
  COMPARISON_MODEL,
  compareDeclarations,
  describeDifferences,
} from '../compare/model';
import { parseSource } from '../static/parse';
import { walk } from '../static/walk';
import { STYLEX_MODULE } from '../static/emit';
import type { Claim, EvidenceResult } from '../evidence/claims';
import type { EmotionRefusal } from '../adapters/emotion/discover';
import type { ConvertedOutcome } from '../adapters/emotion/convert';

/**
 * The mechanical proposer, with its checks in the path.
 *
 * This is the only exported way to convert an Emotion file, and it cannot
 * return converted code without having compared that code's CSS against
 * Emotion's own. The previous generation of this tool kept the equivalent
 * checks in its test suite while the command that wrote files skipped them:
 * the tests were green and the tool shipped unchecked output. Here a failed
 * comparison is a refusal, and there is no path around it.
 *
 * A failure refuses the whole file rather than the one site. Per-site
 * isolation is a real improvement and it is a later milestone; until then, the
 * conservative answer is the honest one.
 */

const STYLEX_PROVIDER = '@stylexjs/babel-plugin';
const EMOTION_PROVIDER = '@emotion/serialize';
const STYLEX_LINT_PROVIDER = '@stylexjs/eslint-plugin';

export type ProposedEntry = {
  +key: string,
  +elementName: string,
  +classNames: $ReadOnlyArray<string>,
};

export type Proposal =
  | {
      +status: 'proposed',
      +code: string,
      +claim: Claim,
      +model: string,
      +entries: $ReadOnlyArray<ProposedEntry>,
      +refusals: $ReadOnlyArray<EmotionRefusal>,
      +evidence: $ReadOnlyArray<EvidenceResult>,
      +uncovered: $ReadOnlyArray<string>,
    }
  | {
      +status: 'refused',
      +reason: string,
      +evidence: $ReadOnlyArray<EvidenceResult>,
    }
  | {
      +status: 'unchanged',
      +reason: string,
      +refusals: $ReadOnlyArray<EmotionRefusal>,
    };

type Structure = {
  +importText: string,
  +createCallText: string,
};

/**
 * Read back the pieces of the converted file that the comparison needs, and
 * confirm the file wires them together the way it claims to.
 *
 * Slicing the emitted text out of the output — rather than re-generating it —
 * means the comparison measures the code that would actually be written.
 */
function readStructure(
  code: string,
  filename: string,
  namespace: string,
  registryName: string,
  expectedKeys: $ReadOnlyArray<string>,
): { +ok: true, +structure: Structure } | { +ok: false, +reason: string } {
  const parsed = parseSource(code, filename);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: `generated code does not parse: ${parsed.reason}`,
    };
  }

  let importText = null;
  let createCallText = null;
  const referencedKeys: Array<string> = [];

  walk(parsed.ast, (node) => {
    if (
      node.type === 'ImportDeclaration' &&
      node.source != null &&
      node.source.value === STYLEX_MODULE
    ) {
      const local = (node.specifiers ?? []).find(
        (specifier) =>
          specifier.type === 'ImportNamespaceSpecifier' ||
          specifier.type === 'ImportDefaultSpecifier',
      );
      if (local != null && local.local?.name === namespace) {
        importText = code.slice(node.start, node.end);
      }
    }

    if (
      node.type === 'VariableDeclarator' &&
      node.id?.name === registryName &&
      node.init?.type === 'CallExpression' &&
      node.init.callee?.type === 'MemberExpression' &&
      node.init.callee.object?.name === namespace &&
      node.init.callee.property?.name === 'create'
    ) {
      createCallText = code.slice(node.init.start, node.init.end);
    }

    if (
      node.type === 'JSXSpreadAttribute' &&
      node.argument?.type === 'CallExpression' &&
      node.argument.callee?.type === 'MemberExpression' &&
      node.argument.callee.object?.name === namespace &&
      node.argument.callee.property?.name === 'props'
    ) {
      const argument = (node.argument.arguments ?? [])[0];
      if (
        argument != null &&
        argument.type === 'MemberExpression' &&
        argument.object?.name === registryName &&
        typeof argument.property?.name === 'string'
      ) {
        referencedKeys.push(argument.property.name);
      }
    }
  });

  if (importText == null) {
    return {
      ok: false,
      reason: `generated code has no import of ${STYLEX_MODULE} bound to "${namespace}"`,
    };
  }
  if (createCallText == null) {
    return {
      ok: false,
      reason: `generated code has no "${registryName} = ${namespace}.create(...)" registry`,
    };
  }

  const expected = [...expectedKeys].sort();
  const referenced = [...referencedKeys].sort();
  if (expected.join(',') !== referenced.join(',')) {
    return {
      ok: false,
      reason:
        'generated code does not reference the styles it defines ' +
        `(expected ${expected.join(', ')}; found ${referenced.join(', ') || 'none'})`,
    };
  }

  return { ok: true, structure: { importText, createCallText } };
}

/**
 * Run the checks over a conversion.
 *
 * Taking the converted code as an argument rather than producing it here is
 * what makes the checks testable against deliberately corrupted output: a
 * mutation test can hand this function a proposal with one property renamed
 * and confirm it is refused. A checker that has only ever seen correct input
 * has not been tested.
 */
export function verifyConversion({
  source,
  filename,
  converted,
}: {
  +source: string,
  +filename: string,
  +converted: ConvertedOutcome,
}): Proposal {
  const results: Array<EvidenceResult> = [];
  const scope = [filename];

  // 1. The generated file compiles through StyleX's own compiler.
  const compiled = compileStyleX(converted.code, filename);
  results.push(
    evidence({
      check: 'stylex-compile',
      provider: STYLEX_PROVIDER,
      scope,
      result: compiled.ok ? 'pass' : 'fail',
      ...(compiled.ok ? {} : { detail: compiled.reason }),
    }),
  );
  if (!compiled.ok) {
    return { status: 'refused', reason: compiled.reason, evidence: results };
  }

  // 2. The generated styles are in the form StyleX's own rules expect, with no
  //    autofix left over.
  const linted = lintStyleX(converted.code, filename);
  results.push(
    evidence({
      check: 'stylex-lint',
      provider: STYLEX_LINT_PROVIDER,
      scope,
      result: linted.ok ? 'pass' : 'fail',
      ...(linted.ok ? {} : { detail: describeLintMessages(linted.messages) }),
      limitations: [
        'only @stylexjs rules were run; the repository lint setup was not',
      ],
    }),
  );
  if (!linted.ok) {
    return {
      status: 'refused',
      reason: `StyleX lint rejected the output: ${describeLintMessages(linted.messages)}`,
      evidence: results,
    };
  }

  // 3. The generated file wires its own pieces together.
  const structure = readStructure(
    converted.code,
    filename,
    converted.namespace,
    converted.registryName,
    converted.entries.map((entry) => entry.key),
  );
  results.push(
    evidence({
      check: 'binding-integrity',
      provider: 'stylex-migrate',
      scope,
      result: structure.ok ? 'pass' : 'fail',
      ...(structure.ok ? {} : { detail: structure.reason }),
    }),
  );
  if (!structure.ok) {
    return { status: 'refused', reason: structure.reason, evidence: results };
  }

  // 4. Per site: Emotion's CSS for the original object against StyleX's CSS
  //    for what replaced it.
  const entries: Array<ProposedEntry> = [];
  for (const entry of converted.entries) {
    const objectSource = source.slice(
      entry.site.objectStart,
      entry.site.objectEnd,
    );
    const baseline = emotionBaseline(objectSource);
    if (!baseline.ok) {
      results.push(
        evidence({
          check: 'static-css-comparison',
          provider: EMOTION_PROVIDER,
          scope: [`${filename}#${entry.key}`],
          result: 'unavailable',
          detail: baseline.reason,
        }),
      );
      return {
        status: 'refused',
        reason: `no Emotion baseline for ${entry.key}: ${baseline.reason}`,
        evidence: results,
      };
    }

    const target = stylexCssForKey({
      importText: structure.structure.importText,
      registryName: converted.registryName,
      createCallText: structure.structure.createCallText,
      namespace: converted.namespace,
      key: entry.key,
    });
    if (!target.ok) {
      results.push(
        evidence({
          check: 'static-css-comparison',
          provider: STYLEX_PROVIDER,
          scope: [`${filename}#${entry.key}`],
          result: 'unavailable',
          detail: target.reason,
        }),
      );
      return {
        status: 'refused',
        reason: `no StyleX result for ${entry.key}: ${target.reason}`,
        evidence: results,
      };
    }

    const comparison = compareDeclarations(
      baseline.declarations,
      target.declarations,
    );
    results.push(
      evidence({
        check: 'static-css-comparison',
        provider: 'stylex-migrate',
        scope: [`${filename}#${entry.key}`],
        result: comparison.equal ? 'pass' : 'fail',
        ...(comparison.equal
          ? {}
          : { detail: describeDifferences(comparison.differences) }),
        limitations: [
          `compared under model ${COMPARISON_MODEL}`,
          `source CSS from ${EMOTION_PROVIDER} ${packageVersion(EMOTION_PROVIDER)}, ` +
            `target CSS from ${STYLEX_PROVIDER} ${packageVersion(STYLEX_PROVIDER)}`,
          'declaration-level comparison only: no runtime, no cascade with other rules',
        ],
      }),
    );
    if (!comparison.equal) {
      return {
        status: 'refused',
        reason:
          `CSS differs for ${entry.key}: ` +
          describeDifferences(comparison.differences),
        evidence: results,
      };
    }

    entries.push({
      key: entry.key,
      elementName: entry.site.elementName,
      classNames: target.classNames,
    });
  }

  if (!allPassed(results)) {
    return {
      status: 'refused',
      reason: 'one or more checks did not pass',
      evidence: results,
    };
  }

  return {
    status: 'proposed',
    code: converted.code,
    claim: 'static-equivalent',
    model: COMPARISON_MODEL,
    entries,
    refusals: converted.refusals,
    evidence: results,
    uncovered: [
      'no runtime evidence: nothing was rendered',
      'the source styling library import and JSX pragma were left in place and were not exercised',
      ...(converted.refusals.length > 0
        ? [
            `${converted.refusals.length} site(s) in this file were not converted`,
          ]
        : []),
    ],
  };
}

/**
 * Convert one Emotion file, and return the result only if the checks agree.
 *
 * This is the entry point. There is no exported path that converts without
 * verifying.
 */
export function proposeStaticConversion({
  source,
  filename,
}: {
  +source: string,
  +filename: string,
}): Proposal {
  const converted = convertSource(source, filename);

  if (converted.status === 'unchanged') {
    return {
      status: 'unchanged',
      reason: converted.reason,
      refusals: converted.refusals,
    };
  }
  if (converted.status === 'refused') {
    return { status: 'refused', reason: converted.reason, evidence: [] };
  }

  return verifyConversion({ source, filename, converted });
}

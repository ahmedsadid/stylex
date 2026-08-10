/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { convertSource } from '../adapters/emotion/convert';
import {
  emotionBaseline,
  emotionConditionalBaseline,
  emotionKeyframesBaseline,
  emotionMediaQueryBaseline,
  emotionPseudoElementBaseline,
  emotionSupportsNestingBaseline,
} from '../adapters/emotion/baseline';
import { compileStyleX } from '../evidence/compile';
import { describeLintMessages, lintStyleX } from '../evidence/lint';
import {
  stylexCascadeForKey,
  stylexCssForKey,
  stylexKeyframesForKey,
} from '../evidence/staticCss';
import { allPassed, evidence, packageVersion } from '../evidence/claims';
import { hashString } from '../kernel/hash';
import {
  COMPARISON_MODEL,
  compareDeclarations,
  describeDifferences,
} from '../compare/model';
import { parseSource } from '../static/parse';
import { walk } from '../static/walk';
import { STYLEX_MODULE } from '../static/emit';
import {
  hasConditions,
  hasKeyframes,
  hasMediaQueries,
  hasPseudoElements,
  hasSupportsQueries,
} from '../static/ir';
import {
  MEDIA_QUERY_REFEREE_MODEL,
  PSEUDO_ELEMENT_REFEREE_MODEL,
  referee,
  refereeMediaQueries,
  refereePseudoElements,
  refereeSupportsNesting,
  REFEREE_MODEL,
  SUPPORTS_NESTING_REFEREE_MODEL,
} from '../referee/model';
import {
  KEYFRAMES_REFEREE_MODEL,
  refereeKeyframes,
} from '../referee/keyframes';
import type { EvidenceResult } from '../evidence/claims';
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

function refereeDifferences(
  differences: $ReadOnlyArray<{
    +stateId: string,
    +property: string,
    +pseudoElement: string | null,
    +sourceValue: string | null,
    +targetValue: string | null,
    ...
  }>,
): string {
  return differences
    .map(
      (difference) =>
        `${difference.property}${difference.pseudoElement ?? ''} in ${difference.stateId}: Emotion=${
          difference.sourceValue ?? '(absent)'
        }, StyleX=${difference.targetValue ?? '(absent)'}`,
    )
    .join('; ');
}

export type ProposedEntry = {
  +key: string,
  +elementName: string,
  +classNames: $ReadOnlyArray<string>,
};

export type Proposal =
  | {
      +status: 'proposed',
      +code: string,
      +model: string,
      // The exact bytes this evidence is about. A candidate built from this
      // proposal must contain `generatedHash`, or the evidence belongs to
      // something else.
      +sourceHash: string,
      +generatedHash: string,
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
  expected: $ReadOnlyArray<{ +key: string, +outputStart: number }>,
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
  // Keyed by the offset the spread starts at, so a site can be looked up by
  // position rather than matched against an unordered collection.
  const keyByOffset = new Map<number, string>();
  let spreadCount = 0;

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
      spreadCount++;
      const argument = (node.argument.arguments ?? [])[0];
      if (
        argument != null &&
        argument.type === 'MemberExpression' &&
        argument.object?.name === registryName &&
        typeof argument.property?.name === 'string'
      ) {
        keyByOffset.set(node.start, argument.property.name);
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
  // Captured now: the walk closure above assigns these, so any later call
  // invalidates the refinement that they are non-null.
  const resolvedImport: string = importText;
  const resolvedCreateCall: string = createCallText;

  // Each converted site is checked at the exact offset its replacement was
  // written to. Comparing an unordered collection of references is not enough:
  // swapping the keys of two sites leaves the same references and the same
  // per-key CSS, so every other check passes while the two elements trade
  // appearances.
  for (const entry of expected) {
    const found = keyByOffset.get(entry.outputStart);
    if (found == null) {
      return {
        ok: false,
        reason:
          `generated code has no ${namespace}.props(${registryName}.…) at the ` +
          `position written for "${entry.key}"`,
      };
    }
    if (found !== entry.key) {
      return {
        ok: false,
        reason: `the site written for "${entry.key}" reads "${registryName}.${found}" instead`,
      };
    }
  }

  if (spreadCount !== expected.length) {
    return {
      ok: false,
      reason:
        `generated code has ${spreadCount} ${namespace}.props spreads but ` +
        `${expected.length} sites were converted`,
    };
  }

  return {
    ok: true,
    structure: {
      importText: resolvedImport,
      createCallText: resolvedCreateCall,
    },
  };
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
  // Every result records the exact bytes it examined, so a candidate can later
  // be required to contain precisely the code these checks passed on.
  const sourceHash = hashString(source);
  const targetHash = hashString(converted.code);
  const subject = { file: filename, sourceHash, targetHash };

  // 1. The generated file compiles through StyleX's own compiler.
  const compiled = compileStyleX(converted.code, filename);
  results.push(
    evidence({
      check: 'stylex-plugin-transform',
      provider: STYLEX_PROVIDER,
      subject,
      scope,
      result: compiled.ok ? 'pass' : 'fail',
      ...(compiled.ok ? {} : { detail: compiled.reason }),
      limitations: [
        'the StyleX babel plugin was run on its own: no repository babel ' +
          'configuration, no type stripping, no typecheck, no module ' +
          'resolution, and no repository build',
      ],
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
      subject,
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
    converted.entries.map((entry) => ({
      key: entry.key,
      outputStart: entry.outputStart,
    })),
  );
  results.push(
    evidence({
      check: 'binding-integrity',
      provider: 'stylex-migrate',
      subject,
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
  const comparisonModels = new Set<string>();
  for (const entry of converted.entries) {
    const objectSource = source.slice(
      entry.site.objectStart,
      entry.site.objectEnd,
    );
    if (hasKeyframes(entry.style)) {
      const baseline = emotionKeyframesBaseline(objectSource);
      if (!baseline.ok) {
        results.push(
          evidence({
            check: 'static-css-comparison',
            provider: EMOTION_PROVIDER,
            subject: { ...subject, model: KEYFRAMES_REFEREE_MODEL },
            scope: [`${filename}#${entry.key}`],
            result: 'unavailable',
            detail: baseline.reason,
          }),
        );
        return {
          status: 'refused',
          reason: `no keyframes Emotion baseline for ${entry.key}: ${baseline.reason}`,
          evidence: results,
        };
      }
      const target = stylexKeyframesForKey({
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
            subject: { ...subject, model: KEYFRAMES_REFEREE_MODEL },
            scope: [`${filename}#${entry.key}`],
            result: 'unavailable',
            detail: target.reason,
          }),
        );
        return {
          status: 'refused',
          reason: `no keyframes StyleX result for ${entry.key}: ${target.reason}`,
          evidence: results,
        };
      }
      const comparison = refereeKeyframes(
        baseline.observation,
        target.observation,
      );
      const detail =
        comparison.status === 'unsupported'
          ? comparison.reasons.join('; ')
          : comparison.differences.join('; ');
      results.push(
        evidence({
          check: 'static-css-comparison',
          provider: 'stylex-migrate',
          subject: { ...subject, model: KEYFRAMES_REFEREE_MODEL },
          scope: [`${filename}#${entry.key}`],
          result:
            comparison.status === 'equivalent'
              ? 'pass'
              : comparison.status === 'mismatch'
                ? 'fail'
                : 'not-applicable',
          ...(detail === '' ? {} : { detail }),
          limitations: [
            `compared under model ${KEYFRAMES_REFEREE_MODEL}`,
            'alpha-renamed exactly one generated keyframes identifier and compared its animation-name reference',
            'only literal from/to frames are included; percentage frames and multiple animations are refused',
            'no runtime evidence and no CSS outside this local style object was compared',
          ],
        }),
      );
      if (comparison.status !== 'equivalent') {
        return {
          status: 'refused',
          reason: `keyframes CSS differs for ${entry.key}: ${detail || 'unsupported'}`,
          evidence: results,
        };
      }
      comparisonModels.add(KEYFRAMES_REFEREE_MODEL);
      entries.push({
        key: entry.key,
        elementName: entry.site.elementName,
        classNames: target.classNames,
      });
      continue;
    }
    if (
      hasConditions(entry.style) ||
      hasPseudoElements(entry.style) ||
      hasMediaQueries(entry.style) ||
      hasSupportsQueries(entry.style)
    ) {
      const isSupports = hasSupportsQueries(entry.style);
      const isMediaQuery = hasMediaQueries(entry.style);
      const isPseudoElement = hasPseudoElements(entry.style);
      const model = isSupports
        ? SUPPORTS_NESTING_REFEREE_MODEL
        : isMediaQuery
          ? MEDIA_QUERY_REFEREE_MODEL
          : isPseudoElement
            ? PSEUDO_ELEMENT_REFEREE_MODEL
            : REFEREE_MODEL;
      const capability = isSupports
        ? 'supports-nesting'
        : isMediaQuery
          ? 'media-query'
          : isPseudoElement
            ? 'pseudo-element'
            : 'conditional';
      const baseline = isSupports
        ? emotionSupportsNestingBaseline(objectSource)
        : isMediaQuery
          ? emotionMediaQueryBaseline(objectSource)
          : isPseudoElement
            ? emotionPseudoElementBaseline(objectSource)
            : emotionConditionalBaseline(objectSource);
      if (!baseline.ok) {
        results.push(
          evidence({
            check: 'static-css-comparison',
            provider: EMOTION_PROVIDER,
            subject: { ...subject, model },
            scope: [`${filename}#${entry.key}`],
            result: 'unavailable',
            detail: baseline.reason,
          }),
        );
        return {
          status: 'refused',
          reason: `no ${capability} Emotion baseline for ${entry.key}: ${baseline.reason}`,
          evidence: results,
        };
      }
      const target = stylexCascadeForKey({
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
            subject: { ...subject, model },
            scope: [`${filename}#${entry.key}`],
            result: 'unavailable',
            detail: target.reason,
          }),
        );
        return {
          status: 'refused',
          reason: `no ${capability} StyleX result for ${entry.key}: ${target.reason}`,
          evidence: results,
        };
      }
      const comparison = isSupports
        ? refereeSupportsNesting(baseline.declarations, target.declarations)
        : isMediaQuery
          ? refereeMediaQueries(baseline.declarations, target.declarations)
          : isPseudoElement
            ? refereePseudoElements(baseline.declarations, target.declarations)
            : referee(baseline.declarations, target.declarations);
      const detail =
        comparison.status === 'unsupported'
          ? comparison.reasons.join('; ')
          : comparison.status === 'mismatch'
            ? refereeDifferences(comparison.differences)
            : null;
      results.push(
        evidence({
          check: 'static-css-comparison',
          provider: 'stylex-migrate',
          subject: { ...subject, model },
          scope: [`${filename}#${entry.key}`],
          result:
            comparison.status === 'equivalent'
              ? 'pass'
              : comparison.status === 'mismatch'
                ? 'fail'
                : 'not-applicable',
          ...(detail == null ? {} : { detail }),
          limitations: [
            `compared under model ${model}`,
            `source CSS from ${EMOTION_PROVIDER} ${packageVersion(EMOTION_PROVIDER)}, ` +
              `target CSS and priority from ${STYLEX_PROVIDER} ${packageVersion(STYLEX_PROVIDER)}`,
            isSupports
              ? 'enumerated one exact @supports state and, when present, its intersection with one exact @media state'
              : isMediaQuery
                ? 'compared default and one exact @media activation state; multiple or rewritten queries are refused'
                : isPseudoElement
                  ? 'compared root, ::before, and ::after selector targets with no pseudo-class conditions'
                  : 'enumerated default, :hover, :focus, and simultaneous :hover/:focus states',
            'no runtime evidence and no CSS outside this local style object was compared',
          ],
        }),
      );
      if (comparison.status !== 'equivalent') {
        return {
          status: 'refused',
          reason: `${capability} CSS differs for ${entry.key}: ${detail ?? 'unsupported'}`,
          evidence: results,
        };
      }
      comparisonModels.add(model);
      entries.push({
        key: entry.key,
        elementName: entry.site.elementName,
        classNames: target.classNames,
      });
      continue;
    }
    const baseline = emotionBaseline(objectSource);
    if (!baseline.ok) {
      results.push(
        evidence({
          check: 'static-css-comparison',
          provider: EMOTION_PROVIDER,
          subject: { ...subject, model: COMPARISON_MODEL },
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

    if (
      baseline.declarations.some(
        (declaration) => declaration.important === true,
      )
    ) {
      const reason =
        `CSS for ${entry.key} contains !important, which is outside ` +
        `comparison model ${COMPARISON_MODEL}`;
      results.push(
        evidence({
          check: 'static-css-comparison',
          provider: 'stylex-migrate',
          subject: { ...subject, model: COMPARISON_MODEL },
          scope: [`${filename}#${entry.key}`],
          result: 'not-applicable',
          detail: reason,
          limitations: [
            '!important is not supported by the flat mechanical lane',
          ],
        }),
      );
      return { status: 'refused', reason, evidence: results };
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
          subject: { ...subject, model: COMPARISON_MODEL },
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
        subject: { ...subject, model: COMPARISON_MODEL },
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

    comparisonModels.add(COMPARISON_MODEL);
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

  // Frozen: the evidence describes these exact bytes, and a
  // proposal whose `code` could be replaced afterwards would carry a
  // successful result for something nothing ever checked.
  return Object.freeze({
    status: 'proposed',
    code: converted.code,
    model: [...comparisonModels].sort().join('+'),
    sourceHash,
    generatedHash: targetHash,
    entries: Object.freeze(entries),
    refusals: converted.refusals,
    evidence: Object.freeze(results),
    uncovered: Object.freeze([
      'no runtime evidence: nothing was rendered',
      'the source styling library import and JSX pragma were left in place and were not exercised',
      ...(converted.refusals.length > 0
        ? [
            `${converted.refusals.length} site(s) in this file were not converted`,
          ]
        : []),
    ]),
  });
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

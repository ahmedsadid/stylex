/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * L10 — Postprocess. Runs StyleX's OWN eslint autofixes over emitted output,
 * so the result passes `@stylexjs/eslint-plugin` at error with zero autofixes
 * remaining (Meta's golden rule) — and, crucially, so key ordering and
 * shorthand handling exactly match StyleX's canonical form rather than a
 * heuristic we maintain.
 *
 * M4: the caller runs this on a SCOPED snippet containing only the emitted
 * `stylex.create`/`stylex.keyframes` (plus usage stubs), never the whole
 * file — so a user's pre-existing StyleX code is never linted or reordered
 * (proven by `__tests__/scoped-postprocess-test.js`). The fixed objects are
 * then spliced back into the file.
 *
 * The sort-keys autofix can reorder sibling media queries, which the StyleX
 * compiler treats as semantic — but the semantic-diff gate runs on the final
 * output, so any reorder that changes rendering is caught (file refused)
 * rather than shipped.
 *
 * Residual (unfixable) errors mean the output is not clean; the caller
 * refuses the whole file.
 */

import { Linter } from 'eslint';
import { rules as stylexRules } from '@stylexjs/eslint-plugin';
import { lintParserFor, isGateRelevantMessage } from './lintParser';

export type PostprocessResult = {
  +code: string,
  +residualErrors: $ReadOnlyArray<string>,
};

export type PostprocessOptions = {
  /** Rule short-names to omit (e.g. 'no-unused' when linting a snippet whose
   * styles are used elsewhere). */
  +excludeRules?: $ReadOnlyArray<string>,
};

export function postprocess(
  code: string,
  filename: string = 'file.js',
  options?: PostprocessOptions,
): PostprocessResult {
  const excluded = new Set(options?.excludeRules ?? []);
  const linter = new Linter();
  // A TS-aware parser for `.ts`/`.tsx` (a dynamic value lifted from TS user code
  // can carry TS syntax into the generated module), else the Flow parser.
  const { name, parser, parserOptions } = lintParserFor(filename);
  linter.defineParser(name, parser);
  const ruleMap: { +[string]: mixed } = stylexRules;
  const config: { [string]: 'error' } = {};
  for (const ruleName of Object.keys(ruleMap)) {
    if (excluded.has(ruleName)) {
      continue;
    }
    const qualified = `@stylexjs/${ruleName}`;
    linter.defineRule(qualified, ruleMap[ruleName]);
    config[qualified] = 'error';
  }

  const verifyConfig = {
    parser: name,
    parserOptions,
    rules: config,
  };
  const fixed = linter.verifyAndFix(code, verifyConfig, { filename });
  const residual = linter
    .verify(fixed.output, verifyConfig, { filename })
    // Only stylex violations + fatal parse errors are real residuals; ignore
    // noise from user eslint directives for rules this gate doesn't define.
    .filter(isGateRelevantMessage);

  return {
    code: fixed.output,
    residualErrors: residual.map(
      (m) => `${m.ruleId ?? 'error'}: ${m.message} (line ${m.line ?? 0})`,
    ),
  };
}

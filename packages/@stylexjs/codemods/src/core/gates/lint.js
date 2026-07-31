/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Lint gate: the output of a conversion must pass every rule of the real
 * `@stylexjs/eslint-plugin` at severity `error`, with zero messages —
 * which implies zero autofixes still needed (Meta's golden rule for
 * StyleX codemods).
 */

import { Linter } from 'eslint';
// The plugin has named exports only (no default) — import `rules` directly.
import { rules as stylexRules } from '@stylexjs/eslint-plugin';
import { lintParserFor, isGateRelevantMessage } from '../lintParser';

export type LintMessage = {
  +ruleId: string | null,
  +message: string,
  +line: number,
  +column: number,
  +fixable: boolean,
};

export type LintGateResult =
  | { +ok: true }
  | { +ok: false, +messages: $ReadOnlyArray<LintMessage> };

function buildLinter(): { linter: Linter, rules: { [string]: 'error' } } {
  const linter = new Linter();
  const ruleMap: { +[string]: mixed } = stylexRules;
  const rules: { [string]: 'error' } = {};
  for (const ruleName of Object.keys(ruleMap)) {
    const qualified = `@stylexjs/${ruleName}`;
    linter.defineRule(qualified, ruleMap[ruleName]);
    rules[qualified] = 'error';
  }
  return { linter, rules };
}

export function lintGate(
  source: string,
  options?: { +filename?: string },
): LintGateResult {
  const { linter, rules } = buildLinter();
  const filename = options?.filename ?? 'stylex-codemod-gate-input.js';
  // Lint TS files with a TS-aware parser (hermes/Flow throws on TS-only syntax
  // in the user's untouched code), else the Flow parser. See `lintParser`.
  const { name, parser, parserOptions } = lintParserFor(filename);
  linter.defineParser(name, parser);
  const messages = linter
    .verify(source, { parser: name, parserOptions, rules }, { filename })
    // Only stylex violations + fatal parse errors matter; drop noise from the
    // user's own eslint directives for rules this gate doesn't define.
    .filter(isGateRelevantMessage);
  if (messages.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    messages: messages.map((m) => ({
      ruleId: m.ruleId ?? null,
      message: m.message,
      line: m.line ?? 0,
      column: m.column ?? 0,
      fixable: m.fix != null,
    })),
  };
}

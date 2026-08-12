/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import path from 'path';

// None of these have libdefs in this repository, and the StyleX plugin is
// compiled ESM with no default export, so a default import of it yields
// `undefined`. Requiring them avoids both problems in one move.
// $FlowFixMe[cannot-resolve-module]
const { Linter } = require('eslint');
// $FlowFixMe[cannot-resolve-module]
const stylexEslintPlugin = require('@stylexjs/eslint-plugin');

/**
 * The StyleX lint gate.
 *
 * StyleX ships rules that describe what it considers well-formed authored
 * styles, so they are the closest thing to a second opinion on generated code
 * that does not come from this package. Output has to satisfy them **with no
 * autofix left to apply**: if a fixer would still change the file, then what we
 * emitted is not what StyleX wants, and a human running lint after the
 * migration would get a diff they did not ask for.
 *
 * That standard is also what lets emission sort style keys alphabetically. It
 * is not a stylistic preference — `sort-keys` is one of the rules checked here.
 *
 * Only StyleX's own rules are consulted. The repository's lint setup is the
 * repository's business, and its complaints about untouched code are not
 * evidence about this conversion.
 */

const RULE_PREFIX = '@stylexjs';

const RULES: { +[string]: 'error' } = {
  [`${RULE_PREFIX}/valid-styles`]: 'error',
  [`${RULE_PREFIX}/valid-shorthands`]: 'error',
  [`${RULE_PREFIX}/no-legacy-contextual-styles`]: 'error',
  [`${RULE_PREFIX}/no-nonstandard-styles`]: 'error',
  [`${RULE_PREFIX}/no-conflicting-props`]: 'error',
  [`${RULE_PREFIX}/no-lookahead-selectors`]: 'error',
  [`${RULE_PREFIX}/sort-keys`]: 'error',
  // `no-unused` is deliberately absent: an exported registry looks unused to it.
};

const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.tsx']);

export type LintMessage = {
  +ruleId: string,
  +message: string,
  +line: number,
};

export type LintResult =
  | { +ok: true }
  | { +ok: false, +messages: $ReadOnlyArray<LintMessage> };

function linterFor(filename: string): {
  +linter: $FlowFixMe,
  +config: $FlowFixMe,
} {
  const linter = new Linter();
  linter.defineRules(
    Object.fromEntries(
      Object.keys(stylexEslintPlugin.rules).map((name) => [
        `${RULE_PREFIX}/${name}`,
        stylexEslintPlugin.rules[name],
      ]),
    ),
  );

  // The parser follows the filename for the same reason parsing does: a `.ts`
  // file read as `.tsx` fails on syntax that is perfectly valid.
  const isTypeScript = TYPESCRIPT_EXTENSIONS.has(path.extname(filename));
  if (isTypeScript) {
    // $FlowFixMe[cannot-resolve-module] Parser packages have no libdefs here.
    linter.defineParser('typescript', require('@typescript-eslint/parser'));
  } else {
    // $FlowFixMe[cannot-resolve-module] Parser packages have no libdefs here.
    linter.defineParser('hermes', require('hermes-eslint'));
  }

  return {
    linter,
    config: {
      parser: isTypeScript ? 'typescript' : 'hermes',
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      rules: RULES,
    },
  };
}

export function lintStyleX(code: string, filename: string): LintResult {
  let messages;
  let fixedOutput;
  try {
    const { linter, config } = linterFor(filename);
    messages = linter.verify(code, config, { filename });
    fixedOutput = linter.verifyAndFix(code, config, { filename }).output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      messages: [{ ruleId: 'internal', message, line: 0 }],
    };
  }

  const reported = messages.map((message) => ({
    ruleId: String(message.ruleId ?? 'unknown'),
    // Multi-line rule messages become unreadable in a one-line report.
    message: String(message.message).split('\n')[0],
    line: Number(message.line ?? 0),
  }));

  if (reported.length > 0) {
    return { ok: false, messages: reported };
  }
  if (fixedOutput !== code) {
    return {
      ok: false,
      messages: [
        {
          ruleId: 'zero-autofix',
          message:
            'StyleX lint would rewrite this output, so it is not yet in the ' +
            'form StyleX expects',
          line: 0,
        },
      ],
    };
  }
  return { ok: true };
}

export function describeLintMessages(
  messages: $ReadOnlyArray<LintMessage>,
): string {
  return messages
    .map(
      (message) =>
        `${message.ruleId} (line ${message.line}): ${message.message}`,
    )
    .join('; ');
}

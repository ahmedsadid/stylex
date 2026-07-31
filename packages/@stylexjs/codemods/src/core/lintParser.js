/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Picks the ESLint parser for the lint/postprocess gates by filename, so a
 * `.ts`/`.tsx` file is linted with a TypeScript-aware parser rather than the
 * Flow parser (`hermes-eslint`).
 *
 * Why: the codemod parses and transforms TS files fine (jscodeshift `tsx`), but
 * the gates re-run `@stylexjs/eslint-plugin` through ESLint — and `hermes-eslint`
 * is a Flow/Hermes parser that throws on TS-only syntax (`styled(C)<Props>`,
 * `x satisfies T`, `a!.b`, `['x']?: string`, type annotations). The whole-file
 * final lint re-parses the user's untouched TS and blew up, refusing ~75% of the
 * refused corpus. `@typescript-eslint/parser` parses that syntax, and the StyleX
 * rules — designed for TS codebases — fire identically under it (no type-info /
 * `tsconfig` needed; the rules are syntactic).
 */

// hermes-eslint is ESM-compiled with no default export — the namespace object
// itself is the parser (`parseForESLint` lives on it).
import * as hermesEslint from 'hermes-eslint';
// $FlowFixMe[cannot-resolve-module] - @typescript-eslint/parser has no flow libdef
import * as tsParser from '@typescript-eslint/parser';

export type LintParserChoice = {
  +name: string,
  +parser: mixed,
  +parserOptions: {
    +ecmaVersion: string,
    +sourceType: string,
    +ecmaFeatures?: { +jsx: boolean },
  },
};

const TS_FILE = /\.(ts|tsx|mts|cts)$/;
const JSX_FILE = /\.(tsx|jsx)$/;

/**
 * The parser + name + parserOptions to lint `filename` with. Register the parser
 * on the `Linter` under `name` (`linter.defineParser(name, parser)`), then pass
 * `{ parser: name, parserOptions }` to `verify`/`verifyAndFix`.
 */
export function lintParserFor(filename: string): LintParserChoice {
  if (TS_FILE.test(filename)) {
    return {
      name: 'ts',
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        // Only enable JSX for `.tsx` — in a `.ts` file `<T>x` is a type
        // assertion, which JSX mode would mis-parse.
        ecmaFeatures: { jsx: JSX_FILE.test(filename) },
      },
    };
  }
  // `.js`/`.jsx`/Flow — hermes handles JSX + Flow natively (no ecmaFeatures.jsx).
  return {
    name: 'hermes-eslint',
    parser: hermesEslint,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  };
}

/**
 * Whether a lint message is something the gate should judge. The gate defines
 * ONLY `@stylexjs/*` rules, so the only messages that matter are (1) a real
 * stylex rule violation, or (2) a fatal parse error (our output is broken).
 * Everything else is noise from the user's own code — most importantly a
 * `// eslint-disable react-hooks/…` directive for a rule the gate doesn't
 * define, which ESLint reports as "Definition for rule '…' was not found" and
 * which used to falsely refuse otherwise-clean conversions.
 */
export function isGateRelevantMessage(m: $FlowFixMe): boolean {
  if (m.fatal === true) {
    return true;
  }
  return m.ruleId != null && String(m.ruleId).startsWith('@stylexjs/');
}

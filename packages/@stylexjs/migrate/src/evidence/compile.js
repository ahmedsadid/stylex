/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { transformSync } from '@babel/core';
import stylexBabelPlugin from '@stylexjs/babel-plugin';
import { pluginsForFilename } from '../static/parse';

/**
 * Compiling generated code through StyleX's own compiler.
 *
 * The target side of the comparison is whatever StyleX itself makes of our
 * output — never what this package thinks StyleX would make of it. If the
 * compiler rejects the code, or emits different CSS than we expected, that is
 * the answer.
 */

export type CompileResult =
  | {
      +ok: true,
      +code: string,
      // Class name to the CSS rule text StyleX generated for it.
      +rules: $ReadOnlyMap<string, string>,
      // Exact compiler metadata used by the referee fixtures. Consumers must
      // treat these values as observed output, not a priority table to copy.
      +ruleMetadata: $ReadOnlyArray<CompiledStyleXRule>,
    }
  | { +ok: false, +reason: string };

export type CompiledStyleXRule = {
  +className: string,
  +ltr: string,
  +rtl: string | null,
  +priority: number,
};

export function compileStyleX(
  source: string,
  filename: string,
  options?: { +moduleResolutionRoot?: string },
): CompileResult {
  let output;
  try {
    output = transformSync(source, {
      filename,
      babelrc: false,
      configFile: false,
      browserslistConfigFile: false,
      cloneInputAst: false,
      parserOpts: { plugins: [...pluginsForFilename(filename)] },
      plugins: [
        [
          stylexBabelPlugin,
          {
            dev: false,
            runtimeInjection: false,
            ...(options?.moduleResolutionRoot == null
              ? {}
              : {
                  unstable_moduleResolution: {
                    type: 'commonJS',
                    rootDir: options.moduleResolutionRoot,
                  },
                }),
          },
        ],
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `StyleX could not compile the output: ${message}`,
    };
  }

  const code = output?.code;
  if (code == null) {
    return { ok: false, reason: 'StyleX produced no output for the file' };
  }

  const rules = new Map<string, string>();
  const ruleMetadata = [];
  const metadata: $FlowFixMe = output?.metadata;
  const entries = metadata?.stylex;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length < 2) {
        continue;
      }
      const className = entry[0];
      const rule = entry[1];
      const priority = entry[2];
      if (
        typeof className === 'string' &&
        rule != null &&
        typeof rule.ltr === 'string' &&
        typeof priority === 'number' &&
        Number.isFinite(priority)
      ) {
        const ltr = String(rule.ltr);
        const rtl = typeof rule.rtl === 'string' ? rule.rtl : null;
        rules.set(className, ltr);
        ruleMetadata.push(Object.freeze({ className, ltr, rtl, priority }));
      }
    }
  }

  return {
    ok: true,
    code,
    rules,
    ruleMetadata: Object.freeze(ruleMetadata),
  };
}

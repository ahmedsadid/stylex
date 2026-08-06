/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * `stylex-codemod init` — scaffolds a fully-commented `stylex-codemod.config.js`
 * and returns a quick-start message, so a first-timer goes from zero to a dry run
 * without reading any docs. Never clobbers an existing config.
 */

import * as fs from 'fs';
import * as path from 'path';

export const CONFIG_FILENAME = 'stylex-codemod.config.js';

/** The scaffolded config: every option present and explained; the optional
 * (theme / render) bits commented out so the default is a safe no-op. */
export const CONFIG_TEMPLATE: string = `/**
 * stylex-codemod configuration. Every field is optional — this file just makes
 * the options discoverable. Delete what you don't need.
 */
module.exports = {
  // Wrap ':hover' rules in '@media (hover: hover)' (default: true).
  hoverGuard: true,

  // Map inline-axis physical properties to logical (marginLeft ->
  // marginInlineStart, etc.) for RTL-safety (default: true).
  logicalProperties: true,

  // THEME -> defineVars tokens. Uncomment to convert 'useTheme()' /
  // 'props.theme.<path>' reads into '<varsName>.<token>' from your defineVars
  // module. You author the defineVars values; the codemod rewrites the reads and
  // emits a name-only skeleton to start from.
  // themeTokens: {
  //   varsImport: './app.stylex', // import specifier written into converted files
  //   varsName: 'vars',           // the exported defineVars binding name
  //   // Only used by --render-check (to verify theme conversions in a browser):
  //   themePath: './theme',        // your REAL runtime theme module (for ThemeProvider)
  //   varsPath: './app.stylex.js', // your authored defineVars module (for real values)
  // },

  // --render-check sample props per component. Auto-derived from a co-located
  // '*.stories.*' file when omitted; list here to override.
  // renderCases: [
  //   { include: 'components/Button', cases: [{ size: 'large' }, { disabled: true }] },
  // ],
};
`;

export type InitResult = {
  +created: boolean, // false when a config already existed (left untouched)
  +path: string,
  +message: string,
};

/** Writes the config (if absent) and returns a quick-start message. */
export function runInit(cwd: string): InitResult {
  const target = path.join(cwd, CONFIG_FILENAME);
  const existed = fs.existsSync(target);
  if (!existed) {
    fs.writeFileSync(target, CONFIG_TEMPLATE);
  }

  const header = existed
    ? `${CONFIG_FILENAME} already exists — left untouched.`
    : `Created ${CONFIG_FILENAME}.`;
  const message = [
    header,
    '',
    'Quick start:',
    '  1. Preview (safe, writes nothing):',
    '       stylex-codemod emotion "src/**/*.{jsx,tsx}"',
    '  2. Read the report — it lists what converted, what needs a hand, and a',
    '     tailored "Next steps" section.',
    '  3. Apply:',
    '       stylex-codemod emotion "src/**/*.{jsx,tsx}" --write',
    '  4. (optional) Verify theme/dynamic conversions in a real browser:',
    '       add --render-check',
    '',
    'Dry run is always the default — nothing is written until --write.',
  ].join('\n');

  return { created: !existed, path: target, message };
}

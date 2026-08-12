/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { serializeValue, STYLEX_MODULE } from '../static/emit';
import type { ThemeDecisionDraft } from './model';

export function emitThemeModule(draft: ThemeDecisionDraft): string {
  const defaultValues = draft.tokens
    .map(
      (token) =>
        `  ${token.targetName}: ${serializeValue(token.values[draft.defaultVariant])},`,
    )
    .join('\n');
  const variants = draft.variants
    .map((variant) => {
      const values = draft.tokens
        .map(
          (token) =>
            `  ${token.targetName}: ${serializeValue(token.values[variant.name])},`,
        )
        .join('\n');
      return `export const ${variant.exportName} = stylex.createTheme(${draft.varsExport}, {\n${values}\n});`;
    })
    .join('\n\n');
  return `import * as stylex from '${STYLEX_MODULE}';\n\nexport const ${draft.varsExport} = stylex.defineVars({\n${defaultValues}\n});\n\n${variants}\n`;
}

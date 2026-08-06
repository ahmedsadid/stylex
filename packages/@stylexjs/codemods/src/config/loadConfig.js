/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * L0 config — loads a `stylex-codemod.config.js` (or an explicit path) into
 * the options the transform accepts. Missing file → defaults. Unknown keys
 * or wrong-typed values throw, so a typo fails loudly instead of silently
 * doing the wrong thing.
 *
 * M6 wires the two behavioral toggles that already have implementations:
 * `hoverGuard` (M2) and `logicalProperties` (M3a). `resolveValue`
 * (theme-token mapping) is reserved for the token slice and
 * is intentionally not part of this schema yet.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Render-check sample props for files whose path contains `include`. The first
 * matching rule's `cases` are rendered; unmatched files render under `[{}]`. */
export type RenderCaseRule = {
  +include: string, // substring matched against the file path
  +cases: $ReadOnlyArray<{ +[string]: mixed }>,
};

// M13: theme → defineVars token conversion. `varsImport`/`varsName` drive the
// rewrite. `themePath`/`varsPath` are OPTIONAL and only used by theme
// `--render-check`: the real runtime theme module (for the `<ThemeProvider>`)
// and the authored defineVars module (for the StyleX side's real values). Both
// present → theme conversions are render-checked; absent → they're skipped.
export type ThemeTokensConfig = {
  +varsImport: string,
  +varsName: string,
  +themePath?: string,
  +varsPath?: string,
};

export type CodemodConfig = {
  +hoverGuard: boolean,
  +logicalProperties: boolean,
  // `null` (default) leaves `useTheme` as a whole-file blocker; set it to map
  // `theme.<path>` reads to `<varsName>.<token>` from `varsImport`.
  +themeTokens: ThemeTokensConfig | null,
  // Confidence workflow: sample props to render each file under (`--render-check`).
  +renderCases: $ReadOnlyArray<RenderCaseRule>,
};

export const DEFAULT_CONFIG: CodemodConfig = {
  hoverGuard: true,
  logicalProperties: true,
  themeTokens: null,
  renderCases: [],
};

const DEFAULT_CONFIG_FILENAME = 'stylex-codemod.config.js';

const BOOLEAN_KEYS: $ReadOnlyArray<string> = [
  'hoverGuard',
  'logicalProperties',
];

export class ConfigError extends Error {
  constructor(message: string) {
    super(`[stylex-codemod config] ${message}`);
    this.name = 'ConfigError';
  }
}

/**
 * Resolves the config: an explicit `configPath`, else
 * `stylex-codemod.config.js` in `cwd`, else defaults.
 */
export function loadConfig(options?: {
  +cwd?: string,
  +configPath?: string | null,
}): CodemodConfig {
  const cwd = options?.cwd ?? process.cwd();
  const explicit = options?.configPath ?? null;
  const resolved =
    explicit != null
      ? path.resolve(cwd, explicit)
      : path.join(cwd, DEFAULT_CONFIG_FILENAME);

  if (!fs.existsSync(resolved)) {
    if (explicit != null) {
      throw new ConfigError(`config file not found: ${resolved}`);
    }
    return DEFAULT_CONFIG;
  }

  // $FlowFixMe[unsupported-syntax] - dynamic require of the user's config
  const loaded: mixed = require(resolved);
  return validateConfig(loaded, resolved);
}

/** Validates a plain object into a CodemodConfig, merging over defaults. */
export function validateConfig(raw: mixed, source: string): CodemodConfig {
  const object =
    raw != null && typeof raw === 'object' && raw.default != null
      ? raw.default
      : raw;
  if (object == null || typeof object !== 'object') {
    throw new ConfigError(`${source}: config must export an object`);
  }
  const merged: { [string]: boolean } = {
    hoverGuard: DEFAULT_CONFIG.hoverGuard,
    logicalProperties: DEFAULT_CONFIG.logicalProperties,
  };
  let themeTokens = DEFAULT_CONFIG.themeTokens;
  let renderCases = DEFAULT_CONFIG.renderCases;
  for (const key of Object.keys(object)) {
    if (BOOLEAN_KEYS.includes(key)) {
      const value = object[key];
      if (typeof value !== 'boolean') {
        throw new ConfigError(`${source}: option '${key}' must be a boolean`);
      }
      merged[key] = value;
    } else if (key === 'themeTokens') {
      themeTokens = validateThemeTokens(object[key], source);
    } else if (key === 'renderCases') {
      renderCases = validateRenderCases(object[key], source);
    } else {
      throw new ConfigError(
        `${source}: unknown option '${key}' (expected: ${[...BOOLEAN_KEYS, 'themeTokens', 'renderCases'].join(', ')})`,
      );
    }
  }
  return {
    hoverGuard: merged.hoverGuard,
    logicalProperties: merged.logicalProperties,
    themeTokens,
    renderCases,
  };
}

function validateRenderCases(
  value: mixed,
  source: string,
): $ReadOnlyArray<RenderCaseRule> {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(`${source}: 'renderCases' must be an array`);
  }
  return value.map((entry: mixed, i: number): RenderCaseRule => {
    if (entry == null || typeof entry !== 'object') {
      throw new ConfigError(`${source}: renderCases[${i}] must be an object`);
    }
    const include = entry.include;
    const cases = entry.cases;
    if (typeof include !== 'string') {
      throw new ConfigError(
        `${source}: renderCases[${i}].include must be a string`,
      );
    }
    if (
      !Array.isArray(cases) ||
      cases.some((c) => c == null || typeof c !== 'object')
    ) {
      throw new ConfigError(
        `${source}: renderCases[${i}].cases must be an array of prop objects`,
      );
    }
    // Runtime-checked above; widen the element type for Flow.
    return { include, cases: cases as $FlowFixMe };
  });
}

/**
 * Applies CLI theme flags over a loaded config (CLI wins), so a theme migration
 * needs no config file: `--theme-vars <name>:<import>` sets the token binding +
 * import; `--theme-path`/`--vars-path` add the modules `--render-check` needs.
 * The path flags alone (no themeTokens) are inert — they only augment a
 * configured theme.
 */
export function applyThemeFlags(
  config: CodemodConfig,
  flags: { +themeVars?: string, +themePath?: string, +varsPath?: string },
): CodemodConfig {
  let themeTokens = config.themeTokens;
  const themeVars = flags.themeVars;
  if (themeVars != null) {
    const colon = themeVars.indexOf(':');
    if (colon <= 0 || colon === themeVars.length - 1) {
      throw new ConfigError(
        '--theme-vars must be \'<name>:<import>\' (e.g. \'vars:./app.stylex\'), ' +
          `got '${themeVars}'`,
      );
    }
    themeTokens = {
      varsName: themeVars.slice(0, colon),
      varsImport: themeVars.slice(colon + 1),
      themePath: themeTokens?.themePath,
      varsPath: themeTokens?.varsPath,
    };
  }
  if (
    themeTokens != null &&
    (flags.themePath != null || flags.varsPath != null)
  ) {
    themeTokens = {
      ...themeTokens,
      themePath: flags.themePath ?? themeTokens.themePath,
      varsPath: flags.varsPath ?? themeTokens.varsPath,
    };
  }
  return { ...config, themeTokens };
}

/** The transform-relevant subset of the config (the CLI's config also carries
 * `renderCases`, which the transform doesn't accept). */
export function pickTransformOptions(config: CodemodConfig): {
  +hoverGuard: boolean,
  +logicalProperties: boolean,
  +themeTokens: { +varsImport: string, +varsName: string } | null,
} {
  // Strip the render-only fields (themePath/varsPath) — the transform's
  // themeTokens is an exact object that only accepts varsImport/varsName.
  const t = config.themeTokens;
  return {
    hoverGuard: config.hoverGuard,
    logicalProperties: config.logicalProperties,
    themeTokens:
      t == null ? null : { varsImport: t.varsImport, varsName: t.varsName },
  };
}

function validateThemeTokens(
  value: mixed,
  source: string,
): ThemeTokensConfig | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'object') {
    throw new ConfigError(`${source}: 'themeTokens' must be an object or null`);
  }
  const varsImport = value.varsImport;
  const varsName = value.varsName;
  if (typeof varsImport !== 'string' || typeof varsName !== 'string') {
    throw new ConfigError(
      `${source}: 'themeTokens' needs string 'varsImport' and 'varsName'`,
    );
  }
  const optionalPath = (key: string): string | void => {
    const v = value[key];
    if (v == null) {
      return undefined;
    }
    if (typeof v !== 'string') {
      throw new ConfigError(`${source}: 'themeTokens.${key}' must be a string`);
    }
    return v;
  };
  return {
    varsImport,
    varsName,
    themePath: optionalPath('themePath'),
    varsPath: optionalPath('varsPath'),
  };
}

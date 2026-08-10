/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

/**
 * Scope validation for candidate patches.
 *
 * This runs against the *patch*, never against the proposer's description of
 * what it did. An agent that explains it only touched `Button.js` and in fact
 * edited the lockfile is caught here, because only the diff is consulted.
 */

export type FileChangeStatus = 'added' | 'modified' | 'deleted';

export type ChangedPath = {
  +path: string,
  +status: FileChangeStatus,
};

export type ScopeRules = {
  // Repository-relative globs. A pattern with no wildcard also matches
  // everything beneath it, so 'src/components' covers 'src/components/Button.js'.
  +allowedPaths: $ReadOnlyArray<string>,
  // Deletions must be declared up front; an undeclared deletion is a violation
  // even when the path is inside the allowlist.
  +declaredDeletions?: $ReadOnlyArray<string>,
  // Extra globs to forbid, on top of DEFAULT_FORBIDDEN_PATHS.
  +forbiddenPaths?: $ReadOnlyArray<string>,
  // Paths an owner has explicitly authorised, exempting them from the
  // configuration-change rule.
  +ownerDecisionPaths?: $ReadOnlyArray<string>,
};

export type ScopeViolationReason =
  | 'outside-allowlist'
  | 'forbidden-path'
  | 'undeclared-deletion'
  | 'config-change-without-owner-decision'
  | 'ledger-edit';

export type ScopeViolation = {
  +path: string,
  +reason: ScopeViolationReason,
};

export type ScopeResult = {
  +ok: boolean,
  +violations: $ReadOnlyArray<ScopeViolation>,
};

export const LEDGER_DIRECTORY: string = '.stylex-migrate';

export const DEFAULT_FORBIDDEN_PATHS: $ReadOnlyArray<string> = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/npm-shrinkwrap.json',
  '**/node_modules/**',
];

const CONFIG_PATHS: $ReadOnlyArray<string> = [
  '**/package.json',
  '**/tsconfig.json',
  '**/jsconfig.json',
  '**/.babelrc',
  '**/.babelrc.js',
  '**/babel.config.js',
  '**/*.config.js',
  '**/*.config.mjs',
  '**/*.config.ts',
  '**/.eslintrc',
  '**/.eslintrc.js',
  '**/.flowconfig',
];

function escapeRegExpChar(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A deliberately small glob dialect: `**` crosses path separators, `*` and `?`
 * do not. Nothing here needs brace expansion or negation, and a bigger dialect
 * would be a bigger surface to get wrong.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          source += '(?:[^/]+/)*';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExpChar(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function hasWildcard(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

export function matchesGlob(pattern: string, filePath: string): boolean {
  if (!hasWildcard(pattern)) {
    // Bare paths act as themselves or as a directory prefix.
    return filePath === pattern || filePath.startsWith(`${pattern}/`);
  }
  return globToRegExp(pattern).test(filePath);
}

function matchesAny(
  patterns: $ReadOnlyArray<string>,
  filePath: string,
): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, filePath));
}

export function validateScope(
  changes: $ReadOnlyArray<ChangedPath>,
  rules: ScopeRules,
): ScopeResult {
  const declaredDeletions = rules.declaredDeletions ?? [];
  const forbidden = [
    ...DEFAULT_FORBIDDEN_PATHS,
    ...(rules.forbiddenPaths ?? []),
  ];
  const ownerDecisionPaths = rules.ownerDecisionPaths ?? [];

  const violations: Array<ScopeViolation> = [];
  for (const change of changes) {
    const { path: filePath, status } = change;

    if (matchesGlob(LEDGER_DIRECTORY, filePath)) {
      violations.push({ path: filePath, reason: 'ledger-edit' });
      continue;
    }
    if (matchesAny(forbidden, filePath)) {
      violations.push({ path: filePath, reason: 'forbidden-path' });
      continue;
    }
    if (!matchesAny(rules.allowedPaths, filePath)) {
      violations.push({ path: filePath, reason: 'outside-allowlist' });
      continue;
    }
    if (
      matchesAny(CONFIG_PATHS, filePath) &&
      !matchesAny(ownerDecisionPaths, filePath)
    ) {
      violations.push({
        path: filePath,
        reason: 'config-change-without-owner-decision',
      });
      continue;
    }
    if (status === 'deleted' && !declaredDeletions.includes(filePath)) {
      violations.push({ path: filePath, reason: 'undeclared-deletion' });
      continue;
    }
  }

  return Object.freeze({
    ok: violations.length === 0,
    violations: Object.freeze(violations),
  });
}

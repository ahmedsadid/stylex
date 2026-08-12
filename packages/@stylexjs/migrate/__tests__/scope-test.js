/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { matchesGlob, validateScope } from '../src/index';
import type { ChangedPath } from '../src/index';

describe('glob matching', () => {
  test('* stays inside a path segment', () => {
    expect(matchesGlob('src/*.js', 'src/Button.js')).toBe(true);
    expect(matchesGlob('src/*.js', 'src/ui/Button.js')).toBe(false);
  });

  test('** crosses path segments, including none', () => {
    expect(matchesGlob('src/**', 'src/Button.js')).toBe(true);
    expect(matchesGlob('src/**', 'src/ui/deep/Button.js')).toBe(true);
    expect(matchesGlob('**/*.lock', 'a/b/yarn.lock')).toBe(true);
    expect(matchesGlob('**/package.json', 'package.json')).toBe(true);
    expect(matchesGlob('**/package.json', 'packages/x/package.json')).toBe(
      true,
    );
  });

  test('a bare path also covers everything beneath it', () => {
    expect(matchesGlob('src/components', 'src/components')).toBe(true);
    expect(matchesGlob('src/components', 'src/components/Button.js')).toBe(
      true,
    );
    expect(
      matchesGlob('src/components', 'src/components-legacy/Button.js'),
    ).toBe(false);
  });

  test('regular expression characters in a path are not treated as syntax', () => {
    expect(matchesGlob('src/a+b.js', 'src/a+b.js')).toBe(true);
    expect(matchesGlob('src/a+b.js', 'src/aab.js')).toBe(false);
  });
});

describe('scope validation', () => {
  const allowedPaths = ['src/**'];

  test('accepts changes inside the allowlist', () => {
    const result = validateScope(
      [
        { path: 'src/Button.js', status: 'modified' },
        { path: 'src/ui/Card.js', status: 'added' },
      ],
      { allowedPaths },
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('rejects paths outside the allowlist', () => {
    const result = validateScope([{ path: 'README.md', status: 'modified' }], {
      allowedPaths,
    });
    expect(result.violations).toEqual([
      { path: 'README.md', reason: 'outside-allowlist' },
    ]);
  });

  test('rejects lockfiles even when the allowlist would cover them', () => {
    const result = validateScope(
      [{ path: 'src/yarn.lock', status: 'modified' }],
      {
        allowedPaths,
      },
    );
    expect(result.violations).toEqual([
      { path: 'src/yarn.lock', reason: 'forbidden-path' },
    ]);
  });

  test('permits exact bootstrap manifests, lockfiles, and build configuration', () => {
    const paths = ['package.json', 'pnpm-lock.yaml', 'rspack.config.ts'];
    const result = validateScope(
      paths.map((file) => ({ path: file, status: 'modified' })),
      { allowedPaths: paths, bootstrapPaths: paths },
    );
    expect(result).toEqual({ ok: true, violations: [] });
  });

  test('does not let a bootstrap exception authorize another lockfile', () => {
    const result = validateScope(
      [{ path: 'packages/app/pnpm-lock.yaml', status: 'modified' }],
      {
        allowedPaths: ['packages/app/pnpm-lock.yaml'],
        bootstrapPaths: ['pnpm-lock.yaml'],
      },
    );
    expect(result.violations).toEqual([
      {
        path: 'packages/app/pnpm-lock.yaml',
        reason: 'forbidden-path',
      },
    ]);
  });

  test('rejects edits to the migration ledger', () => {
    const result = validateScope(
      [{ path: '.stylex-migrate/ledger.json', status: 'modified' }],
      { allowedPaths: ['**'] },
    );
    expect(result.violations).toEqual([
      { path: '.stylex-migrate/ledger.json', reason: 'ledger-edit' },
    ]);
  });

  test('rejects configuration changes without an owner decision', () => {
    const changes: $ReadOnlyArray<ChangedPath> = [
      { path: 'src/jest.config.js', status: 'modified' },
    ];
    expect(validateScope(changes, { allowedPaths }).violations).toEqual([
      {
        path: 'src/jest.config.js',
        reason: 'config-change-without-owner-decision',
      },
    ]);
    expect(
      validateScope(changes, {
        allowedPaths,
        ownerDecisionPaths: ['src/jest.config.js'],
      }).ok,
    ).toBe(true);
  });

  test('rejects deletions that were not declared', () => {
    const changes: $ReadOnlyArray<ChangedPath> = [
      { path: 'src/Old.js', status: 'deleted' },
    ];
    expect(validateScope(changes, { allowedPaths }).violations).toEqual([
      { path: 'src/Old.js', reason: 'undeclared-deletion' },
    ]);
    expect(
      validateScope(changes, {
        allowedPaths,
        declaredDeletions: ['src/Old.js'],
      }).ok,
    ).toBe(true);
  });
});

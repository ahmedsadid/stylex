/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

function run(cwd: string, args: $ReadOnlyArray<string>): void {
  execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
}

export function writeFiles(
  root: string,
  files: { +[path: string]: string },
): void {
  for (const relative of Object.keys(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, files[relative], 'utf8');
  }
}

export function readFile(root: string, relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

/**
 * A throwaway git repository. Tests must never operate on the developer's own
 * checkout: the candidate boundary creates worktrees and writes files, and a
 * test that got its paths wrong would otherwise damage real work.
 */
export function createTempRepo(files: { +[path: string]: string }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stylex-migrate-repo-'));
  run(root, ['init', '--quiet']);
  run(root, ['config', 'user.email', 'migrate-test@example.com']);
  run(root, ['config', 'user.name', 'Migrate Test']);
  run(root, ['config', 'commit.gpgsign', 'false']);
  writeFiles(root, files);
  run(root, ['add', '-A']);
  run(root, ['commit', '--quiet', '--no-verify', '-m', 'initial']);
  return root;
}

export function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

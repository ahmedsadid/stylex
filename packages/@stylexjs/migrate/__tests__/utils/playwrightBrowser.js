/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

'use strict';

const fs = require('fs');

type BrowserInspection = {
  +available: boolean,
  +executablePath: string | null,
  +reason: string | null,
};

function inspectBrowser(): BrowserInspection {
  try {
    const { chromium } = require('playwright');
    const managed = chromium.executablePath();
    const system =
      process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : process.platform === 'linux'
          ? [
              '/usr/bin/google-chrome',
              '/usr/bin/chromium',
              '/usr/bin/chromium-browser',
            ]
          : [];
    const candidates =
      process.env.STYLEX_MIGRATE_REQUIRE_MANAGED_PLAYWRIGHT === '1'
        ? [managed]
        : [...system, managed];
    const executablePath = candidates.find((candidate) =>
      fs.existsSync(candidate),
    );
    return executablePath == null
      ? {
          available: false,
          executablePath: null,
          reason: `none of these paths exists: ${candidates.join(', ')}`,
        }
      : { available: true, executablePath, reason: null };
  } catch (error) {
    return {
      available: false,
      executablePath: null,
      reason:
        error instanceof Error
          ? error.message
          : 'Playwright could not be loaded',
    };
  }
}

function browserTest(testFunction: $FlowFixMe): $FlowFixMe {
  if (
    process.env.STYLEX_MIGRATE_REQUIRE_PLAYWRIGHT === '1' &&
    process.env.STYLEX_MIGRATE_SKIP_PLAYWRIGHT === '1'
  ) {
    throw new Error(
      'Playwright cannot be required and skipped in the same test run',
    );
  }
  if (process.env.STYLEX_MIGRATE_SKIP_PLAYWRIGHT === '1') {
    return testFunction.skip;
  }
  const browser = inspectBrowser();
  if (
    process.env.STYLEX_MIGRATE_REQUIRE_PLAYWRIGHT === '1' &&
    !browser.available
  ) {
    throw new Error(
      `Playwright is required for this test run, but ${String(browser.reason)}`,
    );
  }
  return browser.available ? testFunction : testFunction.skip;
}

module.exports = { browserTest, inspectBrowser };

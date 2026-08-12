/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');
const { version: playwrightVersion } = require('playwright/package.json');
const { inspectBrowser } = require('./playwrightBrowser');

function browserExecutablePath() {
  const browser = inspectBrowser();
  if (!browser.available || browser.executablePath == null) {
    throw new Error(
      `Playwright browser unavailable: ${String(browser.reason)}`,
    );
  }
  return browser.executablePath;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutablePath(),
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 1,
    });
    await page.setContent(fs.readFileSync('fixture.html', 'utf8'));
    const target = page.locator('[data-runtime-target="card"]');
    await target.hover();
    const observation = await target.evaluate((element) => {
      const style = getComputedStyle(element);
      const attributes = {};
      for (const attribute of element.attributes) {
        attributes[attribute.name] = attribute.value;
      }
      return {
        computedStyles: {
          card: {
            backgroundColor: style.backgroundColor,
            color: style.color,
            display: style.display,
            paddingTop: style.paddingTop,
          },
        },
        dom: {
          card: {
            tagName: element.tagName,
            childCount: element.children.length,
            text: element.textContent,
          },
        },
        attributes: { card: attributes },
        refs: {
          card: { attached: element.isConnected, tagName: element.tagName },
        },
        interactions: { hover: { active: element.matches(':hover') } },
      };
    });
    process.stdout.write(
      JSON.stringify({
        protocolVersion: 'stylex-migrate-runtime-v1',
        environment: {
          renderer: 'playwright',
          rendererVersion: playwrightVersion,
          browser: 'chromium',
          browserVersion: browser.version(),
          platform: `${os.platform()}-${os.arch()}`,
        },
        cases: [{ id: 'card-dark-hover', observation }],
      }),
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});

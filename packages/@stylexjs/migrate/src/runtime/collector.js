/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

export const GENERATED_RUNTIME_COLLECTOR_VERSION: string =
  'stylex-migrate-generated-collector-v2';

export function emitGeneratedRuntimeCollector(): string {
  return String.raw`'use strict';
const fs = require('node:fs');
const os = require('node:os');
const {spawn} = require('node:child_process');

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const packageRoot = process.cwd();
const resolveFromPackage = name => require.resolve(name, {paths: [packageRoot]});
const playwright = require(resolveFromPackage(config.playwrightPackage));
const {version: playwrightVersion} = require(resolveFromPackage(config.playwrightPackage + '/package.json'));

function browserExecutablePath() {
  const systemCandidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'linux'
      ? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
      : [];
  return systemCandidates.find(candidate => fs.existsSync(candidate))
    || playwright.chromium.executablePath();
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitForServer(url, timeoutMs, server) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (server.exitCode != null) {
      throw new Error('evidence server exited before becoming ready');
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error('server returned HTTP ' + response.status);
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw lastError || new Error('timed out waiting for evidence server');
}
async function applyAction(page, action) {
  const locator = page.locator(action.selector);
  if (action.kind === 'hover') return locator.hover();
  if (action.kind === 'click') return locator.click();
  return locator.evaluate((element, item) => {
    if (item.kind === 'set-attribute') element.setAttribute(item.name, item.value);
    else if (item.kind === 'remove-attribute') element.removeAttribute(item.name);
    else if (item.kind === 'add-class') element.classList.add(item.name);
    else if (item.kind === 'remove-class') element.classList.remove(item.name);
  }, action);
}
async function observe(page, target) {
  return page.locator(target.selector).evaluate((element, definition) => {
    const style = getComputedStyle(element);
    const computed = {};
    for (const property of definition.computedProperties) {
      computed[property] = property.startsWith('--')
        ? style.getPropertyValue(property).trim()
        : style[property];
    }
    const attributes = {};
    for (const name of definition.attributes) attributes[name] = element.getAttribute(name);
    return {
      computed,
      dom: definition.observeDom ? {
        tagName: element.tagName,
        childCount: element.children.length,
        text: element.textContent,
      } : null,
      attributes,
      ref: definition.observeRef
        ? {attached: element.isConnected, tagName: element.tagName}
        : null,
    };
  }, target);
}
async function normalizeSyntheticCss(page, expectedCase, runtimeCase) {
  await page.setContent('<!doctype html><html><body></body></html>');
  const computedStyles = await page.evaluate(definition => {
    const output = {};
    for (const [targetId, declarations] of Object.entries(definition)) {
      const element = document.createElement('div');
      document.body.append(element);
      for (const [property, rawValue] of Object.entries(declarations)) {
        if (property.startsWith('--')) element.style.setProperty(property, rawValue);
        else element.style[property] = rawValue;
        const assigned = property.startsWith('--')
          ? element.style.getPropertyValue(property)
          : element.style[property];
        if (assigned === '') throw new Error('invalid synthetic CSS declaration ' + property + ': ' + rawValue);
      }
      const style = getComputedStyle(element);
      output[targetId] = {};
      for (const property of Object.keys(declarations)) {
        output[targetId][property] = property.startsWith('--')
          ? style.getPropertyValue(property).trim()
          : style[property];
      }
    }
    return output;
  }, expectedCase.computedStyles);
  const attributes = {};
  for (const target of runtimeCase.targets) attributes[target.id] = {};
  const interactions = {};
  for (const action of runtimeCase.actions) interactions[action.id] = {completed: true};
  return {computedStyles, dom: {}, attributes, refs: {}, interactions};
}
async function main() {
  const server = spawn(config.server.argv[0], config.server.argv.slice(1), {
    cwd: config.server.cwd,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', chunk => { serverOutput += chunk; });
  server.stderr.on('data', chunk => { serverOutput += chunk; });
  let browser = null;
  let failed = false;
  try {
    await waitForServer(config.server.url, config.server.timeoutMs, server);
    browser = await playwright.chromium.launch({
      headless: true,
      executablePath: browserExecutablePath(),
    });
    const results = [];
    const expectedResults = [];
    for (const runtimeCase of config.cases) {
      const context = await browser.newContext({
        viewport: {width: runtimeCase.viewport.width, height: runtimeCase.viewport.height},
        deviceScaleFactor: runtimeCase.viewport.deviceScaleFactor,
      });
      const page = await context.newPage();
      if (config.syntheticCssExpectations != null) {
        const expectedCase = config.syntheticCssExpectations.cases.find(item => item.id === runtimeCase.id);
        if (expectedCase == null) throw new Error('missing synthetic CSS case ' + runtimeCase.id);
        const normalizerPage = await context.newPage();
        expectedResults.push({
          id: runtimeCase.id,
          observation: await normalizeSyntheticCss(normalizerPage, expectedCase, runtimeCase),
        });
        await normalizerPage.close();
      }
      await page.goto(new URL(runtimeCase.path, config.server.url).toString());
      for (const action of runtimeCase.actions) await applyAction(page, action);
      const observation = {computedStyles: {}, dom: {}, attributes: {}, refs: {}, interactions: {}};
      for (const target of runtimeCase.targets) {
        const result = await observe(page, target);
        observation.computedStyles[target.id] = result.computed;
        if (result.dom != null) observation.dom[target.id] = result.dom;
        observation.attributes[target.id] = result.attributes;
        if (result.ref != null) observation.refs[target.id] = result.ref;
      }
      for (const action of runtimeCase.actions) observation.interactions[action.id] = {completed: true};
      results.push({id: runtimeCase.id, observation});
      await context.close();
    }
    const candidate = {
      protocolVersion: 'stylex-migrate-runtime-v1',
      environment: {
        renderer: 'playwright',
        rendererVersion: playwrightVersion,
        browser: 'chromium',
        browserVersion: browser.version(),
        platform: os.platform() + '-' + os.arch(),
      },
      cases: results,
    };
    process.stdout.write(JSON.stringify(config.syntheticCssExpectations == null
      ? candidate
      : {
          protocolVersion: 'stylex-migrate-generated-runtime-result-v1',
          expected: {
            protocolVersion: 'stylex-migrate-runtime-v1',
            environment: candidate.environment,
            cases: expectedResults,
          },
          candidate,
        }));
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (browser != null) await browser.close();
    server.kill('SIGTERM');
    if (server.exitCode == null) await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(1000)]);
    if (server.exitCode == null) server.kill('SIGKILL');
    if (failed && serverOutput) {
      process.stderr.write('\n[evidence-server]\n' + serverOutput);
    }
  }
}
main().catch(error => { process.stderr.write((error.stack || error.message) + '\n'); process.exitCode = 1; });
`;
}

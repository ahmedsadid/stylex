/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  RUNTIME_PROTOCOL_VERSION,
  compareRuntimeReports,
  normalizeRuntimeCases,
  normalizeRuntimeReport,
} from '../src/index';

const CASES = [
  {
    id: 'card-dark-hover',
    changePaths: ['src/Card.jsx'],
    siteIds: ['site-card'],
    theme: 'dark',
    interaction: 'hover',
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  },
];

function report(): $FlowFixMe {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    environment: {
      renderer: 'playwright',
      rendererVersion: '1.56.1',
      browser: 'chromium',
      browserVersion: '140.0',
      platform: 'darwin-arm64',
    },
    cases: [
      {
        id: 'card-dark-hover',
        observation: {
          computedStyles: {
            card: { color: 'rgb(255, 255, 255)', display: 'block' },
          },
          dom: { card: { tagName: 'DIV', childCount: 1, text: 'Card' } },
          attributes: {
            card: { 'aria-label': 'Card', class: 'x-card', hidden: null },
          },
          refs: { card: { attached: true, tagName: 'DIV' } },
          interactions: { hover: { active: true } },
        },
      },
    ],
  };
}

describe('M8 runtime comparison model', () => {
  test('matches only complete cases in the same recorded environment', () => {
    const result = compareRuntimeReports({
      cases: normalizeRuntimeCases(CASES),
      baseline: normalizeRuntimeReport(report()),
      candidate: normalizeRuntimeReport(report()),
    });
    expect(result).toMatchObject({
      result: 'matched',
      coverage: {
        expectedCaseIds: ['card-dark-hover'],
        matchedCaseIds: ['card-dark-hover'],
        missingCaseIds: [],
      },
      cases: [
        {
          id: 'card-dark-hover',
          changePaths: ['src/Card.jsx'],
          siteIds: ['site-card'],
          theme: 'dark',
          interaction: 'hover',
          result: 'matched',
        },
      ],
    });
  });

  test.each([
    ['computedStyles', ['card', 'color'], 'rgb(0, 0, 0)'],
    ['dom', ['card', 'childCount'], 2],
    ['attributes', ['card', 'aria-label'], 'Changed'],
    ['refs', ['card', 'attached'], false],
    ['interactions', ['hover', 'active'], false],
  ])('detects a seeded %s regression', (category, keys, value) => {
    const changed = report();
    changed.cases[0].observation[category][keys[0]][keys[1]] = value;
    const result = compareRuntimeReports({
      cases: CASES,
      baseline: report(),
      candidate: changed,
    });
    expect(result.result).toBe('different');
    expect(result.cases[0]).toMatchObject({
      result: 'different',
      differences: [
        expect.objectContaining({ category, path: `/${keys.join('/')}` }),
      ],
    });
  });

  test('partial or extra rendering cannot become a complete match', () => {
    const missing = report();
    missing.cases = [];
    expect(
      compareRuntimeReports({
        cases: CASES,
        baseline: report(),
        candidate: missing,
      }),
    ).toMatchObject({
      result: 'incomplete',
      coverage: { missingCaseIds: ['card-dark-hover'] },
    });

    const unexpected = report();
    unexpected.cases.push({
      ...unexpected.cases[0],
      id: 'undeclared-case',
    });
    expect(
      compareRuntimeReports({
        cases: CASES,
        baseline: report(),
        candidate: unexpected,
      }),
    ).toMatchObject({
      result: 'incomplete',
      coverage: { unexpectedCaseIds: ['undeclared-case'] },
    });
  });

  test('refuses to compare different browser environments', () => {
    const candidate = report();
    candidate.environment.browserVersion = '141.0';
    expect(
      compareRuntimeReports({
        cases: CASES,
        baseline: report(),
        candidate,
      }),
    ).toMatchObject({
      result: 'incomparable',
      environment: null,
    });
  });
});

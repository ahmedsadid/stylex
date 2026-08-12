/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { scanRepository, themeConsumerCandidates } from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

describe('theme consumer candidates', () => {
  let repo: string;

  afterEach(() => removeTempDir(repo));

  test('separates bridge-ready files from exact local provider files and blockers', () => {
    repo = createTempRepo({
      'src/BridgeOnly.tsx': `import styled from '@emotion/styled';
const A = styled.div\`color: \${p => p.theme.colors.foreground};\`;
const B = styled.span\`padding: \${p => p.theme.space.small};\`;
export const BridgeOnly = () => <A><B /></A>;
`,
      'src/LocalProvider.tsx': `import styled from '@emotion/styled';
import {ThemeProvider} from '@emotion/react';
const darkTheme = {colors: {foreground: '#eee'}};
const Root = styled.div\`color: \${p => p.theme.colors.foreground};\`;
export const LocalProvider = () => <ThemeProvider theme={darkTheme}><Root /></ThemeProvider>;
`,
      'src/Blocked.tsx': `import styled from '@emotion/styled';
const BlockedRoot = styled.div\`color: prefix-\${p => p.theme.colors.foreground};\`;
export const Blocked = () => <BlockedRoot />;
`,
    });
    const report = themeConsumerCandidates(
      scanRepository({ repositoryRoot: repo }),
    );
    expect(report.counts).toMatchObject({
      files: 3,
      bridgeReadyFiles: 2,
      bridgeReadyDefinitions: 3,
      localProviderReadyFiles: 1,
    });
    expect(
      report.candidates.find(
        (candidate) => candidate.file === 'src/BridgeOnly.tsx',
      ),
    ).toMatchObject({
      definitionNames: ['A', 'B'],
      themePaths: ['colors.foreground', 'space.small'],
      bridgeReady: true,
      localProviderReady: false,
      reasons: [],
    });
    expect(
      report.candidates.find(
        (candidate) => candidate.file === 'src/Blocked.tsx',
      ),
    ).toMatchObject({
      bridgeReady: false,
      localProviderReady: false,
      reasons: expect.arrayContaining([
        expect.stringContaining('outside the exact grammar'),
      ]),
    });
  });
});

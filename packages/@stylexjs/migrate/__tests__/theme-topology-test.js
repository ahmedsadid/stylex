/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { runCli } from '../src/cli';
import { initializeProject, inspectThemeTopology } from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

describe('theme topology inspection', () => {
  let repo: string;

  afterEach(() => removeTempDir(repo));

  test('records global hosts, portals, mutations, and secondary documents', () => {
    repo = createTempRepo({
      'src/theme.tsx': `import {createPortal} from 'react-dom';
export function mount(child) {
  document.body.classList.add('theme-dark');
  const portal = createPortal(child, document.body);
  const childWindow = window.open('about:blank');
  return [portal, childWindow?.document, child.ownerDocument];
}
`,
    });
    const result = inspectThemeTopology({ repositoryRoot: repo });
    expect(result).toMatchObject({
      status: 'observed',
      observations: expect.arrayContaining([
        expect.objectContaining({ kind: 'body-host' }),
        expect.objectContaining({ kind: 'body-portal' }),
        expect.objectContaining({ kind: 'theme-class-mutation' }),
        expect.objectContaining({ kind: 'secondary-window' }),
        expect.objectContaining({ kind: 'secondary-document' }),
      ]),
    });
  });

  test('exposes topology through the CLI with explicit limitations', () => {
    repo = createTempRepo({
      'src/theme.ts': 'document.documentElement.classList.toggle("dark");\n',
    });
    initializeProject({ repositoryRoot: repo });
    let stdout = '';
    expect(
      runCli(['theme', 'topology', '--json'], {
        cwd: repo,
        writeStdout: (text) => (stdout += text),
      }),
    ).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      command: 'theme topology',
      topology: {
        observations: expect.arrayContaining([
          expect.objectContaining({ kind: 'document-element-host' }),
        ]),
        limitations: expect.arrayContaining([
          expect.stringContaining('do not prove'),
        ]),
      },
    });
  });
});

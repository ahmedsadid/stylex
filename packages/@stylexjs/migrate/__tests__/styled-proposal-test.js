/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import {
  convertClosedStyledDefinition,
  proposeClosedStyledConversion,
  scanRepository,
  STYLED_COMPARISON_MODEL,
  verifyStyledConversion,
} from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

const FILENAME = 'src/example.tsx';

function factsFor(repo: string, name: string): $FlowFixMe {
  const inventory = scanRepository({ repositoryRoot: repo });
  const readinessFact = inventory.facts.find((fact) => {
    const value: $FlowFixMe = fact.value;
    return fact.kind === 'emotion-styled-readiness' && value.name === name;
  });
  const usageFact = inventory.facts.find((fact) => {
    const value: $FlowFixMe = fact.value;
    return fact.kind === 'emotion-styled-usage' && value.name === name;
  });
  const grammarFact = inventory.facts.find((fact) => {
    const value: $FlowFixMe = fact.value;
    return (
      fact.kind === 'emotion-styled-template-grammar' && value.name === name
    );
  });
  if (readinessFact == null || usageFact == null || grammarFact == null) {
    throw new Error(`missing styled facts for ${name}`);
  }
  return { readinessFact, usageFact, grammarFact };
}

describe('closed intrinsic styled proposals', () => {
  let repo: string;

  afterEach(() => {
    removeTempDir(repo);
  });

  test('rewrites the definition and every direct JSX consumer atomically', () => {
    const source = `import styled from '@emotion/styled';
export function Example() {
  return <Pre id="output"><code>text</code></Pre>;
}
const Pre = styled.pre\`
  margin: 0;
  overflow: auto;
\`;
`;
    repo = createTempRepo({ [FILENAME]: source });
    const proposal = proposeClosedStyledConversion({
      source,
      filename: FILENAME,
      ...factsFor(repo, 'Pre'),
    });

    if (proposal.status !== 'proposed') throw new Error(proposal.reason);
    expect(proposal.model).toBe(STYLED_COMPARISON_MODEL);
    expect(proposal.code).toContain(
      "import * as stylex from '@stylexjs/stylex'",
    );
    expect(proposal.code).not.toContain("from '@emotion/styled'");
    expect(proposal.code).toContain('const styles = stylex.create({');
    expect(proposal.code).toContain("margin: '0'");
    expect(proposal.code).toContain("overflow: 'auto'");
    expect(proposal.code).toContain(
      '<pre {...stylex.props(styles.pre)} id="output">',
    );
    expect(proposal.code).toContain('</pre>');
    expect(proposal.code).not.toContain('const Pre =');
    expect(proposal.evidence.map((item) => item.check)).toEqual([
      'stylex-plugin-transform',
      'stylex-lint',
      'styled-binding-integrity',
      'static-css-comparison',
    ]);
    expect(proposal.evidence.every((item) => item.result === 'pass')).toBe(
      true,
    );
    expect(proposal.uncovered.join(' ')).toContain('component-tree identity');
  });

  test('keeps the Emotion import while another styled definition uses it', () => {
    const source = `import styled from '@emotion/styled';
export const App = () => <><Box /><Other /></>;
const Box = styled.div\`color: red;\`;
const Other = styled.div\`color: blue;\`;
`;
    repo = createTempRepo({ [FILENAME]: source });
    const proposal = proposeClosedStyledConversion({
      source,
      filename: FILENAME,
      ...factsFor(repo, 'Box'),
    });
    if (proposal.status !== 'proposed') throw new Error(proposal.reason);
    expect(proposal.code).toContain("import styled from '@emotion/styled'");
    expect(proposal.code).toContain('const Other = styled.div');
  });

  test('refuses facts from different source bytes', () => {
    const source = `import styled from '@emotion/styled';
export const App = () => <Box />;
const Box = styled.div\`color: red;\`;
`;
    repo = createTempRepo({ [FILENAME]: source });
    const result = proposeClosedStyledConversion({
      source: source.replace('color: red', 'color: tan'),
      filename: FILENAME,
      ...factsFor(repo, 'Box'),
    });
    expect(result).toMatchObject({
      status: 'refused',
      reason: 'styled facts do not match the current source bytes',
    });
  });

  test('mutation testing catches a changed emitted value', () => {
    const source = `import styled from '@emotion/styled';
export const App = () => <Box />;
const Box = styled.div\`color: red;\`;
`;
    repo = createTempRepo({ [FILENAME]: source });
    const converted = convertClosedStyledDefinition({
      source,
      filename: FILENAME,
      ...factsFor(repo, 'Box'),
    });
    if (converted.status !== 'converted') throw new Error(converted.reason);
    const result = verifyStyledConversion({
      source,
      filename: FILENAME,
      converted: Object.freeze({
        ...converted,
        code: converted.code.replace("color: 'red'", "color: 'tan'"),
      }),
    });
    expect(result).toMatchObject({ status: 'refused' });
    expect(
      result.evidence.some(
        (item) =>
          item.check === 'static-css-comparison' && item.result === 'fail',
      ),
    ).toBe(true);
  });

  test('StyleX acceptance remains a verifier gate after grammar eligibility', () => {
    const source = `import styled from '@emotion/styled';
export const App = () => <Box />;
const Box = styled.div\`made-up-property: value;\`;
`;
    repo = createTempRepo({ [FILENAME]: source });
    const result = proposeClosedStyledConversion({
      source,
      filename: FILENAME,
      ...factsFor(repo, 'Box'),
    });
    expect(result).toMatchObject({ status: 'refused' });
    expect(
      result.evidence.some(
        (item) => item.check === 'stylex-lint' && item.result === 'fail',
      ),
    ).toBe(true);
  });
});

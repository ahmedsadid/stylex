/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import { scanRepository } from '../src/index';
import { createTempRepo, removeTempDir } from './utils/tempRepo';

function usageByName(inventory: $FlowFixMe): Map<string, $FlowFixMe> {
  return new Map(
    inventory.facts
      .filter((fact) => fact.kind === 'emotion-styled-usage')
      .map((fact) => [fact.value.name, fact]),
  );
}

function factNamed(facts: Map<string, $FlowFixMe>, name: string): $FlowFixMe {
  const fact = facts.get(name);
  if (fact == null) throw new Error(`missing usage fact for ${name}`);
  return fact;
}

describe('@emotion/styled usage and escape graphs', () => {
  let repo: string;

  afterEach(() => {
    removeTempDir(repo);
  });

  test('admits only a top-level closed intrinsic with complete direct JSX uses', () => {
    const source = `import styled from '@emotion/styled';
export function Example() {
  return <Pre id="output"><code>text</code></Pre>;
}
const Pre = styled('pre')\`
  margin: 0;
  overflow: auto;
\`;
`;
    repo = createTempRepo({ 'src/example.tsx': source });
    const inventory = scanRepository({ repositoryRoot: repo });
    const fact = factNamed(usageByName(inventory), 'Pre');

    expect(fact).toMatchObject({
      status: 'known',
      value: {
        name: 'Pre',
        targetKind: 'intrinsic',
        targetName: 'pre',
        topLevel: true,
        shadowed: false,
        firstSliceEligible: true,
        blockedReasons: [],
        escapes: [],
      },
    });
    expect(fact.value.consumers).toHaveLength(1);
    expect(fact.value.consumers[0]).toMatchObject({
      attributes: ['id'],
      spread: false,
    });
    const consumer = fact.value.consumers[0];
    expect(
      source.slice(consumer.openingName.start, consumer.openingName.end),
    ).toBe('Pre');
    expect(
      source.slice(consumer.closingName.start, consumer.closingName.end),
    ).toBe('Pre');
  });

  test('records exports, escapes, shadowing, spreads, and risky JSX props', () => {
    repo = createTempRepo({
      'src/blocked.tsx': `import styled from '@emotion/styled';
export const Exported = styled.div\`color: red;\`;
const Escaped = styled.div\`color: red;\`;
const Alias = Escaped;
const Selected = styled.div\`color: red;\`;
const Parent = styled.div\`\${Selected} { color: blue; }\`;
const Spread = styled.div\`color: red;\`;
const Poly = styled.div\`color: red;\`;
const StyledProp = styled.div\`color: red;\`;
const Member = styled.div\`color: red;\`;
const Shadowed = styled.div\`color: red;\`;
export const App = props => <>
  <Exported />
  <Escaped />
  <Selected />
  <Parent />
  <Spread {...props} />
  <Poly as="a" />
  <StyledProp className="external" />
  <Member.Item />
</>;
function local(Shadowed) { return <Shadowed />; }
`,
    });
    const facts = usageByName(scanRepository({ repositoryRoot: repo }));

    expect(factNamed(facts, 'Exported').value.blockedReasons).toContain(
      'exported-definition',
    );
    expect(factNamed(facts, 'Escaped').value).toMatchObject({
      firstSliceEligible: false,
      escapes: [{ kind: 'value-escape' }],
    });
    expect(factNamed(facts, 'Selected').value.escapes).toContainEqual(
      expect.objectContaining({ kind: 'template-reference' }),
    );
    expect(factNamed(facts, 'Spread').value.blockedReasons).toContain(
      'jsx-spread',
    );
    expect(factNamed(facts, 'Poly').value.blockedReasons).toContain(
      'jsx-style-or-polymorphic-prop',
    );
    expect(factNamed(facts, 'StyledProp').value.blockedReasons).toContain(
      'jsx-style-or-polymorphic-prop',
    );
    expect(factNamed(facts, 'Member').value.escapes).toContainEqual(
      expect.objectContaining({ kind: 'jsx-member' }),
    );
    expect(factNamed(facts, 'Shadowed').value).toMatchObject({
      shadowed: true,
      firstSliceEligible: false,
    });
  });

  test('does not promote callbacks, themes, component targets, or unused styles', () => {
    repo = createTempRepo({
      'src/runtime.tsx': `import styled from '@emotion/styled';
const Base = props => <div {...props} />;
const ComponentTarget = styled(Base)\`color: red;\`;
const Theme = styled.div\`color: \${p => p.theme.color};\`;
const Unused = styled.div\`color: red;\`;
export const App = () => <><ComponentTarget /><Theme /></>;
`,
    });
    const facts = usageByName(scanRepository({ repositoryRoot: repo }));

    expect(factNamed(facts, 'ComponentTarget').value.blockedReasons).toContain(
      'non-intrinsic-target',
    );
    expect(factNamed(facts, 'Theme').value.blockedReasons).toEqual(
      expect.arrayContaining([
        'open-or-unsupported-style-form',
        'runtime-style-input',
      ]),
    );
    expect(factNamed(facts, 'Unused').value.blockedReasons).toContain(
      'no-direct-jsx-consumers',
    );
  });

  test('requires a standalone top-level const declaration', () => {
    repo = createTempRepo({
      'src/declarations.tsx': `import styled from '@emotion/styled';
let Mutable = styled.div\`color: red;\`;
const Multiple = styled.div\`color: red;\`, other = 1;
export const App = () => <><Mutable /><Multiple /></>;
`,
    });
    const facts = usageByName(scanRepository({ repositoryRoot: repo }));
    expect(factNamed(facts, 'Mutable').value.blockedReasons).toContain(
      'definition-not-const',
    );
    expect(factNamed(facts, 'Multiple').value.blockedReasons).toContain(
      'multi-declarator-definition',
    );
  });
});

import styled from '@emotion/styled';

const Base = (props) => <div {...props} />;
/* TODO(stylex-migration): styled() component */
const Fancy = styled(Base)`
  color: red;
`;

export default function App() {
  return <Fancy>hi</Fancy>;
}

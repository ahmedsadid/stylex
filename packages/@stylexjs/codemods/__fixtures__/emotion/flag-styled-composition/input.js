import styled from '@emotion/styled';

const Base = (props) => <div {...props} />;
const Fancy = styled(Base)`
  color: red;
`;

export default function App() {
  return <Fancy>hi</Fancy>;
}

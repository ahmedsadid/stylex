import styled from '@emotion/styled';

// A partial prop interpolation in a styled template (`${p => p.size}px`) is
// rebuilt as a template-literal dynamic value passed to the wrapper's create.
const Box = styled.div`
  width: ${(p) => p.size}px;
  color: rebeccapurple;
`;

export default function App(props) {
  return <Box {...props}>hi</Box>;
}

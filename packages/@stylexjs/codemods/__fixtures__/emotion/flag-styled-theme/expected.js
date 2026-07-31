import styled from '@emotion/styled';

/* TODO(stylex-migration): styled() component */
const Box = styled.div`
  color: ${(props) => props.theme.primary};
`;

export default function App() {
  return <Box>hi</Box>;
}

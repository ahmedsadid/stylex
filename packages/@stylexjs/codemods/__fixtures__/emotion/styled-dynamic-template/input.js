import styled from '@emotion/styled';

const Box = styled.div`
  color: ${(props) => props.color};
  padding: 8px;
`;

export default function App(props) {
  return <Box {...props}>hi</Box>;
}

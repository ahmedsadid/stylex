import styled from '@emotion/styled';

const Button = styled.button`
  color: red;
  padding: 8px;
`;

export default function App(props) {
  return <Button {...props}>Click</Button>;
}

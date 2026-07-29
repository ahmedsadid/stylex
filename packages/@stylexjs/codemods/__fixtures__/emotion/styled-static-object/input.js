import styled from '@emotion/styled';

const Card = styled('section')({ color: 'navy', marginLeft: 4 });

export default function App(props) {
  return <Card {...props}>Body</Card>;
}

/** @jsxImportSource @emotion/react */
import styled from '@emotion/styled';
import * as React from 'react';

const Button = styled.button`
  background-color: red;
`;

export default function Panel() {
  return (
    <div css={{ padding: 8, color: 'navy' }}>
      <Button />
    </div>
  );
}

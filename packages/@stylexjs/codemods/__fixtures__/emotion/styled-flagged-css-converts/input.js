/** @jsxImportSource @emotion/react */
import styled from '@emotion/styled';
import * as React from 'react';

// The styled() component is flagged in place (M11a defers converting it), but
// the co-located css prop below still converts — the file is no longer refused
// just because it imports @emotion/styled.
const Button = styled.button`
  color: red;
`;

export default function Panel() {
  return (
    <div css={{ padding: 8, color: 'navy' }}>
      <Button />
    </div>
  );
}

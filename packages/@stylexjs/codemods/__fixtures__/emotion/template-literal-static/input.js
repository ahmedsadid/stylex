/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react';
import * as React from 'react';

export default function Box() {
  return (
    <div
      css={css`
        color: red;
        background-color: hotpink;
        &:hover {
          color: blue;
        }
        @media (min-width: 600px) {
          font-size: 18px;
        }
      `}
    >
      Box
    </div>
  );
}

/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react';
import * as React from 'react';

export default function Box(props) {
  return (
    <div
      css={css`
        color: ${props.color};
        padding: 8px;
        &:hover {
          background-color: ${props.hover};
        }
      `}
    >
      Box
    </div>
  );
}

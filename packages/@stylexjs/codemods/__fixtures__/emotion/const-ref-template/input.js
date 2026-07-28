/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react';
import * as React from 'react';

const box = css`
  color: red;
  padding: 8px;
`;

export default function Box() {
  return <div css={box}>Box</div>;
}

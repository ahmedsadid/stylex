/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react';
import * as React from 'react';

const box = css({ color: 'red', padding: 8 });

export default function Box() {
  return <div css={box}>Box</div>;
}

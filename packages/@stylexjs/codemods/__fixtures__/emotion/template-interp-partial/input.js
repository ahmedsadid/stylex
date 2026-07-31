/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react';
import * as React from 'react';

// A part-value interpolation (`${x}px` — not a whole declaration value) is
// rebuilt as a template-literal dynamic value and lifted to a function-form
// `create` param, preserving the exact runtime string Emotion would produce.
export default function Box(props) {
  return (
    <div
      css={css`
        padding: ${props.gap}px;
      `}
    >
      Box
    </div>
  );
}

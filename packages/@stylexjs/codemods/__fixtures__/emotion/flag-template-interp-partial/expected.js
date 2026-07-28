/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react';
import * as React from 'react';

// A part-value interpolation (`${x}px` — not a whole declaration value) is
// deferred: the parser can't map it cleanly, so the whole site is flagged.
export default function Box(props) {
  return (
    /* TODO(stylex-migration): template-literal styles */
    <div
      css={css`
        padding: ${props.gap}px;
      `}
    >
      Box
    </div>
  );
}

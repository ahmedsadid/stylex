/** @jsxImportSource @emotion/react */
import * as React from 'react';

export default function Panel(props) {
  return (
    <div
      css={{
        fontSize: 14,
        '@media (min-width: 600px)': { fontSize: props.largeSize },
      }}
    >
      Panel
    </div>
  );
}

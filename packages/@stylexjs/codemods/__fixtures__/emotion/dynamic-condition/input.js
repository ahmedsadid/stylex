/** @jsxImportSource @emotion/react */
import * as React from 'react';

export default function Link(props) {
  return (
    <a
      css={{ color: 'blue', ':hover': { color: props.hoverColor } }}
      href="#top"
    >
      Link
    </a>
  );
}

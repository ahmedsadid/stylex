/** @jsxImportSource @emotion/react */
import * as React from 'react';

export default function Swatch(props) {
  return (
    <span css={{ color: props.fg, backgroundColor: props.bg }}>Swatch</span>
  );
}

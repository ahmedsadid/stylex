/** @jsxImportSource @emotion/react */
import * as React from 'react';

export default function Toggle(props) {
  return (
    <button css={{ color: props.active ? 'green' : 'gray' }}>Toggle</button>
  );
}

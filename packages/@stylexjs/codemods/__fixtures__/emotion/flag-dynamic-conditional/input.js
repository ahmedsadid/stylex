/** @jsxImportSource @emotion/react */
import * as React from 'react';

// A dynamic value under a condition (`:hover`) is deferred to a later slice:
// the whole site is flagged, not converted.
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

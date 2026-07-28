import styled from '@emotion/styled';
import * as React from 'react';

import * as stylex from '@stylexjs/stylex';

// The styled() component is flagged in place (M11a defers converting it), but
// the co-located css prop below still converts — the file is no longer refused
// just because it imports @emotion/styled.
/* TODO(stylex-migration): styled() component */
const Button = styled.button`
  color: red;
`;

const styles = stylex.create({
  panel: {
    padding: 8,
    color: 'navy',
  },
});

export default function Panel() {
  return (
    <div {...stylex.props(styles.panel)}>
      <Button />
    </div>
  );
}

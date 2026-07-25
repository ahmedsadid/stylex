import * as React from 'react';

import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  box: (color) => ({
    padding: 8,
    color: color,
  }),
});

export default function Box(props) {
  return <div {...stylex.props(styles.box(props.color))}>Box</div>;
}

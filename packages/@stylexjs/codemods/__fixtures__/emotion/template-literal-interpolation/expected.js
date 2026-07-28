import * as React from 'react';

import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  box: (backgroundColor, color) => ({
    padding: '8px',
    backgroundColor: {
      default: null,

      '@media (hover: hover)': {
        default: null,
        ':hover': backgroundColor,
      },
    },
    color: color,
  }),
});

export default function Box(props) {
  return <div {...stylex.props(styles.box(props.hover, props.color))}>Box</div>;
}

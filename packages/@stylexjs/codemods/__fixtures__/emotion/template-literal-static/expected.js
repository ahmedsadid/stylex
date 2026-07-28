import * as React from 'react';

import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  box: {
    backgroundColor: 'hotpink',

    color: {
      default: 'red',

      '@media (hover: hover)': {
        default: null,
        ':hover': 'blue',
      },
    },

    fontSize: {
      default: null,
      '@media (min-width: 600px)': '18px',
    },
  },
});

export default function Box() {
  return <div {...stylex.props(styles.box)}>Box</div>;
}

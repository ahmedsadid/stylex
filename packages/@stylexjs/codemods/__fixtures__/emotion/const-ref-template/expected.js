import * as React from 'react';
import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  box: {
    padding: '8px',
    color: 'red',
  },
});

export default function Box() {
  return <div {...stylex.props(styles.box)}>Box</div>;
}

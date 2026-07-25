import * as React from 'react';

import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  toggle: (color) => ({
    color: color,
  }),
});

export default function Toggle(props) {
  return (
    <button {...stylex.props(styles.toggle(props.active ? 'green' : 'gray'))}>
      Toggle
    </button>
  );
}

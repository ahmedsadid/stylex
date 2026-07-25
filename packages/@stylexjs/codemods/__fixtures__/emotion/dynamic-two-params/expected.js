import * as React from 'react';

import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  swatch: (backgroundColor, color) => ({
    backgroundColor: backgroundColor,
    color: color,
  }),
});

export default function Swatch(props) {
  return (
    <span {...stylex.props(styles.swatch(props.bg, props.fg))}>Swatch</span>
  );
}

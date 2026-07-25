import * as React from 'react';

import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  panel: (fontSize) => ({
    fontSize: {
      default: 14,
      '@media (min-width: 600px)': fontSize,
    },
  }),
});

export default function Panel(props) {
  return <div {...stylex.props(styles.panel(props.largeSize))}>Panel</div>;
}

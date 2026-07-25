import * as React from 'react';

import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  link: (color) => ({
    color: {
      default: 'blue',

      '@media (hover: hover)': {
        default: null,
        ':hover': color,
      },
    },
  }),
});

export default function Link(props) {
  return (
    <a {...stylex.props(styles.link(props.hoverColor))} href="#top">
      Link
    </a>
  );
}

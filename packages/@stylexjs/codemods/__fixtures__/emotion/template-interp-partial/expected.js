import * as React from 'react';

import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  box: (padding) => ({
    padding: padding,
  }),
});

// A part-value interpolation (`${x}px` — not a whole declaration value) is
// rebuilt as a template-literal dynamic value and lifted to a function-form
// `create` param, preserving the exact runtime string Emotion would produce.
export default function Box(props) {
  return <div {...stylex.props(styles.box(`${props.gap}px`))}>Box</div>;
}

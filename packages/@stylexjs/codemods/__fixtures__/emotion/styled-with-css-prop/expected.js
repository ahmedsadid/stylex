import * as React from 'react';

import * as stylex from '@stylexjs/stylex';
import isPropValid from '@emotion/is-prop-valid';

const styles = stylex.create({
  panel: {
    padding: 8,
    color: 'navy',
  },

  button: {
    backgroundColor: 'red',
  },
});

const Button = React.forwardRef(function Button(props, ref) {
  const { as: As = 'button', className, style, ...rest } = props;
  const sx = stylex.props(styles.button);
  const shouldFilter = typeof As === 'string';
  const forwarded = {};
  for (const key in rest) {
    if (key === 'children' || !shouldFilter || isPropValid(key)) {
      forwarded[key] = rest[key];
    }
  }
  return React.createElement(As, {
    ref,
    ...forwarded,
    className: [sx.className, className].filter(Boolean).join(' '),
    style: { ...sx.style, ...style },
  });
});

export default function Panel() {
  return (
    <div {...stylex.props(styles.panel)}>
      <Button />
    </div>
  );
}

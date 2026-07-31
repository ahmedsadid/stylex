import * as stylex from '@stylexjs/stylex';
import * as React from 'react';
import isPropValid from '@emotion/is-prop-valid';

const styles = stylex.create({
  box: (color) => ({
    padding: '8px',
    color: color,
  }),
});

const Box = React.forwardRef(function Box(props, ref) {
  const { as: As = 'div', className, style, ...rest } = props;
  const sx = stylex.props(styles.box(props.color));
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

export default function App(props) {
  return <Box {...props}>hi</Box>;
}

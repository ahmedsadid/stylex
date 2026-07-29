import * as stylex from '@stylexjs/stylex';
import * as React from 'react';
import isPropValid from '@emotion/is-prop-valid';

const styles = stylex.create({
  button: {
    padding: '8px',
    color: 'red',
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

export default function App(props) {
  return <Button {...props}>Click</Button>;
}

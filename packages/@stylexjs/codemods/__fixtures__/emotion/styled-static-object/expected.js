import * as stylex from '@stylexjs/stylex';
import * as React from 'react';
import isPropValid from '@emotion/is-prop-valid';

const styles = stylex.create({
  card: {
    color: 'navy',
    marginInlineStart: 4,
  },
});

const Card = React.forwardRef(function Card(props, ref) {
  const { as: As = 'section', className, style, ...rest } = props;
  const sx = stylex.props(styles.card);
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
  return <Card {...props}>Body</Card>;
}

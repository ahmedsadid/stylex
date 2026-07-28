import { type Theme } from '@emotion/react';

import * as stylex from '@stylexjs/stylex';

// The inline `type Theme` specifier is non-blocking (M12): `css` converts and is
// dropped from the import, while `type Theme` is kept.
export function textColor(theme: Theme): string {
  return theme.colors.text;
}

const styles = stylex.create({
  panel: {
    padding: 8,
    color: 'navy',
  },
});

export default function Panel() {
  return <div {...stylex.props(styles.panel)} />;
}

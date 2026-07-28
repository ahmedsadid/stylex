import type { Theme } from '@emotion/react';

import * as stylex from '@stylexjs/stylex';

// `Theme` is used only as a type annotation — it emits no runtime CSS, so it no
// longer blocks the file (M12). The css prop converts; the type import stays.
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

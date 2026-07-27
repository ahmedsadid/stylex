/** @jsx jsx */
import { jsx } from '@emotion/react';

import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  a11yText: {
    overflow: 'hidden',
    position: 'absolute',
    height: 1,
    width: 1,
  },
});

// Classic css-prop runtime (`/** @jsx jsx */` + `import { jsx }`). The css prop
// converts; the pragma and jsx import are deliberately LEFT IN PLACE (removing
// the classic pragma could change the file's JSX runtime).
export default function A11yText() {
  return <span {...stylex.props(styles.a11yText)}>loading</span>;
}

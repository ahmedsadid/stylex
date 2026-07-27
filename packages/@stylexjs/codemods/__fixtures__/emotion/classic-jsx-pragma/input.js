/** @jsx jsx */
import { jsx } from '@emotion/react';

// Classic css-prop runtime (`/** @jsx jsx */` + `import { jsx }`). The css prop
// converts; the pragma and jsx import are deliberately LEFT IN PLACE (removing
// the classic pragma could change the file's JSX runtime).
export default function A11yText() {
  return (
    <span
      css={{
        label: 'a11yText',
        position: 'absolute',
        width: 1,
        height: 1,
        overflow: 'hidden',
      }}
    >
      loading
    </span>
  );
}

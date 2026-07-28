/** @jsxImportSource @emotion/react */
import { css, type Theme } from '@emotion/react';

const box = css({ padding: 8, color: 'navy' });

// The inline `type Theme` specifier is non-blocking (M12): `css` converts and is
// dropped from the import, while `type Theme` is kept.
export function textColor(theme: Theme): string {
  return theme.colors.text;
}

export default function Panel() {
  return <div css={box} />;
}

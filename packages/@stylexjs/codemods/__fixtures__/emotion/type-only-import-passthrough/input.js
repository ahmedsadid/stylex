/** @jsxImportSource @emotion/react */
import type { Theme } from '@emotion/react';

// `Theme` is used only as a type annotation — it emits no runtime CSS, so it no
// longer blocks the file (M12). The css prop converts; the type import stays.
export function textColor(theme: Theme): string {
  return theme.colors.text;
}

export default function Panel() {
  return <div css={{ padding: 8, color: 'navy' }} />;
}

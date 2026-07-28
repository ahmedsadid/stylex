import type { Theme } from '@emotion/react';

// A file whose only Emotion surface is a type-only import and that has no css /
// keyframes / pragma is a clean no-op — left unchanged, not refused (M12).
export function textColor(theme: Theme): string {
  return theme.colors.text;
}

/** @jsxImportSource @emotion/react */
import * as React from 'react';

// TS-only syntax (type alias, `satisfies`, non-null `!`, param/return types)
// that the Flow lint parser (hermes-eslint) rejects. The transform parses it
// with the TS parser and the lint gate now does too, so the css converts
// instead of the whole file refusing.
type Props = { label: string; gap: number };

const meta = { mode: 'a' } satisfies Record<string, string>;

export function Box({ label, gap }: Props): React.ReactElement {
  const first = [gap, 1][0]!;
  return (
    <div css={{ color: 'red', padding: first }}>
      {label}
      {meta.mode}
    </div>
  );
}

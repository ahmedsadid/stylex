/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Emits the StyleX replacement for a static host `styled()` definition (M15a):
 * a `React.forwardRef` wrapper that reproduces Emotion `styled`'s component
 * semantics — the parts a static gate can't see, all render-gate-verified
 * (M14c) against real `@emotion/styled`:
 *
 *   - the `as` prop (render a different element),
 *   - ref forwarding,
 *   - className / style MERGE (own StyleX output + the caller's),
 *   - prop-filtering: for a host element, non-DOM props are dropped via
 *     `@emotion/is-prop-valid` (a component `as` target gets every prop, like
 *     Emotion); `children` is always forwarded.
 *
 * Built by parsing a source template rather than hand-assembling the AST — the
 * shape is fixed and this keeps it readable and exactly the verified pattern.
 * Uses `React.createElement` (no JSX) so the emitted wrapper is pragma-neutral.
 */

export type WrapperSpec = {
  +componentName: string,
  // The base element: a host tag name like 'button' (styled.button /
  // styled('button')). Only host targets reach here; styled(Component) is
  // deferred (composition, a later slice).
  +baseTag: string,
  +stylesLocalName: string,
  +styleKey: string,
  // Printed prop-driven expressions for a dynamic styled (M15b), in the emitted
  // param order — e.g. `['props.color']` → `stylex.props(styles.key(props.color))`.
  // Empty/absent for a static styled → `stylex.props(styles.key)`.
  +args?: $ReadOnlyArray<string>,
};

/**
 * Returns the `const <Name> = React.forwardRef(...)` VariableDeclaration node
 * replacing the original `styled()` definition.
 */
export function buildStyledWrapper(
  j: $FlowFixMe,
  spec: WrapperSpec,
): $FlowFixMe {
  const { componentName, baseTag, stylesLocalName, styleKey, args } = spec;
  const styleRef =
    args != null && args.length > 0
      ? `${stylesLocalName}.${styleKey}(${args.join(', ')})`
      : `${stylesLocalName}.${styleKey}`;
  const src =
    `const ${componentName} = React.forwardRef(function ${componentName}(props, ref) {\n` +
    `  const { as: As = ${JSON.stringify(baseTag)}, className, style, ...rest } = props;\n` +
    `  const sx = stylex.props(${styleRef});\n` +
    "  const shouldFilter = typeof As === 'string';\n" +
    '  const forwarded = {};\n' +
    '  for (const key in rest) {\n' +
    "    if (key === 'children' || !shouldFilter || isPropValid(key)) {\n" +
    '      forwarded[key] = rest[key];\n' +
    '    }\n' +
    '  }\n' +
    '  return React.createElement(As, {\n' +
    '    ref,\n' +
    '    ...forwarded,\n' +
    "    className: [sx.className, className].filter(Boolean).join(' '),\n" +
    '    style: { ...sx.style, ...style },\n' +
    '  });\n' +
    '});';
  return j(src).find(j.VariableDeclaration).paths()[0].node;
}

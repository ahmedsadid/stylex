# Component contracts and composition

Emotion's `css` prop on a custom component depends on that component forwarding
the generated class name. The same syntax on a host element does not carry this
risk.

Before rewriting a custom component, inspect its declared inputs for:

- `className` and `style` forwarding;
- prop spread order and override behavior;
- ref forwarding;
- existing `stylex.props` or class-name merge utilities;
- tests or types that define the public contract;
- other call sites sharing the component or style binding.

Do not assume `{...props}` safely forwards StyleX output. The order of explicit
props and spreads can change which class, style object, event handler, or
attribute wins. Preserve user-supplied `className` behavior and do not silently
drop existing classes.

When a component does not accept the required StyleX props, changing its public
API or another file requires that path to be in `allowedPaths`. Otherwise stop
for replanning. When ownership intent is unclear, stop for an owner decision.

Build and typecheck results do not prove DOM shape, ref outcomes, forwarded
attributes, interactions, or rendered style precedence. Keep those limitations
in the handoff unless named runtime evidence covers them.

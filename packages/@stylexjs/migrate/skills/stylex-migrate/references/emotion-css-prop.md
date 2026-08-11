# Emotion CSS prop conversion

Preserve JavaScript and component behavior first. Convert styling syntax only
where the capsule facts and declared inputs support the rewrite.

## Host elements

For a stable style object, create a module-level `stylex.create` entry and
replace Emotion's `css` prop with `stylex.props(...)`. Reuse an existing StyleX
namespace import when present. Keep style definitions near the component unless
the repository's local convention clearly says otherwise.

Preserve composition order. Later Emotion styles can win through the CSS
cascade, while StyleX resolves conflicts through its property-priority model. Do
not flatten arrays, conditions, or mixed class-name/style composition unless the
task's facts and checks cover the ordering.

## Conditions and selectors

Translate supported pseudo-classes, pseudo-elements, media queries, and
`@supports` nesting into the StyleX object shape without changing condition
text. Preserve declaration order where the comparison model depends on it.
Generated keyframe names may differ; keyframe steps and declarations may not.

## Values and bindings

Literal values are the simplest case. An identifier is not a literal: inspect
its definition, imports, evaluation timing, and purity before moving it into a
module-level style definition. Never evaluate project code merely to obtain a
value. Use the runtime-values playbook when the value cannot be established
statically.

Do not inline module-level Emotion `css()` bindings by default. Their identity,
evaluation frequency, and use outside the current site may be observable even
when emitted CSS looks identical.

## Refuse or stop

Stop when the change needs an unlisted file, changes a public export, relies on
unresolved imports, alters effectful expression timing, or needs configuration.
Let the kernel report the structured outcome.

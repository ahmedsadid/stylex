# Themes and runtime-dependent values

Theme and dynamic-value work is contextual because syntax alone rarely proves
which value is active at runtime. Start from recorded facts and declared inputs,
not from assumptions about common Emotion patterns.

## Theme values

Trace the theme read to its provider, type, token declaration, and known theme
variants. Prefer existing repository StyleX variables. When the repository has
an explicit stable token contract, map it with `stylex.defineVars` and
`stylex.createTheme` using names and ownership consistent with local code.

Do not invent a token map from similarly named values. A snapshot, type, or
default theme does not prove dark mode, nested providers, tenant variants, or
runtime overrides. If a required provider or variant is outside declared inputs,
stop for replanning.

## Approved token-map workflow

Use the deterministic theme lane only when the inventory records exactly one
known literal definition for every declared variant and every consumer is one of
the bounded forms accepted by the proposer. The draft must declare:

- the current `inventoryId`;
- a new canonical `.stylex.js` or `.stylex.ts` target module;
- the variables export, default variant, and collision-free variant exports;
- every source token path, target token name, and concrete value for every
  variant;
- source-definition files and consumer files.

Values must reproduce the discovered definitions exactly. Do not insert
placeholders, infer missing variants, ignore unmapped reads, or declare an
existing CSS variable unless every mapped variant actually uses it. Unresolved
local dependencies block this lane.

The current deterministic boundary converts flat host-element Emotion `css`
objects/callbacks whose dynamic leaves are exact mapped theme reads. It also
converts an Emotion `ThemeProvider` only when its selected identifier resolves
directly to a declared theme source and it wraps a static host-only subtree.
It may also convert one local, non-exported intrinsic `@emotion/styled` tagged
template per consumer file when every interpolation is a synchronous
one-parameter callback whose body is exactly `props.theme.<mapped.path>`, every
interpolation occupies the whole declaration value, and the complete same-file
usage graph contains only direct safe JSX consumers. The definition and all of
those consumers are one atomic edit.

Spreads, class/style mixing, styled provider children, component or dynamic
descendants, props reads, computed theme expressions, selectors, at-rules,
embedded interpolations, exports, escapes, multiple eligible styled definitions
in one consumer file, undeclared variant sources, missing tokens, complex
providers, and target-module collisions refuse the whole proposal without
partial output.

Drafting does not authorize conversion. A named human must approve the exact
content-addressed map. Agents must stop at this boundary and must never invoke
the approval command. After approval, the kernel binds the approval hash to the
snapshot, candidate, evidence, and verdict; a newer active map invalidates older
dependent candidates.

## Runtime expressions

Classify each value:

- A stable literal can usually live in `stylex.create`.
- A finite boolean or enum state may select among predeclared styles when all
  branches and precedence are visible.
- A truly runtime numeric/string value may require a supported inline-style or
  dynamic StyleX pattern, subject to local lint/types and component semantics.
- An effectful, mutable, environment-dependent, or unresolved expression must
  not be hoisted or evaluated by the migration.

Preserve evaluation count and timing. Moving a function call from render time to
module initialization is a behavior change even if its current result looks
constant.

## Evidence boundary

Repository tests establish only the checks they run. A configured runtime
provider may compare named theme states, interactions, and viewports against the
retained baseline. Report `runtime-matched` only when the verdict contains that
claim, and name its case scope. Typecheck, lint, build, snapshots, an
unavailable browser, or partial case coverage never earn the claim.

For styled theme work, require cases for the relevant approved light/dark states
when rendered token behavior is part of the review claim. Under the permissive
policy, missing runtime evidence may leave an otherwise passing candidate
eligible for human review, but only with the exact no-runtime warning. It does
not verify theme substitution, provider scope, hover/state behavior, or rendered
values.

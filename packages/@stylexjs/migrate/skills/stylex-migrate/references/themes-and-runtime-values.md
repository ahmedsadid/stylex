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
runtime overrides. If a required provider or variant is outside declared
inputs, stop for replanning.

## Runtime expressions

Classify each value:

- A stable literal can usually live in `stylex.create`.
- A finite boolean or enum state may select among predeclared styles when all
  branches and precedence are visible.
- A truly runtime numeric/string value may require a supported inline-style or
  dynamic StyleX pattern, subject to local lint/types and component semantics.
- An effectful, mutable, environment-dependent, or unresolved expression must
  not be hoisted or evaluated by the migration.

Preserve evaluation count and timing. Moving a function call from render time
to module initialization is a behavior change even if its current result looks
constant.

## Evidence boundary

Repository tests can establish only the checks they run. Until M8 runtime
providers exercise named theme states and interactions, report the explicit
runtime limitation. Never call a theme conversion runtime-matched merely
because typecheck, lint, build, or snapshots passed.

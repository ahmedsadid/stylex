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

Use the deterministic theme lane only when every requested token path resolves
exactly once from a pinned variant entry module and every consumer is one of the
bounded forms accepted by the proposer. The resolver follows only supported
object properties, spreads, aliases, zero-argument object helpers, and local or
configured-path imports. It does not execute repository code. The draft must
declare:

- the current `inventoryId`;
- a new canonical `.stylex.js` or `.stylex.ts` target module;
- the variables export, default variant, and collision-free variant exports;
- every source token path and target token name, or omit `tokens` so the CLI
  scaffolds them from known reads in the exact consumer files;
- source-definition files and consumer files.

The CLI resolves concrete values for every variant, pins each variant's actual
entry module, and expands source files to the transitive modules consulted.

Values must reproduce the discovered definitions exactly. Do not insert
placeholders, infer missing variants, ignore unmapped reads, or declare an
existing CSS variable unless every mapped variant actually uses it. Unresolved
local dependencies block this lane.

The current deterministic boundary converts flat host-element Emotion `css`
objects/callbacks whose dynamic leaves are exact mapped theme reads. It also
converts an Emotion `ThemeProvider` only when its selected identifier resolves
directly to a declared theme source and it wraps a static host-only subtree. It
may also convert one local, non-exported intrinsic `@emotion/styled` tagged
template per consumer file when every interpolation is a synchronous
one-parameter callback whose body is exactly `props.theme.<mapped.path>`, every
interpolation occupies the whole declaration value, and the complete same-file
usage graph contains only direct safe JSX consumers. The definition and all of
those consumers are one atomic edit. By default, every converted styled consumer
must also be inside a same-file `ThemeProvider` subtree selected by an exact
declared variant. The proposal removes that provider and applies the matching
StyleX theme to the same generated host subtree in the same atomic patch.

A human-approved draft may instead declare repository-managed bridge coverage.
The decision pins exact bridge boundary files and coverage globs. Covered
consumers need not have a same-file provider because the repository integration
owns root, nested, portal, and inverted theme propagation. This is deliberately
permissive: hash-pinning establishes which boundary code was reviewed, not that
its provider graph is complete. The approval and verdict retain a prominent
warning, and runtime cases are required before claiming `runtime-matched`.

Before recommending approval for a new bridge, open a bridge integration task
from the exact draft. The kernel emits and locks the target StyleX module; edit
only the declared boundary files. Apply each generated variant through
`stylex.props` using the same runtime selection source as the existing Emotion
theme, while retaining the Emotion provider. Do not add a semantic wrapper or a
global `documentElement` mutation without an explicit owner decision. Frozen
static observation must see every variant, but it cannot establish selection,
nesting, portals, inversion, SSR, hydration, or switching behavior. Those need
repository-owned light/dark runtime cases.

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

Open only a planned `styled-dynamic-intrinsic` contextual cluster. Read every
`emotion-styled-dynamic-value` fact and the complete usage fact. The dynamic
fact is a syntax observation: `propPaths`, conditional counts, calls,
assignments, computed accesses, and merge flags do not establish types, purity,
domains, or runtime behavior.

Before `context open`, write a temporary strategy definition outside the source
checkout and persist it with:

```text
stylex-migrate dynamic strategy draft <json-file> <agent|human> <author>
stylex-migrate dynamic strategy inspect <draft-id>
```

The definition must cover every and only the observed prop paths in the current
cluster:

```json
{
  "protocolVersion": "stylex-migrate-dynamic-strategy-v1",
  "inventoryId": "<current-inventory-id>",
  "clusterId": "<planned-cluster-id>",
  "entries": [
    {
      "definitionFactId": "<emotion-styled-readiness-fact-id>",
      "propPath": "active",
      "strategy": "stylex-variants",
      "rationale": "The repository contract establishes a boolean domain.",
      "evidenceRequirements": ["Exercise active=false and active=true."]
    }
  ]
}
```

Allowed strategies are `stylex-variants`, `css-variable`, `inline-style`,
`upstream-computation`, `api-refactor`, and `retain-emotion`. Retention applies
to an entire definition: do not mix `retain-emotion` with conversion strategies
across prop paths of the same definition. An all-retained cluster does not open
a conversion task. A strategy authored by a human has no extra authority; this
protocol is not an approval boundary.

Before choosing a strategy, resolve or explicitly retain as unknown:

1. The value domain, including nullish and fallback behavior.
2. Getter/function purity, evaluation count, and evaluation timing.
3. Whether styling-only props reach the rendered element today.
4. Existing `style`, `className`, and spread merge order.
5. Server/client, hydration, and serialization behavior.
6. The repository evidence that observes the affected states.

Choose the narrowest strategy whose preconditions are established:

- Use StyleX variants for a finite boolean or enum only when every branch and
  precedence relationship is known. Do not infer an enum merely because a
  conditional has literal branches.
- Use a StyleX-supported CSS custom-property pattern for a runtime scalar only
  when the property accepts it, serialization/null handling is preserved, and
  the repository compiler supports that pattern.
- Merge an inline `style` value only when StyleX cannot represent the value and
  exact existing style precedence is preserved. Never overwrite an existing
  style object or silently change which side wins.
- Move computation upward only when the new location preserves count, timing,
  effects, and server/client behavior.
- Refactor an API only when ownership and the complete local contract are in
  scope.
- Retain Emotion when none of the above is bounded and evidence-backed.

Preserve styling-prop filtering. Removing a styled host can leak props to the
DOM even when the visual result looks correct. Preserve element type, DOM shape,
refs, attributes, class/style order, and falsy/null behavior. Moving a function
call from render time to module initialization is a behavior change even if its
current result looks constant.

Submission checks the exact frozen candidate under `dynamic-strategy-wiring-v1`.
It rejects a remaining converted Emotion binding or old JSX consumer, missing
`stylex.props` wiring, lost explicit `className` or `style` merge surfaces,
newly forwarded styling props or unknown intrinsic spreads, changed retained
definitions, and narrow variant/custom-property strategies applied to callbacks
with opaque operations. These checks are deliberately syntactic and count-based.
They do not establish value domains, expression equivalence, evaluation
semantics, CSS serialization, cascade, or rendered behavior. Satisfy the
strategy's evidence requirements through repository-owned checks and named
runtime cases.

At handoff, name the chosen strategy per prop path, every fact used, every
remaining unknown, the checks/cases that exercised each branch, and any retained
Emotion boundary. Do not report a conversion percentage or generalize sampled
runtime evidence beyond its named cases.

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

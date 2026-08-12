# Runtime evidence

Run `stylex-migrate runtime inspect` first. Prefer a `known` repository-native
Playwright, Storybook, or component-test surface. `inferred` means dependencies
were observed without an executable surface; it is not configured evidence.

Runtime evidence has three different baseline modes:

1. A retained-repository baseline runs the same argv and allowlisted environment
   in two detached worktrees: the exact base commit and frozen candidate. This
   is the current `runtime-command` mode.
2. A repository-assertion baseline relies on an existing test/story assertion.
   Report it as repository evidence unless it emits the complete runtime
   protocol.
3. A generated probe compares named candidate observations with independently
   locked expected observations. It is not a retained baseline and must never be
   labelled as one.

The dynamic component generator is a retained-repository mode even though the
harness itself is generated: the same immutable harness renders the original
component in the detached baseline and the exact converted component in the
candidate workspace.

## Open a generated probe

Use this only when `runtime inspect` finds no `known` native surface capable of
the named case. If a known surface exists but cannot exercise the case, set
`nativeSurfaceDisposition` to `known-insufficient` and state the exact reason;
otherwise use `none-known`. Do not use that field to avoid integrating a usable
repository test.

1. Record and inspect a test assumption whose `scope.files` contains every
   migration path the cases will cover and whose `scope.cases` contains every
   case ID.
2. Create a temporary definition outside the source checkout with protocol
   `stylex-migrate-evidence-surface-v2`. Declare the package root, resolvable
   Playwright package, local HTTP server argv/cwd/URL, cases, selectors,
   actions, target properties/attributes, exact expected observations,
   rationale, and limitations. Commands are argv arrays; never use a shell
   string. The server may be only an exact package script or a declared tracked
   Node script; list every server input so the task snapshot pins it. Inline
   evaluation and arbitrary executables are rejected. Expectations have no
   browser metadata because they are values, not a fabricated baseline
   execution.
3. Run `stylex-migrate runtime probe open <assumption-id> <json-file> "<goal>"`.
   Read its task and warnings. The kernel generates and locks the collector and
   config; do not edit either file.
4. Submit the task immediately with `context submit` and inspect its candidate
   diff. The probe candidate changes only `.stylex-migrate-probes` files.
5. Run one `verify` command containing the probe candidate and all consumer,
   bridge, or dynamic candidates named by `case.changePaths`. The verifier
   automatically attaches the generated provider to that exact candidate set. It
   rejects a case that names a path or site absent from the set.

The collector starts only the declared local server, loads Playwright lazily
from the declared package root, exercises every named action, and emits the
complete runtime protocol. The definition is declarative; it does not permit
agent-authored JavaScript or shell execution.

The tool does not silently choose representative states. When a developer allows
inferred test inputs, record them with `stylex-migrate assumption record`,
inspect the artifact, and bind its ID to the contextual task. A test assumption
cannot earn approval.

## Open a retained dynamic component probe

Use this after persisting a current dynamic strategy when the exact exported
component can render from JSON-safe props without routing, providers, network
data, or agent-authored JavaScript. Prefer a repository-owned test when one can
exercise the same cases.

1. Record a test assumption whose files include the component and every source
   used to justify the prop cases. Name every case ID explicitly.
2. Create a temporary `stylex-migrate-dynamic-runtime-probe-v2` JSON definition
   outside the repository. Declare one safe repository-relative consumer file,
   its named export, the dynamic site IDs, JSON-safe props for each case,
   target selectors, computed properties, public attributes, DOM/ref
   observations, viewport, rationale, and limitations. The generator accepts
   data only; it does not accept wrapper code or arbitrary imports.
3. Run
   `stylex-migrate dynamic probe open <strategy-id> <assumption-id> <json-file> "<goal>"`.
   Submit the returned task immediately without changing any required output.
4. Verify the probe candidate together with the exact dynamic candidate and any
   bootstrap candidate required to compile it. The verifier runs the same
   harness twice: retained repository plus probe files for the baseline, and
   bootstrap plus migration plus probe files for the candidate.

Observe contract-relevant output, not implementation details chosen by the
strategy. For example, a CSS-variable strategy should compare the resulting
computed value and public prop filtering; compare the raw internal `style`
attribute only when its byte representation is itself a required contract.

Generated component probes are deliberately narrow. If the component needs a
theme provider, router, application store, localization initialization, or
other context, use a repository-native surface or record the case as not
runtime-covered. Do not expand the declarative input into executable fixture
code.

Each provider declares case IDs, changed paths, site IDs, theme, interaction,
and viewport. Its command must print one `stylex-migrate-runtime-v1` JSON report
to stdout. The report records computed styles, DOM shape, forwarded attributes,
ref outcomes, interactions, and the renderer/browser environment.

For themes, run `stylex-migrate theme topology` and name root/global hosts,
same-document portals, secondary documents, and uncovered topology explicitly. A
body-host probe must include separate light/dark root and portal cases. A
generated portal probe does not prove that a real migrated component renders in
that portal.

Prefer `stylex-migrate theme probe open` over constructing those four theme
cases manually. Its input protocol is `stylex-migrate-theme-runtime-probe-v2`.
Declare `surface` as either `repository` or `generated-rspack`, plus:

- the package root, Playwright package, native-surface disposition, one `path`,
  exact `testedConsumerFiles`, optional `siteIds`, and viewport;
- `activation.light` and `activation.dark` declarative action arrays;
- `targets.root` and `targets.portal`, each with a selector and one or more
  `{sourcePath, cssProperty}` mappings; and
- an explicit `numberSerialization` of `raw`, `px`, or `ms` when a mapped draft
  value is numeric.

For `surface: "repository"`, also declare the generic probe's exact server
fields and at least one tested consumer. The resulting cases cover the generated
theme module, bridge boundaries, and named consumers. For
`surface: "generated-rspack"`, omit `server`, allow an empty consumer list, and
use the locked selectors `[data-stylex-migrate-probe="root"]` and
`[data-stylex-migrate-probe="portal"]`. The kernel then emits a locked Rspack
entry, config, and local server around the exact generated theme module. This
fallback requires the candidate dependency graph to provide StyleX, the StyleX
Rspack unplugin, Rspack, and Playwright; compose it with the bootstrap candidate
when the repository did not already provide them.

To render one real, zero-configuration exported consumer in that harness, add
`generatedConsumer: {file, exportName}`, make `testedConsumerFiles` contain
exactly that file, and use the locked child selectors
`[data-stylex-migrate-probe="root"] > *` and
`[data-stylex-migrate-probe="portal"] > *`. The named export is compiled as TSX
and mounted with the repository's React runtime. The resulting cases cover that
consumer and the draft target module. This mode does not synthesize props,
providers, routing, data, or application context; use a repository surface for
consumers that require any of those.

The tool requires the persisted draft to contain exact `light` and `dark`
variants, validates every source path and consumer, and generates
`theme-light-root`, `theme-light-portal`, `theme-dark-root`, and
`theme-dark-portal`. It locks raw source values from the draft. In Playwright it
normalizes those values on a blank page using the mapped CSS properties, then
observes the candidate route separately in the same browser context. This is a
synthetic source-value oracle, not a retained repository baseline. It compares
only the exact computed declarations; repository DOM, ref, attribute, and
interaction contracts require separate cases or repository-native evidence.

For a repository surface, all four cases cover the draft target, bridge, and
named consumers. A synthetic-only generated surface covers only the draft target
module. A `generatedConsumer` surface covers the one named consumer and the
draft target, including React rendering, but still does not execute the
repository bridge or application route. Never attach the resulting
`runtime-matched` claim to those uncovered paths.

The test assumption must name all four case IDs and every generated
`changePath`. Variant actions and selectors remain labelled repository-wiring
assumptions; the generator does not turn them into owner decisions. Run:

`stylex-migrate theme probe open <draft-id> <assumption-id> <json-file> "<goal>"`

Submit the resulting evidence-surface candidate unchanged. Verify it together
with candidates that actually change every path named by its cases. If the
generated Rspack surface depends on a bootstrap candidate, include both in the
same verification command: bootstrap setup runs to a pass before the browser
provider starts. A failed or unavailable setup skips browser evidence. A draft
hash is bound independently from the assumption hash; changing either
invalidates the evidence subject and cache key.

## Interpret results literally

- `matched`: all declared cases were present and exact observations matched.
- `different`: at least one recorded observation changed; verification rejects.
- `incomplete`: a declared case was missing or an undeclared case appeared; no
  runtime claim is allowed.
- `incomparable`: baseline and candidate used different environments; treat it
  as unavailable, not as a pass.
- `not-configured` or `unavailable`: continue only under the reported permissive
  policy and repeat the prominent no-runtime warning.

For an approved styled theme candidate, declare separate cases for each
light/dark state whose mapped values matter. A default-theme case cannot stand
in for dark mode, and repository tests alone cannot establish that the
replacement variables are selected under the same provider scope.

Read `runtimeCoverage.entries` for exact path/site/case coverage. Read the
`runtime-matched` claim for its scope and environment. Never generalize a match
beyond the named cases, states, viewports, and environment, and never call it
runtime equivalence.

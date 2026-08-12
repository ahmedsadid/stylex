# Runtime evidence

Run `stylex-migrate runtime inspect` first. Prefer a `known` repository-native
Playwright, Storybook, or component-test surface. `inferred` means dependencies
were observed without an executable surface; it is not configured evidence.

Runtime evidence has three different baseline modes:

1. A retained-repository baseline runs the same argv and allowlisted
   environment in two detached worktrees: the exact base commit and frozen
   candidate. This is the current `runtime-command` mode.
2. A repository-assertion baseline relies on an existing test/story assertion.
   Report it as repository evidence unless it emits the complete runtime
   protocol.
3. A generated probe compares named candidate observations with independently
   locked expected observations. It is not a retained baseline and must never
   be labelled as one.

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
3. Run `stylex-migrate runtime probe open <assumption-id> <json-file>
   "<goal>"`. Read its task and warnings. The kernel generates and locks the
   collector and config; do not edit either file.
4. Submit the task immediately with `context submit` and inspect its candidate
   diff. The probe candidate changes only `.stylex-migrate-probes` files.
5. Run one `verify` command containing the probe candidate and all consumer,
   bridge, or dynamic candidates named by `case.changePaths`. The verifier
   automatically attaches the generated provider to that exact candidate set.
   It rejects a case that names a path or site absent from the set.

The collector starts only the declared local server, loads Playwright lazily
from the declared package root, exercises every named action, and emits the
complete runtime protocol. The definition is declarative; it does not permit
agent-authored JavaScript or shell execution.

The tool does not silently choose representative states. When a developer
allows inferred test inputs, record them with `stylex-migrate assumption
record`, inspect the artifact, and bind its ID to the contextual task. A test
assumption cannot earn approval.

Each provider declares case IDs, changed paths, site IDs, theme, interaction,
and viewport. Its command must print one `stylex-migrate-runtime-v1` JSON report
to stdout. The report records computed styles, DOM shape, forwarded attributes,
ref outcomes, interactions, and the renderer/browser environment.

For themes, run `stylex-migrate theme topology` and name root/global hosts,
same-document portals, secondary documents, and uncovered topology explicitly.
A body-host probe must include separate light/dark root and portal cases. A
generated portal probe does not prove that a real migrated component renders in
that portal.

Prefer `stylex-migrate theme probe open` over constructing those four theme
cases manually. Its input protocol is `stylex-migrate-theme-runtime-probe-v1`.
Declare the server fields used by a generic generated probe plus:

- one `path`, exact `testedConsumerFiles`, optional `siteIds`, and viewport;
- `activation.light` and `activation.dark` declarative action arrays;
- `targets.root` and `targets.portal`, each with a selector and one or more
  `{sourcePath, cssProperty}` mappings; and
- an explicit `numberSerialization` of `raw`, `px`, or `ms` when a mapped draft
  value is numeric.

The tool requires the persisted draft to contain exact `light` and `dark`
variants, validates every source path and consumer, includes the draft's target
module and bridge boundary files in all four cases, and generates
`theme-light-root`, `theme-light-portal`, `theme-dark-root`, and
`theme-dark-portal`. It locks raw source values from the draft. In Playwright it
normalizes those values on a blank page using the mapped CSS properties, then
observes the candidate route separately in the same browser context. This is a
synthetic source-value oracle, not a retained repository baseline. It compares
only the exact computed declarations; repository DOM, ref, attribute, and
interaction contracts require separate cases or repository-native evidence.

The test assumption must name all four case IDs and every generated
`changePath`. Variant actions and selectors remain labelled repository-wiring
assumptions; the generator does not turn them into owner decisions. Run:

`stylex-migrate theme probe open <draft-id> <assumption-id> <json-file> "<goal>"`

Submit the resulting evidence-surface candidate unchanged. Verify it together
with candidates that actually change every named theme-module, bridge, and
consumer path. A draft hash is bound independently from the assumption hash;
changing either invalidates the evidence subject and cache key.

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

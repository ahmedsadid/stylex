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
   be labelled as one. Do not hand-build this mode until the task/kernel exposes
   a generated-probe contract.

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

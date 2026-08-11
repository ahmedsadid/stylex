# Runtime evidence

Runtime evidence is repository-owned. The tool does not reconstruct an app or
silently choose representative states. A configured runtime command receives the
same argv and allowlisted environment in two detached worktrees: the exact base
commit and the frozen candidate.

Each provider declares case IDs, changed paths, site IDs, theme, interaction,
and viewport. Its command must print one `stylex-migrate-runtime-v1` JSON report
to stdout. The report records computed styles, DOM shape, forwarded attributes,
ref outcomes, interactions, and the renderer/browser environment.

## Interpret results literally

- `matched`: all declared cases were present and exact observations matched.
- `different`: at least one recorded observation changed; verification rejects.
- `incomplete`: a declared case was missing or an undeclared case appeared; no
  runtime claim is allowed.
- `incomparable`: baseline and candidate used different environments; treat it
  as unavailable, not as a pass.
- `not-configured` or `unavailable`: continue only under the reported permissive
  policy and repeat the prominent no-runtime warning.

Read `runtimeCoverage.entries` for exact path/site/case coverage. Read the
`runtime-matched` claim for its scope and environment. Never generalize a match
beyond the named cases, states, viewports, and environment, and never call it
runtime equivalence.

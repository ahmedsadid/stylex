# Phase C and post-Phase-C backlog

Status: authoritative working backlog. Update this file when a capability is
completed, split, deferred, or rejected.

## Purpose

This file answers two different questions without conflating them:

1. What must still ship before the planned Phase C mechanical expansion is
   complete?
2. What deterministic ideas remain available afterward, but are not allowed to
   delay the vendor-neutral contextual workflow?

Every admitted mechanical capability still requires its own versioned model,
independent Emotion and StyleX observations, refusal boundary, mutation
manifest, policy version, end-to-end candidate test, and exit review.

## Completed Phase C capabilities

- [x] Flat literal host-element Emotion `css` props.
- [x] Referee model and compiler-fact fixtures.
- [x] Sibling `:hover` and `:focus` conditions with simultaneous-state
      comparison.
- [x] Flat `::before` and `::after` selector targets.
- [x] One exact `@media` query per style object.
- [x] One exact `@supports` query with at most one exact `@media` intersection,
      authored in either wrapper order and bounded to two at-rule levels.
- [x] One referenced `@keyframes` rule with literal `from` and `to` frames,
      compared through generated-name alpha-renaming without adding a binding.
- [x] Physical `margin` and `padding` shorthands with one to four simple static
      components, independently expanded and compared with longhand conflicts
      resolved in authored order.
- [x] Logical margin/padding inline/block edges and inline/block sizes under a
      six-state direction/writing-mode referee. Unsafe StyleX physical lowering
      is refused rather than treated as equivalent.
- [x] Direct render-local `css({...})` calls through an unshadowed named Emotion
      import, with one closed flat literal argument, non-escaping result, and
      evidence-bound call-integrity safeguards.

## Required before Phase C closes

- [x] Corpus closeout. See `[codex] M6-phase-c-corpus-closeout.md`.
  - Run the correctness-gated capabilities over representative repositories.
  - Report coverage and refusal reasons without presenting a conversion
    percentage as a safety claim.
  - Use the results to order the post-Phase-C backlog.

Phase C closed on 2026-08-10. The permanent capability corpus exercises all nine
approved comparison models. Pinned react-select and Sentry runs recorded
real-repository coverage, refusal boundaries, and the project-activation seam.

## Ordered work after Phase C

This is the default pickup order. The detailed contracts and exit criteria live
in `[codex] stylex-migrate-implementation-plan-m2-forward.md`.

### M7 — Vendor-neutral contextual protocol

- [ ] Bind known project-activation facts and every inspected config hash into
      deterministic proposal inputs, candidates, evidence, and stale checks.
      Never reduce the fact to an unbound boolean.
- [ ] Add the versioned task-capsule schema: goal, cluster, declared inputs,
      certainty-bearing facts, allowed/protected paths, decisions, required
      checks, limitations, stop conditions, and prior failures.
- [ ] Add vendor-neutral `SKILL.md`, protocol references, concept playbooks, and
      stable `stylex-migrate` command reference with no vendor manifest in core.
- [ ] Add commands to open, inspect, submit, and abandon contextual candidate
      workspaces.
- [ ] Implement the kernel-owned two-attempt lifecycle and structured
      `needs-replan`, `needs-owner-decision`, and `blocked` outcomes.
- [ ] Prove manual, Codex-assisted, and simulated external-agent work enters the
      same candidate/evidence boundary; prove explanations cannot excuse
      out-of-scope edits.

### M8 — Optional runtime evidence

- [ ] Add comparator contracts for computed styles, DOM shape, forwarded
      attributes, refs, interactions, themes, and viewports.
- [ ] Add lazy provider interfaces for repository-native tests, Storybook,
      Playwright/component tests, and project-supplied harnesses.
- [ ] Bind original and candidate builds to the same snapshot and record
      per-site/per-case coverage.
- [ ] Preserve permissive contextual acceptance with ample warnings: runtime
      failure rejects; unavailable never passes; explicit approval may accept
      repository-check-only evidence with the no-runtime limitation.
- [ ] Mutation-test partial coverage and seeded render regressions.

### M9 — Theme decision workflow

- [ ] Discover theme definitions, providers, reads, aliases, variants, casts,
      and existing CSS variables for pinned repository shapes.
- [ ] Add a token-map decision schema, collision detection, canonical target
      identity, separate approval events, and deterministic application.
- [ ] Bind decision hashes into snapshots, candidates, evidence, and verdicts;
      changing a map must invalidate dependents.
- [ ] Complete two pinned repository slices without placeholder values or false
      runtime claims.

### M10 — Pilot and scope decision

- [ ] Compare ordinary agent-assisted work with the control-plane workflow on
      pinned repositories.
- [ ] Measure human time, attempts, evidence availability, wall time, token
      cost, mutation score, reviewer interventions, and accepted regressions.
- [ ] Decide from observed value whether to broaden contextual automation,
      narrow to mechanical plus decisions, or stop the agent layer.

### Later milestones, gated by M10

- [ ] M11 dynamic-values playbook.
- [ ] M12 styled-component clusters.
- [ ] M13 composition and pattern promotion.
- [ ] M14 styled-components source adapter.
- [ ] M15 CSS Modules source adapter.
- [ ] M16 publication, packaging, schema stabilization, and public corpus
      report.

## Post-Phase-C deterministic backlog

These are not prerequisites for M7. Promote one only when repository evidence
shows that the expected coverage justifies a new comparison model.

- [ ] Additional shorthand families or directional constructs excluded by the
      first conflict models. This is first in the deterministic queue because
      the react-select corpus recorded seven shorthand refusals.
- [ ] Additional pseudo-classes, including `:active` and `:focus-visible`.
- [ ] Additional pseudo-elements such as `::placeholder`, `::marker`, and
      `::selection`.
- [ ] Conditions nested inside pseudo-elements.
- [ ] Multiple media queries, including overlapping ranges and StyleX's query
      rewriting.
- [ ] Media queries combined with pseudo-classes or pseudo-elements.
- [ ] Multiple simultaneously active modifier families.
- [ ] Compound, functional, relational, and more deeply nested selectors.
- [ ] Additional at-rules beyond the explicitly modeled supports/media subset.
- [ ] Keyframe syntax beyond the first alpha-renamable grammar.
- [ ] Classify Emotion-only metadata such as `label` during discovery instead of
      waiting for the StyleX lint gate. This is diagnostic quality, not a new
      conversion capability.

## Contextual-only boundary

These remain outside deterministic conversion unless a future architecture
supplies new independent evidence. They should route through M7 rather than be
quietly added to Phase C.

- Module-level or shared `css()` binding inlining.
- `@emotion/styled` definitions and their consumer clusters.
- JSX spreads, existing `className`/`style`, and custom-component prop
  forwarding where merge behavior or public contracts require context.
- Template-literal styles outside a separately modeled static grammar.
- Dynamic identifiers whose values require JavaScript evaluation.
- Effectful expressions or getters.
- Changes to evaluation frequency or timing.
- Binding-identity changes.
- Cross-file class composition without complete repository facts.
- Runtime prop merging, theme behavior, or rendered behavior inferred from
  static CSS alone.

## Phase C completion rule

Phase C closes when every item in "Required before Phase C closes" is either
implemented through the candidate boundary or explicitly moved to another phase
with the architecture document updated. Open items in the post-Phase-C backlog
do not block M7.

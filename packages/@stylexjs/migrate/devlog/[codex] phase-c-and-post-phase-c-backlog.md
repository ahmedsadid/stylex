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

## Required before Phase C closes

- [ ] Supports queries and bounded nesting.
  - Define the independently comparable `@supports` grammar.
  - Define the maximum nesting depth and allowed modifier combinations.
  - Refuse unknown at-rules and rewritten conditions the model cannot compare.
- [ ] Keyframes with generated-name alpha-renaming.
  - Compare frame selectors, declaration meaning, and animation references while
    ignoring generated identifier spelling only where binding is preserved.
- [ ] Shorthands after explicit expansion and cascade modeling.
  - Expand through an independently tested CSS model.
  - Compare reset behavior, order, importance, and longhand conflicts.
- [ ] Logical/physical properties after conflict modeling.
  - Account for direction and writing mode rather than comparing only LTR rule
    text.
  - Refuse any case whose directional winner is not represented.
- [ ] Render-local `css()` calls.
  - Prove evaluation count, timing, purity requirements, and binding identity
    are unchanged.
  - Keep module-level/shared bindings outside the mechanical lane.
- [ ] Corpus closeout.
  - Run the correctness-gated capabilities over representative repositories.
  - Report coverage and refusal reasons without presenting a conversion
    percentage as a safety claim.
  - Use the results to order the post-Phase-C backlog.

## Post-Phase-C deterministic backlog

These are not prerequisites for M7. Promote one only when repository evidence
shows that the expected coverage justifies a new comparison model.

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
- [ ] Additional shorthand families or directional constructs excluded by the
      first conflict models.

## Contextual-only boundary

These remain outside deterministic conversion unless a future architecture
supplies new independent evidence. They should route through M7 rather than be
quietly added to Phase C.

- Module-level or shared `css()` binding inlining.
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

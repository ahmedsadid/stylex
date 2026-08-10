# M6.1 referee design report

Status: proposed for review. This milestone does not enable conditional conversion.

## Decision

The first condition capability should support only sibling `default`, `:hover`, and `:focus` branches for ordinary declarations on one host element.

That is intentionally narrow, but it is not trivial. `:hover` and `:focus` can be active simultaneously. Emotion gives equal-specificity rules to the branch authored later. StyleX assigns the two selectors different compiler priorities. A conversion is eligible only when both systems choose the same declaration in all four activation states:

- neither active;
- only `:hover` active;
- only `:focus` active;
- both active.

The tool must refuse a file when the winners differ. It must not reorder the author's conditions to manufacture a match.

## What is pinned

`stylex-compiler-facts-v1` records output observed from `@stylexjs/babel-plugin` 0.19.0:

- normalized CSS rule text;
- generated class names;
- left-to-right and right-to-left rule output;
- compiler priority;
- compiled application code;
- exact probe source and hash.

The fixture covers representative shorthand, ordinary longhand, physical longhand, pseudo-class, at-rule, and pseudo-element priorities. It is a compatibility alarm, not a priority table copied into the migration package. A StyleX upgrade that changes any observed output requires explicit fixture review.

One useful finding is already visible: `:focus-visible` currently receives priority 3040 in the pinned compiler while `:hover` receives 3130 and `:focus` receives 3150. Whether intentional or not, that is enough reason to exclude `:focus-visible` from the first grammar instead of assuming its order from its name.

## Referee representation

Every declaration carries:

- canonical property and value;
- importance;
- pseudo-element target;
- selector specificity as an `(id, class, type)` tuple;
- activation conditions;
- source order;
- StyleX compiler priority on the target side only.

The source order comes from CSS emitted by Emotion's serializer. The target order is derived from priority observed in StyleX compiler metadata. A caller cannot independently assert a favorable StyleX order.

For each activation state, the referee partitions declarations by property and pseudo-element target, applies importance, specificity, and effective source order, and compares the winning values. A single differing state produces a mismatch with both winning declaration identities and values.

## Proposed first grammar

All of these restrictions must hold:

- Existing M2 mechanical restrictions still apply: literal values, host elements, local static object syntax, no JavaScript evaluation or binding changes, and no shorthand interaction.
- Conditions are sibling `:hover` and `:focus` branches, plus the unconditional declaration.
- A declaration has zero or one condition. Compound conditions are not admitted.
- A property appears at most once in each condition branch.
- Selectors have exactly the specificity emitted for one generated class, optionally followed by one admitted pseudo-class.
- Declarations are ordinary, not important, and target the element itself rather than a pseudo-element.
- Both libraries must emit CSS that the bounded observation parser understands.
- Every possible activation state must choose the same winning value.
- StyleX priority must come from the compiler execution that produced the candidate CSS.

This grammar admits condition order only when it is semantically compatible. For example:

```js
{
  color: 'base',
  ':hover': { color: 'hover' },
  ':focus': { color: 'focus' },
}
```

is compatible with the pinned compiler because `:focus` wins when both states are active in both systems. Reversing the two conditional branches is not compatible: Emotion then chooses `:hover`, while StyleX still chooses `:focus`.

## Explicit refusals

The first capability refuses:

- `!important`;
- cascade layers or any dependency on layer order;
- pseudo-elements;
- media, supports, container, scope, starting-style, and other at-rules;
- sibling at-rule carving, including moving one condition out of an authored object when adjacent rules may affect order;
- `:focus-visible`, `:active`, functional pseudo-classes, compound selectors, relational selectors, and unknown selectors;
- compound conditions or condition implication assumptions;
- shorthands, logical/physical conflicts, custom properties, and fallback declaration lists;
- keyframes and generated-name comparison;
- cross-file style composition or external stylesheet competition;
- multiple StyleX values whose equal priority would require modeling the compiler's complete rule-text tie-break;
- runtime `style`, `className`, or conditional `stylex.props` merging;
- component props that alter which style objects are applied;
- dynamic values, identifiers, spreads, getters, calls, or other effectful expressions;
- public component behavior, prop forwarding, refs, DOM shape, interactions, and theme state.

Unknown syntax is a refusal, never an inactive condition and never an empty rule.

## Independence and claim boundary

The source observation uses `@emotion/serialize`. The target observation uses the actual StyleX Babel compiler and its metadata. PostCSS parses both resulting CSS texts, but the migration converter does not create either baseline.

Passing the referee can support a versioned static cascade-match claim for the exact declarations and enumerated states. It cannot establish runtime equivalence, reachability of states in a real DOM, browser support, JavaScript behavior, interaction behavior, or competition from CSS outside the declared input set.

The model is named `cascade-referee-v1-spec` while it remains a specification artifact. M6.2 must use a new policy/comparison version when the capability is connected to candidate eligibility.

## Tests and mutation obligations

The current fixtures establish that:

- observed StyleX compiler output matches the pinned versioned fixture;
- all four `:hover`/`:focus` activation states are enumerated;
- compatible source order passes;
- reversed Emotion condition order fails in the simultaneous state;
- mutating the observed StyleX priority changes the winner and fails;
- important declarations and pseudo-elements remain represented but unsupported;
- unknown pseudo-classes and at-rules fail observation instead of disappearing.

M6.2 must add mutations for condition removal, condition rename, branch reorder, property rename, value change, priority change, specificity change, importance, pseudo-element target, and argument/style-key wiring. Every mandatory mutation must be rejected before the capability is enabled.

## M6.2 implementation gate

After approval of this grammar, M6.2 should:

1. Extend discovery to recognize only this nested literal shape.
2. Preserve authored branch order and exact source spans.
3. Obtain the source CSS from Emotion serialization and target CSS plus priorities from the compiled candidate.
4. Run the referee across the complete activation state set.
5. Bind the result, compiler version, model version, source hash, and target hash into static evidence.
6. Refuse every construct listed above with a queryable reason.
7. Enable the capability only after its mutation manifest reaches 100%.

## Exit status

- Seeded cascade-order disagreement: caught.
- Supported condition priority constants copied into migrate: none.
- Compiler behavior fixture: pinned to the installed package version.
- Bounded grammar review: pending.

M6.2 must not start converting conditions until the final item is approved.

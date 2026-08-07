# @stylexjs/codemods

Codemods for migrating styling libraries to [StyleX](https://stylexjs.com) —
Emotion first, built as **one library-agnostic engine with swappable
per-library adapters**.

> **Status: feature-complete, pre-publish.** The Emotion adapter converts the
> `css` prop (object / call / template / const-ref forms), dynamic props-driven
> values, self-targeting conditions, keyframes, `styled.tag` (static + dynamic),
> and — config-driven — theme reads (`useTheme` / `props.theme`) into
> `defineVars` tokens. It runs on **Flow _and_ TypeScript** files, flags what it
> can't safely convert with `// TODO` markers, and never silently drops or
> guesses. Correctness is enforced by three gates (compile, lint, semantic-diff)
> plus a real-browser **render check** and a robustness corpus (0 crashes / 0
> silent CSS changes across 6,000+ real files). Not published yet.

**New here?** → the step-by-step **[Migration runbook](./docs/migrating-from-emotion.md)**.

## Principles

- **Bail loudly.** Only provably-safe styles are converted. Anything else is
  left in place with a `// TODO(stylex-migration): …` marker; a whole file is
  refused only for a genuinely structural issue. **Wrong-but-plausible output is
  the one unacceptable result** — the codemod would rather flag than guess.
- **Gated output.** Every conversion must (1) compile through the real
  `@stylexjs/babel-plugin`, (2) pass `@stylexjs/eslint-plugin` at _error_ with
  zero autofixes, and (3) have **net-CSS identical** to Emotion's own serializer
  output (minus an explicit allowlist: hover-guard, physical→logical). A rule
  that fails is dropped and its one site flagged — never the whole file.
- **Trusted transforms are render-verified.** Values external to a file (theme
  tokens, dynamic props-driven values) can't be checked by the static
  semantic-diff, so their _wiring_ is verified structurally and the result is
  confirmed in a real browser via `--render-check`.

## Quick start

```sh
# 1. Scaffold a config + print a quick-start
stylex-codemod init

# 2. DRY RUN (the default) — preview the changes; writes NOTHING.
#    The report explains itself and ends with a tailored "Next steps".
stylex-codemod emotion "src/**/*.{jsx,tsx}" --diff

# 3. Apply
stylex-codemod emotion "src/**/*.{jsx,tsx}" --write

# 4. (optional) Verify theme/dynamic conversions in a real browser
stylex-codemod emotion "src/**/*.{jsx,tsx}" --render-check
```

Dry run is **always** the default — nothing is written until `--write`.

## What it converts

| Area | Patterns |
| --- | --- |
| **css prop** | `css={{…}}` · `css({…})` · `` css`…` `` templates (incl. partial interpolations `${x}px`) · `css={x}` const-refs |
| **Values** | static (strings/numbers/negatives/`rgb()`/fallback arrays) · dynamic props-driven → function-form `create` |
| **Conditions** | `:hover`, `::before`, `@media`/`@supports`/`@container`, and their nesting; hover-guard + physical→logical mapping |
| **keyframes** | `keyframes({…})` → `stylex.keyframes` |
| **styled** | `styled.tag` static (template + object) and dynamic (prop interpolations, destructured params) → a `forwardRef` wrapper |
| **Theme** _(config-driven)_ | `useTheme()` (incl. `as`/casts) and `props.theme.<path>` → `vars.<token>` from your `defineVars`, plus a name-only skeleton |
| **Merging** | into an existing `stylex.create` registry; a css site alongside `className`/`style` (no spread) |
| **Language** | `.js` / `.jsx` (Flow) **and** `.ts` / `.tsx` (TypeScript); type-only imports don't block |

## What it flags or refuses (and why)

| It won't (yet) | Why | Result |
| --- | --- | --- |
| `styled(Component)` composition | correctness depends on whether the wrapped component forwards `className` — **unverifiable from one file** | flagged |
| `css` on a component element | same as above | flagged |
| a `css` site mixed with a **spread** | spread ordering isn't statically verifiable | flagged |
| `border`/`background`/`animation` bare shorthands | StyleX drops or mis-splits them | flagged |
| unconvertible import forms / an Emotion identifier used in an unsupported position / `useTheme` with **no** `themeTokens` config | genuinely structural | refused (whole file, with reason) |

Everything flagged gets a `// TODO(stylex-migration): …` comment in place. See
the runbook for how to triage each.

## The trust model (important)

| Tier | What | How it's verified |
| --- | --- | --- |
| **Verified** | static CSS | net-CSS equivalence vs Emotion's serializer (the semantic-diff gate) |
| **Trusted** | dynamic values, theme tokens | the _value_ is external/runtime — the gate verifies the wiring, not the value (shows as `unverifiable` in the report) |
| **Render-verified** | any of the above, on demand | `--render-check` renders old vs new in real Chrome and diffs computed styles |

Run `--render-check` to turn "trusted" into "confirmed" for theme/dynamic
conversions.

## CLI reference

```
stylex-codemod emotion <glob..> [options]
stylex-codemod init
```

| Flag | Purpose |
| --- | --- |
| `--write` | apply changes (default: dry run) |
| `--diff` | show the unified diff of each conversion |
| `--render-check` | render clean conversions in a real browser and diff computed styles (needs Chrome) |
| `--theme-vars <name>:<import>` | convert theme reads without a config file (e.g. `vars:./app.stylex`) |
| `--theme-path` / `--vars-path` | (`--render-check`) your real theme module / authored `defineVars` module |
| `--config <path>` | path to a `stylex-codemod.config.js` |
| `--ignore '<glob>' …` | extra excludes on top of `node_modules` |
| `--json` | structured report on stdout (for CI/tooling) |
| `--verbose` | list unchanged files and every TODO reason |

Exit code is non-zero on a transform error or a render-check mismatch.

## Config

Optional `stylex-codemod.config.js` (or run `init` to scaffold a commented one):

```js
module.exports = {
  hoverGuard: true, // wrap :hover in @media (hover: hover)          (default true)
  logicalProperties: true, // marginLeft -> marginInlineStart, etc.  (default true)

  // Convert theme reads to defineVars tokens (you author the values):
  themeTokens: {
    varsImport: './app.stylex', // import written into converted files
    varsName: 'vars', // the defineVars binding name
    // Only used by --render-check:
    themePath: './theme', // your real runtime theme module (for ThemeProvider)
    varsPath: './app.stylex.js', // your authored defineVars module (for real values)
  },

  // --render-check sample props; auto-derived from co-located *.stories.* when omitted:
  renderCases: [{ include: 'components/Button', cases: [{ size: 'large' }] }],
};
```

Theme is **not one-click**: you author the `defineVars` module (values, incl.
light/dark); the codemod rewrites the reads and emits a name-only skeleton to
start from. See the runbook.

## Compatibility

| | Version |
| --- | --- |
| Emits StyleX | 0.19.x (uses the real `@stylexjs/babel-plugin` + `eslint-plugin`) |
| Reads Emotion | 10–11 (`@emotion/react`, `@emotion/styled`) |
| Files | Flow + TypeScript (`.js/.jsx/.ts/.tsx`) |

## Development

```sh
cd packages/@stylexjs/codemods
yarn test          # unit suites (parallel) + render suites (serial)
yarn test:unit     # just the fast suites
yarn build         # compile src -> lib
```

Fixture pairs live in `__fixtures__/emotion/<name>/{input,expected}.{js,tsx}`;
set `UPDATE_STYLEX_CODEMOD_FIXTURES=1` to regenerate expected files when a change
is intentional. The render suites need a local Chrome.

See the **[Migration runbook](./docs/migrating-from-emotion.md)** for the
full workflow and the architecture guide for the design.

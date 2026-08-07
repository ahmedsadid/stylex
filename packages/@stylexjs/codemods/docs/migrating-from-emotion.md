# Migration runbook: Emotion → StyleX

This is the working guide for migrating an Emotion codebase to
[StyleX](https://stylexjs.com) with `@stylexjs/codemods`. It covers the full
loop — scaffold, dry-run, apply, verify, triage — plus theme setup, what's solid
vs. shaky, and how to wire it into CI.

The one rule behind everything below: **the codemod only converts what it can
prove renders identically.** Everything else is left in place with a precise
`// TODO(stylex-migration): …` marker, or — for a genuinely file-level problem —
refused with a stated reason. It never emits confident-but-wrong output. Your
job is to run the mechanical bulk, then work down a clear, honest list of the
rest.

---

## 1. The migration loop at a glance

```sh
stylex-codemod init                                  # once: scaffold config
stylex-codemod emotion "src/**/*.{jsx,tsx}" --diff   # dry run — preview, writes nothing
stylex-codemod emotion "src/**/*.{jsx,tsx}" --write  # apply the mechanical bulk
stylex-codemod emotion "src/**/*.{jsx,tsx}" --render-check   # (optional) confirm in a browser
grep -rn "TODO(stylex-migration)" src                # work down the flagged list
```

Do it in that order, and **commit the mechanical `--write` diff on its own**,
separate from any hand-work. That keeps the reviewable "what the robot did" diff
clean and makes a revert trivial if you don't like a batch.

---

## 2. Scaffold — `init`

```sh
stylex-codemod init
```

Writes a commented `stylex-codemod.config.js` (if one doesn't already exist) and
prints a quick-start. You can migrate with **no** config at all — the defaults
(hover-guard on, physical→logical on, no theme conversion) are sane — but you'll
want the file once you get to theme tokens (§6).

---

## 3. Dry run — read the report before you write anything

Dry run is the **default**. Nothing is written until you pass `--write`.

```sh
stylex-codemod emotion "src/**/*.{jsx,tsx}"
```

The report classifies every file and then explains itself. A dry run over a real
directory looks like:

```
Dry run (no files written):
  (convert = rewritten · +N TODOs = converted, N sites need a hand ·
   refuse = left untouched · skip = no Emotion)
  convert  src/Button.tsx
  convert  src/Card.tsx (+1 TODO)
  refuse   src/Legacy.jsx — two stylex.create registries in one file

12 file(s): 9 converted, 1 partial (+TODOs), 1 refused, 1 unchanged
1 TODO marker(s) left for manual follow-up.

ℹ Static styles are verified CSS-equivalent. Theme tokens & dynamic (props-driven)
  values are TRUSTED (wiring checked, not the value) — run --render-check to
  confirm them in a real browser.

Top reasons sites were flagged (partial conversions):
     1  css on a component element (…) — may not forward className

Next steps:
  1. Re-run with --write to apply.
  2. 1 site(s) need a hand — search `TODO(stylex-migration)` in the converted files.
```

Every file is one of four outcomes:

| Outcome | Meaning |
| --- | --- |
| **convert** | rewritten to StyleX. `(+N TODO)` means N sites in that file were left flagged for you. |
| **refuse** | a whole-file structural problem (reason shown); file left untouched. |
| **skip** | no Emotion, or nothing to do. |
| **ERROR** | the transform threw (a bug — please report; the file is left untouched). |

Useful flags at this stage:

- `--diff` — show the unified diff of each conversion inline. This is the single
  most useful flag for building trust early; skim a dozen diffs and you'll see
  exactly what it does.
- `--verbose` — also list `unchanged` files and print every TODO reason in full.
- `--json` — emit the structured report on stdout (see §13, CI).

The **histogram** ("Top reasons…") and the tailored **Next steps** are the
report telling you where the manual work actually is, ranked. Read them — they
replace most of this document for a given run.

---

## 4. Apply — `--write`

```sh
stylex-codemod emotion "src/**/*.{jsx,tsx}" --write
```

Same run, but files are written. The transform is idempotent — running it twice
converts nothing new the second time — so it's safe to re-run after you've
hand-fixed some TODOs.

Then find your hand-work:

```sh
grep -rn "TODO(stylex-migration)" src
```

Each marker is a specific, self-contained thing to convert by hand. §7 is the
triage table for what each one means.

---

## 5. What it converts (the solid path)

These are **verified** — each conversion's net CSS is checked identical to
Emotion's own serializer output before it's emitted.

- **The `css` prop**, in every common form:
  - object: `<div css={{ … }} />`
  - call: `<div css={css({ … })} />`
  - template: `` css`color: red; padding: 8px` `` — including **partial
    interpolations** like `` `${size}px` `` (rebuilt as a template value)
  - const-ref: `const base = css({…})` then `css={base}`
  - both css-prop runtimes: the modern `@jsxImportSource @emotion/react` pragma
    and the classic `/** @jsx jsx */` runtime.
- **Self-targeting conditions**: pseudo-classes (`:hover`, `:focus`),
  pseudo-elements (`::before`), `@media` / `@supports` / `@container`, and their
  nesting.
- **`styled.tag`** — both static (`` styled.button`…` `` and object form) and
  **dynamic** (prop interpolations `` `${p => p.active ? … : …}` ``, including
  destructured params) → a `forwardRef` wrapper that reads props and applies the
  right StyleX styles.
- **Values**: strings, numbers, negatives, `rgb()/rgba()`, multi-value
  `margin`/`padding` shorthands (expanded to canonical longhands), fallback
  arrays (`position: ['sticky', 'fixed']`).
- **`keyframes({ … })`** (object form) → `stylex.keyframes`, referenced via
  `animationName`.
- **Dynamic, props-driven values** (`css={{ color: props.color }}`) → StyleX's
  function-form `create`. These are **trusted, not statically verified** (the
  value is a runtime input) — see the trust model in §9, and confirm them with
  `--render-check` (§10).
- **Merging**: into a file's pre-existing `stylex.create` (without touching your
  entries), and a `css` site that sits alongside an existing `className`/`style`
  (emitted as explicit props, never a spread — StyleX's no-conflicting-props
  rule).
- **TypeScript**: `.ts`/`.tsx` are a first-class, fully-verified path, not
  best-effort. Type-only imports don't block a conversion.

Two conversions are **sanctioned, intentional CSS changes** — they render
identically left-to-right and are the correct StyleX idiom:

- **Physical → logical**: `marginLeft` → `marginInlineStart`, etc. (makes the
  result RTL-correct). Opt out with `logicalProperties: false`.
- **Hover-guard**: `:hover` wrapped in `@media (hover: hover)` so hover styles
  don't stick on touch. Opt out with `hoverGuard: false`.

---

## 6. Theme tokens (`useTheme` / `props.theme`)

This is the biggest unlock on a real Emotion app and the part that needs **you**
to do some setup. It is **off by default** and **not one-click** — for a good
reason: a token's *value* lives in your theme, outside the file the codemod is
reading, so it can't be proven correct by the before/after CSS comparison the way
static styles are. You author the values; the codemod rewrites the reads.

### 6.1 What it does

With `themeTokens` configured, the codemod converts theme reads into StyleX var
references:

- `const theme = useTheme(); … color: theme.colors.primary` → `color: vars.colorsPrimary`
- `useTheme() as Theme` / other casts are unwrapped and handled
- `styled` with `` `${p => p.theme.colors.primary}` `` → the static var token

and it emits a **name-only `defineVars` skeleton** aggregating every token the
run referenced — so you have the exact list of variables to fill in.

### 6.2 Setup

1. Configure it (or pass `--theme-vars <name>:<import>` for a config-free run):

   ```js
   // stylex-codemod.config.js
   module.exports = {
     themeTokens: {
       varsImport: './app.stylex', // the import written into converted files
       varsName: 'vars', // the defineVars binding name
     },
   };
   ```

2. Dry-run. The report's **Next steps** will point you at the generated skeleton
   path. It looks like:

   ```js
   import { defineVars } from '@stylexjs/stylex';
   export const vars = defineVars({
     colorsPrimary: null, // TODO: fill in
     spacingMd: null, // TODO: fill in
   });
   ```

3. **Fill in the real values** — including light/dark via StyleX's theming — in
   that module. The skeleton is written only if the target doesn't already
   exist, so your authored module is never clobbered on a re-run.

4. `--write`, then **`--render-check`** (§10) to confirm the tokens actually
   resolve to the same computed values in a browser. Until you fill in real
   values, render-check reports those files as `placeholder` (not a failure —
   just "not verifiable yet").

If you run into `useTheme` with **no** `themeTokens` config, the file is refused
with a reason and the Next steps tell you exactly what to add. That's
deliberate: converting a theme read without somewhere to point it would be a
guess.

> This mirrors how large real-world migrations (e.g. styled-components → StyleX
> at Linear) were done: define the variables first, then wire the references.

---

## 7. Triaging the TODO markers

Everything flagged gets a `// TODO(stylex-migration): …` comment in place, and
the file still converts around it. Here's what each class means and how to
finish it.

| Marker / reason | Why it's flagged | How to finish it |
| --- | --- | --- |
| `css` on a **component** element (`<Button css={…}>`) | only host elements are safe — the component may not forward `className`/`style` | confirm the component forwards `className`, then apply `stylex.props(...)` at the definition or pass the class through |
| `styled(Component)` composition | correctness depends on whether the wrapped component forwards `className` — **unverifiable from one file** | hand-migrate: make the base take `className`, compose with `stylex.props` |
| `css` mixed with a **spread** (`<div css={…} {...props} />`) | spread may carry an unknown `className`/`style`; ordering isn't statically safe | pull the spread's class/style out explicitly, then let StyleX own the rest |
| selectors reaching outside the element (`& > li`, descendant/child) | StyleX is element-scoped | move the style onto the target element |
| `border` / `background` / `animation` bare shorthands | StyleX drops or mis-splits these | split into longhands (`borderWidth`/`Style`/`Color`, etc.) |
| `!important` | StyleX handles priority structurally | remove and rely on StyleX ordering, or restructure |
| cross-file `css`/`keyframes` value (imported from elsewhere) | the codemod doesn't follow imports | inline or convert at the definition site |
| `theme.*` with no `themeTokens` config | nowhere to point the token (see §6) | add the config, re-run |

The report's **histogram** ranks these by frequency for your run, so you can
tackle the highest-leverage class first.

---

## 8. What it refuses (whole file)

A refusal means a structural problem the codemod won't work around. The file is
left **untouched**, with the reason in the report:

- a file importing StyleX in a non-namespace form (`import { create } …`) — it
  can only merge into `import * as stylex`
- two or more `stylex.create` registries in one file
- an unconvertible `keyframes` (e.g. a tagged-template form)
- an Emotion identifier used in a position the adapter doesn't model
- `useTheme` with no `themeTokens` config (§6)

Refusals are rare and each is actionable. A refusal is never a silent data loss
— it's the codemod declining to guess.

---

## 9. The trust model (read this before you trust a diff)

Not all conversions are verified the same way. The report surfaces this; here's
what the tiers mean.

| Tier | Applies to | How it's verified | In the report |
| --- | --- | --- | --- |
| **Verified** | static CSS | net-CSS equivalence vs Emotion's serializer, before emit | (the default; counted as `converted`) |
| **Trusted** | dynamic props-driven values, theme tokens | the value is external/runtime — the **wiring** is verified structurally, not the value | the `ℹ` trust callout; unverifiable until render-checked |
| **Render-verified** | any of the above, on demand | old vs new rendered in real Chrome, computed styles diffed | `--render-check` → `match` |

**Verified** conversions you can trust blind. **Trusted** ones (theme, dynamic)
are where you should run `--render-check` before shipping — the wiring is
correct by construction, but only a render confirms the *value* lands the same.

---

## 10. Confirm in a real browser — `--render-check`

```sh
stylex-codemod emotion "src/**/*.{jsx,tsx}" --render-check
```

This renders the Emotion input and the StyleX output of each **clean** conversion
(zero TODO flags) in a real headless Chrome and diffs their **computed styles**.
It's how a *trusted* conversion becomes *render-verified*. Needs a local Chrome;
with none present the whole batch reports `unavailable` (never a false failure).

Each file comes back as one of:

| Status | Meaning |
| --- | --- |
| `matched` | rendered identically under every sample prop — verified. |
| `DIFFER` | rendered differently — a real signal; the offending property and props are shown. |
| `could not render` | the component didn't build in isolation (local imports/hooks/context esbuild can't resolve). Not a conversion bug — review by hand. |
| `theme placeholder` | a theme conversion whose `defineVars` is still the name-only skeleton — fill in real values (§6), then re-check. |
| `unavailable` | no browser — not a verdict. |

Only clean conversions are checked: a partially-converted file still has leftover
Emotion `css` that the StyleX pipeline can't apply, so comparing it would report
a false mismatch.

### Sample props

Dynamic and `styled` components render differently per prop, so the render-check
needs sample props. It gets them, in order of preference:

1. an explicit `renderCases` rule in your config (first whose `include` is a
   substring of the file path);
2. **auto-derived** from a co-located `*.stories.*` file (literal args from
   CSF2/CSF3/meta);
3. otherwise, rendered once under `{}`.

```js
// stylex-codemod.config.js
renderCases: [
  { include: 'components/Button', cases: [{ size: 'large' }, { disabled: true }] },
],
```

### Theme render-check

For theme conversions, point the config at your two independent value sources so
the check can build a real `ThemeProvider` tree and compare it against the
authored `defineVars`:

```js
themeTokens: {
  varsImport: './app.stylex',
  varsName: 'vars',
  themePath: './theme', // your real runtime theme module
  varsPath: './app.stylex.js', // your authored defineVars module
},
```

These two sources are **never bridged** — the check deliberately compares the
runtime theme value against the independently-authored var value, so a wrong
value in your `defineVars` *fails* the check rather than tautologically passing.

---

## 11. CLI reference

```
stylex-codemod emotion <glob..> [options]
stylex-codemod init
```

| Flag | Purpose |
| --- | --- |
| `--write` | apply changes (default: dry run) |
| `--diff` | show the unified diff of each conversion |
| `--render-check` | render clean conversions in a real browser, diff computed styles (needs Chrome) |
| `--theme-vars <name>:<import>` | convert theme reads without a config file (e.g. `vars:./app.stylex`) |
| `--theme-path <path>` | (`--render-check`) your real runtime theme module |
| `--vars-path <path>` | (`--render-check`) your authored `defineVars` module |
| `--config <path>` | path to a `stylex-codemod.config.js` |
| `--ignore '<glob>' …` | extra excludes on top of `node_modules` |
| `--json` | structured report on stdout (status lines go to stderr) |
| `--verbose` | list unchanged files and every TODO reason |

Exit code is non-zero on a transform error or a render-check mismatch — so a
plain run doubles as a CI gate.

---

## 12. Config reference

```js
// stylex-codemod.config.js
module.exports = {
  hoverGuard: true, // wrap :hover in @media (hover: hover)         (default true)
  logicalProperties: true, // marginLeft -> marginInlineStart, etc. (default true)

  // Theme conversion (see §6). Omit to leave theme reads refused.
  themeTokens: {
    varsImport: './app.stylex', // import written into converted files
    varsName: 'vars', // the defineVars binding name
    themePath: './theme', // (--render-check only) real runtime theme module
    varsPath: './app.stylex.js', // (--render-check only) authored defineVars module
  },

  // --render-check sample props; auto-derived from *.stories.* when omitted (see §10).
  renderCases: [{ include: 'components/Button', cases: [{ size: 'large' }] }],
};
```

---

## 13. CI integration

Two ways to gate a migration in CI:

- **Guard against regressions during migration** — fail the build if a re-run
  would change already-migrated files, or on any transform error:

  ```sh
  stylex-codemod emotion "src/migrated/**/*.{jsx,tsx}" --json > report.json
  # non-zero exit = a transform error; inspect report.json for counts
  ```

- **Confidence gate on trusted conversions** — in an environment with Chrome:

  ```sh
  stylex-codemod emotion "src/**/*.{jsx,tsx}" --render-check
  # non-zero exit on any DIFFER
  ```

  If your CI has no browser, the render-check reports `unavailable` and does not
  fail — keep it to a job that provisions Chrome.

`--json` gives you the full structured `RunReport` (per-file outcomes, flag and
refusal reasons, summary counts, the theme skeleton) for custom dashboards or
thresholds.

---

## 14. Honest limitations (what's shaky or out of scope)

Being explicit so you can plan around it:

- **`styled(Component)` composition is the one honestly-risky area** and is left
  for you. Whether it's safe depends on if the wrapped component forwards
  `className` — which can't be seen from the single file being transformed. It's
  flagged, never converted.
- **`css` on a custom component** is flagged for the same reason.
- **Bare shorthands** (`border`, `background`, `animation`) are flagged rather
  than split, because StyleX drops/mis-splits them and getting the split subtly
  wrong is exactly the "confident-but-wrong" outcome the tool refuses.
- **Cross-file styles** (a `css`/`keyframes` imported from another module) are
  flagged, not followed.
- **Theme conversion is *trusted*, not statically verified** (§9). It's correct
  by construction, but you should run `--render-check` with real values before
  shipping — that's the whole point of the render check existing.
- **`<Global>` / `injectGlobal` / `cx`** and `shouldForwardProp` are out of
  scope; files using them are flagged or refused, never converted incorrectly.
- **Whole-file refusal on one bad rule is coarse in a few spots.** Most rules are
  isolated per-site (a failing rule is dropped and flagged, the rest convert),
  but a small number of structural problems (§8) still refuse the whole file.

None of these produce wrong output — they produce a flag or a refusal. The
failure mode is always "you do this one by hand," never "it silently changed
your CSS."

---

## 15. How to think about a whole migration

1. **Dry-run and read the ratio.** convert vs. partial vs. refuse tells you how
   mechanical your codebase is. A `styled`-heavy app converts a lot; a
   `<Global>`-heavy one less.
2. **`--write` and commit the mechanical diff alone.** Reviewers see exactly what
   the robot did.
3. **Set up theme tokens (§6)** — usually the biggest single unlock — author the
   `defineVars`, re-run, `--render-check`.
4. **Work down the `TODO(stylex-migration)` markers**, highest-frequency class
   first (the histogram ranks them).
5. **Remove the Emotion dependency** once the markers are gone and the render
   check is green.

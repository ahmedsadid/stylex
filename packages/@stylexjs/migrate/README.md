# @stylexjs/migrate

A migration kit for moving a codebase from another styling library to StyleX.
Emotion is the first supported source library.

> **Status: early development.** Nothing here is released or supported yet, and
> the package makes no conversion claims at this stage.

## What this is

Not a codemod. A deterministic control plane that:

- inventories styling sites and records facts **with their certainty**,
- mechanically converts only what an independent comparison can confirm,
- escalates the rest to an agent working in an **isolated candidate workspace**,
- collects evidence from your repository's own checks, and
- writes to your source tree only after a human-visible verdict — and only
  content that is byte-for-byte what was verified.

## The claims vocabulary

Every verdict names its exact claim. Evidence does not become a claim until the
kernel's policy accepts the complete required check set. The words _proven_,
_safe_, _verified_, and _equivalent_ are never used unqualified.

| Claim                | Meaning                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- |
| `static-css-matched` | Source CSS and generated StyleX CSS match under a named, versioned comparison model    |
| `checks-passed`      | The listed parse, compile, type, lint, and test commands passed at the listed versions |
| `runtime-matched`    | Named runtime cases matched for named states in a recorded environment                 |
| `approved`           | A human accepted one specific candidate hash and its stated limitations                |
| `blocked`            | The system lacks information, support, or evidence that policy requires                |

A check that could not run reports `unavailable`. That never counts as a pass.

## Inventory and local project state

Migration records live under `.stylex-migrate/`. The directory is added to
`.git/info/exclude`; the tool does not edit the repository's tracked
`.gitignore`, source files, or Git history during inventory and planning.

```sh
stylex-migrate init
stylex-migrate scan
stylex-migrate plan
stylex-migrate config set ./stylex-migrate.config.json
stylex-migrate config show
stylex-migrate verify <candidate-id> [candidate-id...]
stylex-migrate review <candidate-or-subject-or-verdict-id>
stylex-migrate status
stylex-migrate explain <site-or-cluster-or-plan-id>
stylex-migrate state rebuild
stylex-migrate schema migrate --dry-run
stylex-migrate cleanup             # preview
stylex-migrate cleanup --confirm   # remove unreferenced local artifacts
```

`scan` inventories configured source globs and records parse or resolution
failures without treating them as absence. `plan` groups sites with overlapping
change ownership and retains the inputs and facts behind each classification.
`status` reports counts by classification and state; it does not report a
conversion percentage. `explain` makes routing and blocking reasons available
after restarting the process.

Every command also accepts `--json`. Run `init` before the other commands.

Repository checks are configured as argv arrays; shell command strings are
rejected. Each provider declares whether it applies to one candidate or an exact
multi-candidate apply plan, the environment keys it may receive, relevant file
globs, a version command, cost tier, timeout, and known limitations.

```json
{
  "sourceGlobs": ["src/**/*.{js,jsx,ts,tsx}"],
  "evidence": {
    "concurrency": 2,
    "outputPreviewBytes": 8192,
    "providers": [
      {
        "id": "repo-typecheck",
        "kind": "command",
        "check": "typecheck",
        "checkVersion": "flow-selection-v1",
        "subject": "apply-plan",
        "cost": "standard",
        "argv": ["yarn", "flow", "check"],
        "versionArgv": ["yarn", "flow", "version"],
        "cwd": ".",
        "allowedEnv": ["PATH", "CI"],
        "fileGlobs": ["src/**/*.{js,jsx,ts,tsx}"],
        "limitations": ["does not exercise rendered behavior"],
        "timeoutMs": 120000
      }
    ]
  }
}
```

`verify` reconstructs the frozen candidate in a detached temporary worktree,
runs applicable checks there, stores full logs by content hash, computes path
and site coverage, and persists an evidence-bound verdict. It returns exit code
3 for blocked evidence and 4 for a rejected result. A passing repository test
cannot replace the required static comparison for a mechanical candidate.

## Current mechanical boundary

The development API can propose a conversion for an Emotion `css` prop on a host
element when the file has an exact Emotion JSX pragma and the style is an object
literal containing supported camelCase longhands with string or finite numeric
literal values.

It admits separate, bounded modifier capabilities:

- Sibling `:hover` and `:focus` objects. The verifier obtains source rules from
  Emotion and target rules and priorities from the StyleX compiler, then
  compares the winning declaration in the default, hover-only, focus-only, and
  simultaneous hover/focus states under model `cascade-referee-v1`.
- Flat `::before` and `::after` objects under model `pseudo-element-referee-v1`.
  Declarations are compared by their exact root, before, or after selector
  target.
- One `@media` object under model `media-query-referee-v1`. The query emitted by
  Emotion and StyleX must match exactly, and the default and query-active winner
  states are compared independently.
- One exact `@supports` object, with at most one exact `@media` intersection,
  under model `supports-nesting-referee-v1`. Either wrapper order may be
  authored because the model compares the same boolean intersection and StyleX
  canonicalizes its emitted wrapper order. Nesting stops after two at-rules.
- One named `@keyframes` object containing literal `from` and `to` frames, with
  one exact root `animationName` reference, under model `keyframes-referee-v1`.
  The referee alpha-renames only StyleX's generated CSS identifier and still
  compares both frames, their declarations, and the animation reference.
  `stylex.keyframes(...)` stays inline, so no binding is introduced or moved.

These are not general selector claims. A disagreement in any admitted state or
target is a refusal. In particular, reversing two otherwise identical hover and
focus branches can be refused because Emotion and StyleX may then choose
different winners when both states are active. Pseudo-elements cannot yet be
combined with pseudo-class conditions in one style object.

Multiple media queries are not admitted yet. StyleX can rewrite overlapping
queries into disjoint ranges, so expanding this boundary requires a model that
compares the rewritten activation regions rather than relying on authored key
order. Media queries also cannot yet be mixed with pseudo-classes or
pseudo-elements.

Dynamic values, spreads, shorthands, `!important`, other pseudo-elements or
pseudo-classes, other at-rules, deeper nesting, percentage or multiple
keyframes, component `css` props, and sites that also have `className`, `style`,
or a JSX spread remain outside this mechanical boundary. The comparison is local
and static: it does not establish whole-page browser behavior, repository build
success, or runtime equivalence.

The candidate persistence API is available for deterministic integrations. The
end-user contextual candidate creation protocol and agent skill arrive in a
later milestone; this early-development package does not yet present `verify` as
a complete standalone migration workflow.

## Development

```sh
yarn workspace @stylexjs/migrate test    # unit tests
yarn flow                                # types (run from the repo root)
yarn build                               # compile src/ to lib/
```

Design documents live in `devlog/` and are intentionally not published.

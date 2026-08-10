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

## Development

```sh
yarn workspace @stylexjs/migrate test    # unit tests
yarn flow                                # types (run from the repo root)
yarn build                               # compile src/ to lib/
```

Design documents live in `devlog/` and are intentionally not published.

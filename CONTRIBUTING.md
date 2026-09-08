# Contributing

Thanks for your interest in improving this plugin.

## Before you start

Read `CLAUDE.md` — it documents the project's architecture, code style
rules, testing conventions, and a list of critical constraints (invariants
that must not be broken, each with the reasoning behind it and the ADR that
established it). Any change to `plugin.js` or `updater.js` should be checked
against that list before you open a PR.

## Setup

```bash
npm install
```

## Development loop

```bash
npm run lint      # ESLint — must pass with zero errors
npm test          # node:test — must pass with zero failures
npm run test:bun  # required for any change to the update loader — see README
```

All must pass before a change is considered done — no exceptions (see
`CLAUDE.md`'s "Code style" section). `npm test` alone does not exercise the
update loader's production (Bun) import path; `npm run test:bun` requires the
[opencode CLI](https://opencode.ai) installed locally.

## Tests

Tests use Node's built-in `node:test` runner. See `CLAUDE.md`'s "Testing"
section for the sandboxing helpers (`test/helpers.js`) and the `// given` /
`// when` / `// then` structuring convention every test follows — match it.

## Architecture Decision Records

Non-obvious design decisions live in `docs/decisions/` as ADRs. If your
change touches one of the invariants listed in `CLAUDE.md`'s "Critical
constraints" section, or makes a new non-obvious tradeoff, add a new ADR
following the existing files' structure (Status / Context / Decision /
Alternatives considered / Consequences).

## Commit style

Short, imperative, present-tense summaries (e.g. "Add X", "Fix Y", "Implement
Z (ADR-NNN)") — see `git log --oneline` for examples.

## Versioning

Any change that touches `plugin.js` or `updater.js` requires bumping
`"version"` in `package.json` — that bump is what triggers the auto-update
rollout to already-installed users. See `CLAUDE.md`'s "Critical constraints"
section for the full rule.

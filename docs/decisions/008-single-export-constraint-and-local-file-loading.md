# ADR-008: Single-Export Plugin Loaded from a Local File

## Decision
opencode discovers plugins by globbing `{plugin,plugins}/*.{ts,js}` under `~/.config/opencode/` (global) and `.opencode/` (project), `import()`s each match, and invokes **every** exported value as a plugin factory. Given that:

- **Load from a local file, not a package reference.** `updater.js` copies a single self-contained `plugin.js` into `~/.config/opencode/plugin/tokendashboard-plugin.js`. opencode loads it from disk on every start with no network access.
- **Expose exactly one export.** `plugin.js` exports only the `TokenUsagePlugin` factory. Internals needed by unit tests are attached to the factory as `TokenUsagePlugin.__internal` — invisible to opencode's `Object.values(module)` iteration.
- **ESM, `"type": "module"`.** opencode loads plugins via ESM `import()`, so the package is `"type": "module"` and the same `.js` files load both under opencode (Bun) and the Node-based test runner.

## Why
- A plugin referenced in `opencode.json` is resolved/installed by opencode via Bun at startup; if the network is down at that moment, resolution fails and the plugin is treated as not installed — no tokens counted. A local file has no startup network dependency.
- Because opencode invokes every module export as a plugin factory, a second export — even a helper — would be called with the plugin context and break loading, or be mis-registered as a plugin.

## Alternatives considered
- **Package in `opencode.json`:** idiomatic and gives free auto-install via Bun, but reproduces the network-at-startup failure and requires every user to edit their config (see ADR-002).
- **Export helpers for testing directly:** unsafe here since opencode invokes every export; other hosts `require` CommonJS and ignore extras, opencode does not.
- **Bundle/transpile from TypeScript:** adds a build step and complicates the self-contained single-file distribution.

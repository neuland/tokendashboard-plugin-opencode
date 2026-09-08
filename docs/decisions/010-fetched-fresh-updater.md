# ADR-010: Fetched-Fresh Updater

## Decision
`plugin.js` contains only capture/flush and a minimal, permanently-frozen loader (`runFetchedUpdate`). 
It fetches `updater.js` fresh from the repo, imports it in-process (Bun: `blob:` URL; Node: `data:` URL — chosen by probing capability, not `typeof Bun`), and calls its `converge()`. 
`updater.js` holds all update/lifecycle logic (`converge`, `install`, `uninstall`, the `npx` `main()` dispatch) and is never written to the user's machine — 
it ships only in the npx package and is otherwise imported from memory. There is no `cli.js`; `updater.js` is the `bin` entry.

`updater.js` is not discovered by opencode (it never lives under `plugin/`), so the single-export constraint on `plugin.js` (ADR-008) does not apply to it. 
It self-derives all paths from `os.homedir()`/`XDG_CONFIG_HOME` (never `__filename`) and imports only `node:` builtins, because a fetched module has no file location and cannot resolve relative specifiers.

## Why
- Fetching the updater fresh keeps the permanently-frozen surface (the loader) tiny, so a bug in update logic is fixed server-side and self-heals on the next check, instead of stranding every affected install behind a manual reinstall.
- `capture`/`flush` must stay in `plugin.js`, not the fetched updater — otherwise an offline install captures nothing.
- Bun's `data:` import fails `ENAMETOOLONG` above ~4KB (it resolves the URL as a filesystem path); `updater.js` exceeds that. Bun supports `blob:` at any size. Node is the reverse: no `blob:` support, `data:` at any size. The scheme must therefore be chosen by capability probe, not a `typeof Bun` check, since opencode may not expose that global to plugins.
- The probe runs once (a tiny throwaway module), is cached, and the real module is imported once via the chosen scheme — never try-blob-then-fallback on the real module, which could evaluate `converge()` twice.
- `node --test` cannot exercise Bun's import path (Node's `data:` path hides the Bun-only size cliff), so `npm run test:bun` (a Bun-level smoke test of the loader) is a required part of verifying any loader change.
- The self-update overwrites the installed file directly, not `import.meta.url` — a failed check (e.g. offline) leaves the running plugin untouched and retries next start.

## Two frozen markers
`plugin.js` must keep the literal `export const TokenUsagePlugin` (checked by `converge()` and by the deployed predecessor before overwriting), and `updater.js` must keep the literal `export async function converge` (grepped by the loader before importing). Neither can change export form without a manual-reinstall break for already-installed users.

## Alternatives considered
- **Keep the monolithic in-process updater:** a bug in it can strand an install with no self-heal path.
- **Subprocess `node -` via stdin:** opencode has no external per-turn process and ships Bun, not a `node` on PATH.
- **Write `updater.js` to a temp file and import the path:** works on both runtimes with one code path, but writes to disk — the blob:/data: split keeps both disk-free.
- **A shared `common.js` for helpers:** a durable second file is itself un-healable; a fetched one enlarges the frozen fetch logic. Helper duplication between `plugin.js` and `updater.js` is accepted instead.

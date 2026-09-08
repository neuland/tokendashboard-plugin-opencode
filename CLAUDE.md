# tokendashboard-plugin-opencode

opencode plugin that captures token usage per model and forwards it to an internal HTTP endpoint. Handles offline scenarios (VPN not active) via a local store-and-forward queue. Auto-updates the installed plugin file silently in the background once per 24h, using update logic that is **fetched fresh** from the repo and run in-process (so a bug in the update logic self-heals — see ADR-010).

## Files

| File | Purpose |
|---|---|
| `plugin.js` | The durable, self-updating opencode plugin. ESM module whose **only** export is the `TokenUsagePlugin` factory; internals are attached as `TokenUsagePlugin.__internal` for tests. Holds capture + flush + a minimal, permanently-frozen update **loader** (`runFetchedUpdate`). |
| `updater.js` | Lifecycle logic: `install`/`uninstall` (the `npx` `bin` entry) and `converge` (the self-update). **Fetched fresh and run in-process; never stored on the user's machine.** Not discovered by opencode, so it is exempt from the single-export rule and exports its internals for tests. |
| `package.json` | Package manifest (`"type": "module"`). Bump `version` here to trigger the auto-update rollout. |
| `dev-server.js` | Local HTTP server that logs incoming POSTs (port 3000) for manual testing. It does **not** serve raw repo files — tests simulate the raw endpoints via `stubFetch`. |
| `docs/decisions/` | Architecture Decision Records (ADRs). |

## Architecture

opencode loads plugins **in-process** as ESM modules discovered under `~/.config/opencode/plugin/`. There is no host-invoked hook command (unlike Claude Code / Copilot, which spawn external hook scripts) — the plugin factory runs once per opencode process and its returned hooks live for the process lifetime.

The plugin subscribes to opencode's `event` hook:

| Event | Action |
|---|---|
| `message.updated` | Capture a finalized assistant message (`time.completed` set) into the queue, deduped by message id |
| `session.idle` | Flush the queue to the ingest API (debounced) |
| `dispose` (hook) | Best-effort final flush on clean teardown |

On load, the factory also flushes leftover queue (crash/offline backstop) and runs the throttled self-update — both in the background so startup is never blocked. The self-update loader (`plugin.js:runFetchedUpdate`) fetches `main/updater.js` fresh, imports it **in-process** (nothing written to disk), and calls its `converge()`; `converge` fetches + validates + atomically overwrites the installed `plugin.js` on a newer version. See ADR-010.

Local files written by the plugin (`~/.config/opencode` below is shorthand for the config
home — `$XDG_CONFIG_HOME/opencode` when `XDG_CONFIG_HOME` is set, else `~/.config/opencode`.
Both `plugin.js` and `updater.js` resolve `CONFIG_DIR` this way to match opencode's own
`globalConfigPath`; hardcoding `~/.config` would miss a custom `XDG_CONFIG_HOME`):

| Path | Purpose |
|---|---|
| `~/.config/opencode/plugin/tokendashboard-plugin.js` | Installed plugin (auto-updated); the only durable code file on the user's machine |
| `~/.config/opencode/tokendashboard-plugin/config.json` | `currentVersion` + `lastUpdateCheck` timestamp |
| `~/.config/opencode/tokendashboard-plugin/user-id` | Random UUID for user pseudonymization |
| `~/.config/opencode/tokendashboard-plugin/queue/` | Per-entry queue files (`[timestamp]-[pid]-[counter].json`) |
| `~/.config/opencode/tokendashboard-plugin/dead-letter/` | Entries the server permanently rejected (400/422), quarantined for inspection |
| `~/.config/opencode/tokendashboard-plugin/update.lock` | Serializes concurrent `converge` runs (acquired inside `updater.js`) |
| `~/.config/opencode/tokendashboard-plugin/error.log` | Best-effort append-only error log (`logError`); never fatal if the write fails |

## Code style

After editing any source file (`plugin.js`, `updater.js`), the linter and **both** test layers must pass before the change is considered done:

```bash
npm run lint
npm test          # node:test — capture/flush/converge logic + the loader's Node (data:) path
npm run test:bun  # Bun-level smoke test of the frozen loader (its Bun blob: path) — REQUIRED
```

All ESLint errors must be resolved and all tests must pass — no exceptions. `npm test` passing alone does **not** certify a change to the update loader: Node and Bun accept opposite in-process import schemes, so only `npm run test:bun` exercises the loader's production (Bun) path (see ADR-010).

## Testing

Tests use the built-in `node:test` runner (no extra dependency). Run with:

```bash
npm test
```

Conventions:

- Structure every test with `// given`, `// when`, `// then` comments marking the three phases. When a test is a series of one-line assertions where each line is itself given+when+then (e.g. table-style checks), collapse them under a single combined comment instead of splitting artificially.
- Because the plugin writes into `~/.config/opencode/*` via constants derived from `os.homedir()` at module load, fs-touching tests run inside an isolated temp `$HOME`. Use `inSandbox(fn)` (loads `plugin.js`; `fn` receives `(internal, home, Plugin)`) or `inUpdaterSandbox(fn)` (loads `updater.js`; `fn` receives `(updater, home)` where lifecycle fns are top-level exports and helpers live on `updater.__internal`) from `test/helpers.js` — each redirects `$HOME`, imports a fresh module (a distinct `?b=` query forces ESM re-evaluation), and guarantees cleanup. Prefer real temp dirs over mocking `fs`; use `stubFetch` for network tests.
- The Bun-level guard `test/loader-bun.smoke.mjs` is a standalone script (not `node:test`); it runs under `npm run test:bun`. `.mjs` keeps it out of the `test/*.test.js` Node glob.
- `plugin.js` exposes its testable functions only via `TokenUsagePlugin.__internal`, **not** as separate exports — see the single-export constraint below. `updater.js` is exempt (opencode never loads it) and exports its internals directly.

## Critical constraints

- **`plugin.js` has exactly one export** (the `TokenUsagePlugin` factory). opencode's plugin loader invokes *every* module export as a plugin factory, so a second export (even a helper) would be called with the plugin context and break loading. Internals for tests are attached to the factory as `__internal` — do not promote them to real exports (see ADR-008).
- **Capture must be synchronous and atomic.** opencode does not await the `event` hook, so a finalized message is written with `writeEntry` (atomic tmp + rename) immediately, never via a deferred async write (see ADR-003, ADR-009).
- **Capture only finalized messages, exactly once.** A message is captured only when `time.completed` is set, and an in-memory `seen` Set dedupes the repeated `message.updated` events that streaming emits for one message (see ADR-009).
- **Do not change the queue to a single file.** Per-file pattern is required for concurrency safety across overlapping opencode instances (see ADR-004).
- **Flush only deletes on a genuine 2xx.** Delivery requires `isIngestSuccess`: a 2xx that was not redirected and is not an HTML body — an off-VPN captive portal answering 200-HTML or a followed redirect must not be mistaken for success, or queued entries are silently lost. Transient failures stay queued; only a permanent 400/422 is dead-lettered, and a poisoned multi-entry batch is **bisected** so only the offending entry reaches `dead-letter/` (see ADR-005).
- **Lock files** must always be released in a `finally`. `queue/.lock` (`plugin.js`) uses `acquireLock`/`releaseLock`; `update.lock` (`updater.js`) uses the analogous `acquireUpdateLock`/`releaseUpdateLock`. Stale locks (owning process dead) are automatically stolen on next acquire.
- **Atomic rename** for the self-update and all queue/config writes: write to a PID-namespaced `.tmp` first, then `fs.renameSync`.
- **Neither the API base URL nor a repo URL is hardcoded.** Both `--api-base-url <url>` and `--repo-raw-base-url <url>` are required on every install/reinstall and are never read back from a previously stored `config.json` value — there is no fallback default for either. `flush()` reads `apiBaseUrl` from `config.json`, appends the fixed ingest path (`api/usage/ingest/opencode`) to it via `rawUrl`, and refuses to send (keeping the queue) when `apiBaseUrl` is absent; `converge()`/`runFetchedUpdate()` read `repoRawBaseUrl` and no-op (never touching the installed plugin) when it is absent. The value stored/passed for the update source is the raw-file **base URL** directly — not the repo URL itself — so no host-detection logic is needed (a GitHub fork passes `https://raw.githubusercontent.com/<org>/<repo>/main`, a GitLab fork its own `.../-/raw/main`, etc). `plugin.js` and `updater.js` each share a trailing-slash-safe `rawUrl(base, file)` helper (duplicated between the two files by design, like the rest of their small utility floor — see ADR-002).
- **The self-update overwrites the installed file** (`~/.config/opencode/plugin/tokendashboard-plugin.js`), not `import.meta.url`. A failed check (e.g. VPN off) leaves the running plugin untouched and is retried next start (see ADR-007, ADR-010).
- **The update logic is fetched fresh, not durable (see ADR-010).** `plugin.js` keeps only a minimal, permanently-frozen loader (`runFetchedUpdate`); all update/lifecycle logic lives in `updater.js`, which is fetched from `main/updater.js` and imported in-process each check. Keep the loader minimal — it is the one surface that can never self-heal. `capture` and `flush` MUST stay in `plugin.js` and network-independent — never move them behind the fetch, or an offline user captures nothing.
- **In-process import scheme is chosen by CAPABILITY, not `typeof Bun` (see ADR-010).** Under Bun (production) a `data:` URL import fails `ENAMETOOLONG` above ~4 KB (Bun resolves it as a path); `updater.js` is larger, so Bun must use a `blob:` URL. Node is the reverse (no `blob:`, `data:` at any size). `runFetchedUpdate` probes blob-import support once, caches it, then imports the real module once via the chosen scheme. Do not collapse to one scheme and do not key on `typeof Bun` (opencode may not expose the global). This is why `npm run test:bun` is required — `node --test` cannot see the Bun path.
- **Two frozen source-text markers.** `plugin.js` must keep `export const TokenUsagePlugin` (the deployed predecessor and `converge` grep for it) and `updater.js` must keep `export async function converge` (the loader greps for it). Neither can change form without a manual-reinstall break — do not refactor either export.
- **`updater.js` is the `npx` `bin` entry** (there is no `cli.js`); `install`/`uninstall`/`converge` share one file. No `settings.json`-style host config exists in opencode — install is purely a file copy into `plugin/` (see ADR-002, ADR-008, ADR-010).
- **Migration is in place, no bypass.** The deployed `doUpdate` overwrites `main/plugin.js` after checking the `TokenUsagePlugin` marker; the new loader build keeps that marker at that location, so old installs migrate with no relocation and no forced immediate update (see ADR-010).
- **Version bump on user-relevant changes.** When changes to `plugin.js` or `updater.js` require automatic updates for users, **always bump the version in `package.json`** by `0.0.1` (patch release) — this is what triggers the auto-update rollout to installed plugins. Only `plugin.js` is a durable file the self-update overwrites; `updater.js` is fetched fresh, so a `updater.js`-only change still needs the version bump to make `converge` publish a new `plugin.js` — but the fetched `updater.js` is always `main` at check time. Example: `0.1.0` → `0.1.1`.

## Install / Uninstall

```bash
npx git+https://github.com/neuland/tokendashboard-plugin-opencode.git install --api-base-url <api-base-url> --repo-raw-base-url <raw-base-url>
npx git+https://github.com/neuland/tokendashboard-plugin-opencode.git uninstall
```

`--api-base-url` and `--repo-raw-base-url` are both required on every install/reinstall — neither has a built-in default, and neither is read back from a previously stored `config.json` value.

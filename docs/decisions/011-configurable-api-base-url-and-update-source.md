# ADR-011: Configurable, Required Ingest API Base URL and Update Source

## Decision
Both the ingest backend and the update source are install-time CLI flags on `updater.js`'s `bin` entry, **required on every install/reinstall**, stored in `config.json`, and never read back from a previously stored config value — a flag omitted on a re-run is a hard error, not a silent reuse of whatever was configured before:

- `--api-base-url <url>` — base URL of the backend that receives usage data; just a host, no required path. Stored as `apiBaseUrl`; `flush()` reads it, appends the fixed ingest path (`api/usage/ingest/opencode`) via `rawUrl(base, file)`, and refuses to send (keeping the queue intact) when absent.
- `--repo-raw-base-url <url>` — the raw-file base URL the plugin auto-updates from. Stored as `repoRawBaseUrl`; `converge()` and `runFetchedUpdate()` read it directly (no fallback constant) and build every raw-file URL via the same `rawUrl` helper; if absent, both treat that like "not installed" and no-op.

`isPlausibleUrl` takes an optional `requirePath` flag (default `true`): `--repo-raw-base-url` always points at a specific route and must have one; `--api-base-url` is a bare host, validated with `requirePath: false`.

`deliverBatch` takes the fully-resolved ingest URL as an explicit parameter rather than closing over a module constant, so its recursive bisection still posts every retried half to the same URL.

`plugin.js` and `updater.js` each duplicate the small `rawUrl(base, file)` helper (see ADR-010).

## Why
- The ingest backend is deployment-specific — every install needs its own private backend, with no sane default to fall back to.
- The update source is host-specific: GitLab's `/-/raw/main/<file>` and GitHub's `raw.githubusercontent.com/<org>/<repo>/main/<file>` have no common shape, so no single hardcoded constant (or auto-detection from a plain repo URL) can serve every host, and a hardcoded default silently ties every fork to this project's own update stream unless explicitly overridden.
- Requiring both flags explicitly, with no default and no read-back, makes the update source and data destination a conscious choice on every install rather than an easy-to-miss override.

## Alternatives considered
- **Environment variables instead of CLI flags:** less discoverable than a flag a `--help`/README can document, for what's typically a one-shot invocation.
- **Auto-detecting the raw-file URL shape from a repo URL:** no common derivation across git hosts (GitLab, GitHub, self-hosted Gitea, Bitbucket, ...); unbounded maintenance for no real benefit.
- **A hardcoded default pointing at this project's own repo:** becomes stale the moment this repo's own host changes, and silently ties forks to it unless the operator remembers to override it.

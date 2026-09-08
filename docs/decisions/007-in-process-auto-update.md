# ADR-007: In-Process Automatic Self-Update

## Decision
On factory load, `plugin.js` runs a throttled self-update check in-process and in the background (not awaited by the factory): `maybeUpdate` reads `config.json`, no-ops if not installed (`currentVersion` absent) or if checked within the last 24h, and otherwise triggers the update (mechanism in ADR-010). A failed check (e.g. offline) still records nothing and is retried next start; a reachable-but-not-newer check is not re-polled for 24h.

## Why
- opencode has no host-invoked command hook to run an updater — the plugin only runs in-process, so self-update must happen there too.
- Running the check in the background means plugin load never blocks opencode startup on the network — an unreachable host can mean 20-30s of DNS/TCP timeouts.
- The 24h throttle avoids unnecessary traffic and rate limiting on every opencode start.

## Alternatives considered
- **Re-resolve via `opencode.json`/Bun on each start:** reproduces the network-at-startup dependency ADR-002/008 reject.
- **Always re-install via `npx git+<url>`:** requires git and npm at runtime; slower and unnecessary when only `plugin.js` changed.

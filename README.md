# tokendashboard-plugin-opencode

opencode plugin that captures token usage per model and forwards it to an internal HTTP endpoint.

## Features

- Captures input/output, reasoning and cache (read/write) tokens per assistant message and model, plus opencode's precomputed per-message cost
- Pseudonymizes users via a local random UUID (no personal data transmitted)
- Store-and-forward queue: entries survive offline periods (e.g. VPN not active) and are sent on the next flush
- Loads from a local file, so it keeps tracking even when the network is down at startup
- Auto-updates the installed plugin file silently in the background once per 24 hours

## Install

```bash
npx --allow-git=all git+https://github.com/neuland/tokendashboard-plugin-opencode.git install --api-base-url <api-base-url> --repo-raw-base-url https://raw.githubusercontent.com/neuland/tokendashboard-plugin-opencode/main
```

Both flags are required on every install/reinstall — neither has a built-in default:

- `--api-base-url <url>` — the base URL of the backend that receives usage data (e.g. `https://example.com`); the plugin appends its own fixed ingest path (`/api/usage/ingest/opencode`) to it.
- `--repo-raw-base-url <url>` — the raw-file base URL the plugin auto-updates from (e.g. `https://raw.githubusercontent.com/<org>/<repo>/main` for a GitHub fork, or `https://gitlab.example.com/<org>/<repo>/-/raw/main` for a GitLab one).

Neither value is read back from a previous `config.json` — pass both again on every reinstall.

## Uninstall

```bash
npx --allow-git=all git+https://github.com/neuland/tokendashboard-plugin-opencode.git uninstall
```

## How it works

opencode loads plugins **in-process** from `~/.config/opencode/plugin/`. `updater.js` copies a
single, dependency-free `plugin.js` there as `tokendashboard-plugin.js`; opencode then
auto-discovers and loads it on every start — from disk, with no network. (This is why the
plugin keeps tracking even when the VPN is down at startup, unlike a package referenced in
`opencode.json` that opencode would have to resolve over the network — see
`docs/decisions/008`.)

The plugin subscribes to opencode's `event` hook:

| Event | Purpose |
|---|---|
| `message.updated` | When an assistant message is finalized (`time.completed` set), write one queue entry for it. Repeated streaming updates of the same message are deduped. |
| `session.idle` | Flush the local queue to the ingest API (debounced). |

On load it also flushes any queue a previous crashed/offline run left behind, and on a clean
teardown (`dispose`) it flushes once more. Capture is per finalized assistant message (each
message has exactly one model), so a multi-step turn produces one entry per step/model.

The payload sent to the ingest API:

```json
{
  "user_id": "<random-uuid>",
  "prompts": [
    {
      "entry_id": "<sha1(session|message|model)>",
      "timestamp": "2026-06-29T11:32:23.530Z",
      "session_id": "...",
      "model": "claude-sonnet-4-6",
      "provider": "anthropic",
      "usage": {
        "input_tokens": 100,
        "output_tokens": 50,
        "reasoning_tokens": 10,
        "cache_read_tokens": 200,
        "cache_write_tokens": 5
      },
      "cost": 0.0123
    }
  ]
}
```

The backend stays authoritative for pricing (it recomputes cost from the raw tokens); the
`cost` field is opencode's own per-message figure, sent as a cross-check.

## Security

Beyond sending usage data to your own `--api-base-url`, this plugin **auto-updates
itself by fetching and importing code**: once per 24 hours it fetches `updater.js`
from your configured `--repo-raw-base-url` and imports it in-process (never written
to disk), which in turn may fetch and overwrite the installed `plugin.js`. This is by
design (see `docs/decisions/` for the ADRs behind it) — the trust boundary is
whoever controls the raw-file host you pass to `--repo-raw-base-url`. By default
that's this repository's `main` branch, maintained by neuland — using it means
trusting that we (and anyone whose PR we merge) never point it at a different
endpoint or ship malicious code. If you'd rather not extend that trust, point
`--repo-raw-base-url` at a fork you control instead — you'll then need to keep it in
sync yourself. See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Development

```bash
node updater.js install --api-base-url <url> --repo-raw-base-url <url>  # install the plugin into ~/.config/opencode/plugin/ and register the hooks in ~/.config/opencode/plugin/
npm run unregister  # remove the installed plugin file
npm run lint        # run ESLint
npm test            # run the unit tests (Node path)
npm run test:bun    # required for any change to the update loader — see below
```

`npm run test:bun` runs a Bun-level smoke test of the update loader's
production import path and requires the [opencode CLI](https://opencode.ai)
to be installed locally (it invokes `opencode test/loader-bun.smoke.mjs`
under Bun, not plain `bun`). `npm test` alone does **not** exercise this
path — Node and Bun use opposite in-process module-import schemes, and only
`npm run test:bun` runs under Bun. If you're not touching the update
loader (`updater.js`'s `converge`, or `plugin.js`'s `canImportBlobUrl`/
`importModuleSource`), `npm test` is sufficient.

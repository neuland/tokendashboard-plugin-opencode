# ADR-002: Distribution via npx and Git

## Decision
Distribute as an npm package via `npx` with a Git URL pointing to the repo:

```bash
npx git+https://github.com/neuland/tokendashboard-plugin-opencode.git install --api-base-url <api-base-url> --repo-raw-base-url <raw-base-url>
```

`updater.js` is the `bin` entry in `package.json` and handles install/uninstall. Installation copies the single, dependency-free `plugin.js` to `~/.config/opencode/plugin/tokendashboard-plugin.js`, where opencode auto-discovers it.

## Why
- A single command handles install and uninstall; no `settings.json`/`opencode.json` editing.
- Copying a local file (rather than a package reference opencode resolves at startup) means opencode loads the plugin from disk on every start with no network dependency (see ADR-008).
- `plugin.js` auto-updates (see ADR-007, ADR-010); `updater.js`/`package.json` changes still require a manual `npx` re-run.
- `--api-base-url <url>` and `--repo-raw-base-url <url>` are required install-time flags — see ADR-011.

## Alternatives considered
- **`plugin` entry in `opencode.json`:** opencode resolves/installs it via Bun at startup; if the network is down at that moment, the plugin is treated as not installed and no tokens are counted.
- **Manual file copy / settings editing:** error-prone and too much effort for end users.
- **Git-host npm registry:** requires a one-time registry setup on each machine.
- **Public npm registry:** not used; revisit if publishing to npm is wanted alongside the GitHub repo.

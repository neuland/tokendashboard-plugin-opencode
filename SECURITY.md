# Security Policy

## Reporting a vulnerability

Please do **not** file security issues as public GitHub issues. Instead,
report them to `tokendashboard@neuland-bfi.de`. You can expect an
acknowledgement within a few working days.

- A description of the issue and its potential impact
- Steps to reproduce (a minimal repro is ideal)
- The version/commit affected

We'll acknowledge reports as quickly as we can and keep you updated as we work on a
fix. Please give us a reasonable amount of time to address the issue before any
public disclosure.

## Scope and trust model

This plugin runs in-process inside opencode and:

- **Sends usage data** (token counts, cost, a session id, and a random per-machine
  UUID — never prompt or file content) to the `--api-base-url` you configure at
  install time. That backend is under your own control; this plugin has no
  hardcoded endpoint.
- **Auto-updates itself** once per 24 hours by fetching `updater.js` from the
  `--repo-raw-base-url` you configure and importing it in-process (never written
  to disk), which may in turn overwrite the installed `plugin.js`. This is
  intentional — it's how fixes and features reach installed users without a
  manual reinstall — but it means **whoever controls that raw-file host has code
  execution on every machine that installed with it**.

Given that trust model, please treat the following as in scope for a security
report:

- Anything that lets a party *other than* the configured `--repo-raw-base-url`
  host push code that gets executed (e.g. a redirect or MITM bypass, a way around
  the HTTPS-only check, or a way to make the plugin fetch from an
  unconfigured/attacker-chosen host)
- Path traversal, symlink, or injection issues in how the plugin writes its
  queue or overwrites the installed `plugin.js`
- Ways to make the plugin exfiltrate more than the documented payload (see the
  README's "How it works" section for the exact JSON shape sent)
- Local privilege escalation or arbitrary file write via the plugin's own files
  under `~/.config/opencode/tokendashboard-plugin/`

**Out of scope:** the security of a self-hosted `--api-base-url` backend deployment
(that's the responsibility of whoever operates it — see the separate
TokenDashboard backend repository), and reports that assume `--repo-raw-base-url`
is pointed at a host the reporter doesn't trust — that is the documented,
deliberate trust boundary, not a vulnerability in itself.

## Supported versions

Only the latest released version is supported. Since `plugin.js` auto-updates
within 24 hours of a version bump, most installs converge to the latest fix
automatically once it's published.

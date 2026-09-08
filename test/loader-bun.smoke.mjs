// Bun-level smoke test for the FROZEN self-update loader (plugin.js:runFetchedUpdate).
//
// Why this exists separately from `npm test`: opencode runs on Bun, and the in-process
// import mechanism differs by runtime in ways a node:test cannot see:
//   - Bun mishandles a data: URL import above ~4 KB (resolves it as a path → ENAMETOOLONG);
//     updater.js is larger, so under Bun the loader MUST use a blob: URL.
//   - Node is the opposite (no blob: support; data: works at any size).
// A node:test therefore cannot catch a regression of the Bun path. This file runs under the
// exact embedded Bun via `npm run test:bun`
// (BUN_BE_BUN=1 opencode test/loader-bun.smoke.mjs) and drives the real loader end to end.
//
// Exit non-zero on any failure so the script fails loudly.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

assert.ok(typeof Bun !== 'undefined', 'this smoke test must run under Bun (npm run test:bun)');

// Point the plugin's config-home constants at a throwaway sandbox BEFORE importing plugin.js
// (they are computed from process.env at module load).
//
// MUST use XDG_CONFIG_HOME, not HOME: plugin.js resolves CONFIG_DIR as
// `process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')` — XDG_CONFIG_HOME is a
// plain JS process.env read, but os.homedir() is a native call. Under Bun, writing
// `process.env.HOME = ...` from JS does NOT reliably propagate to that native call (unlike
// Node), so an override via HOME silently no-ops and plugin.js resolves the REAL
// ~/.config/opencode instead of the sandbox. XDG_CONFIG_HOME sidesteps os.homedir()
// entirely, so it isolates correctly regardless of that Bun/Node env-propagation difference.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tup-bun-smoke-'));
const xdgConfigHome = path.join(home, 'config');
process.env.XDG_CONFIG_HOME = xdgConfigHome;
// Also set HOME/USERPROFILE for good measure (harmless, and correct under Node), but they
// are NOT what isolation depends on here.
process.env.HOME = home;
process.env.USERPROFILE = home;

const UPDATER_SRC = fs.readFileSync(new URL('../updater.js', import.meta.url), 'utf8');
const VALID_PLUGIN = '// plugin\nexport const TokenUsagePlugin = async () => ({});\n';

function serve(body, contentType = 'text/javascript') {
  return {
    ok: true, status: 200, redirected: false,
    headers: { get: () => contentType },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

// Stub fetch to serve the repo raw endpoints the loader + converge hit.
global.fetch = async url => {
  const u = String(url);
  if (u.includes('updater.js')) {
    return serve(UPDATER_SRC);
  }
  if (u.includes('package.json')) {
    return serve(JSON.stringify({ version: '9.9.9' }), 'application/json');
  }
  return serve(VALID_PLUGIN);
};

const plugin = (await import(new URL('../plugin.js', import.meta.url).href)).TokenUsagePlugin;
const internal = plugin.__internal;

// Hard guard, checked BEFORE any write: if plugin.js's resolved paths ever fall outside the
// sandbox (e.g. the isolation trick above breaks again on some future Bun), abort loudly
// instead of silently writing into a real ~/.config/opencode.
for (const p of Object.values(internal.paths)) {
  assert.ok(
    p.startsWith(xdgConfigHome),
    `sandbox escape: plugin.js resolved "${p}" outside the sandbox (${xdgConfigHome}) — aborting before any write`);
}

internal.saveConfig({ currentVersion: '0.1.0', repoRawBaseUrl: 'https://example.com/raw/main' });

// (a) THE guard: the real loader fetches the FULL-SIZE updater.js, imports it in-process
// (blob: URL under Bun) and runs converge(), which applies the update. If the loader ever
// regressed to a data: URL under Bun, this would fail (ENAMETOOLONG on the >4 KB source).
await internal.runFetchedUpdate();
assert.equal(
  fs.readFileSync(internal.paths.INSTALLED_PLUGIN_PATH, 'utf8'),
  VALID_PLUGIN,
  'loader must fetch the full-size updater.js, import it, and apply the update under Bun');
assert.equal(internal.loadConfig().currentVersion, '9.9.9');
console.log('  (a) real loader applied the update via in-process import under Bun — OK');

// (b) Document WHY the loader must not use a data: URL under Bun: a data: URL import of the
// full-size updater source fails here. (Informational — the loader uses blob: regardless.)
try {
  await import('data:text/javascript;base64,' + Buffer.from(UPDATER_SRC, 'utf8').toString('base64'));
  console.warn('  (b) NOTE: large data: URL import now succeeds on this Bun; blob: still used for safety');
} catch (e) {
  console.log(`  (b) confirmed: large data: URL import fails under this Bun (${e.code || e.name}) — blob: is required`);
}

// (c) A malformed / HTML body must be a safe no-op, not a throw out of the loader.
global.fetch = async () => serve('<!doctype html><html>login</html>', 'text/html');
let threw = false;
try {
  await internal.runFetchedUpdate();
} catch {
  threw = true;
}
assert.equal(threw, false, 'an HTML/captive-portal body must be a no-op, not a throw');
console.log('  (c) HTML/captive-portal body was a safe no-op — OK');

fs.rmSync(home, { recursive: true, force: true });
console.log('loader-bun smoke: PASS');

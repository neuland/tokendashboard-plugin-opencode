import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLUGIN_URL = new URL('../plugin.js', import.meta.url);
const UPDATER_URL = new URL('../updater.js', import.meta.url);

// Distinct query each import so ESM re-evaluates the module, picking up the current $HOME
// in its load-time path constants (mirrors the Claude/Copilot `delete require.cache` trick).
let bust = 0;

// Create an isolated temp directory and point $HOME at it, so the plugin's
// ~/.config/opencode/* path constants (computed at module load from os.homedir(), which
// reads $HOME on POSIX) resolve inside the sandbox. Returns { home, cleanup }.
export function withTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tup-opencode-test-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home; // Windows fallback for os.homedir()
  // CONFIG_DIR resolves as `$XDG_CONFIG_HOME/opencode` else `~/.config/opencode`. Clear
  // XDG_CONFIG_HOME so the path constants fall back to the sandbox HOME — otherwise an
  // XDG_CONFIG_HOME set in the real environment would point the plugin at the developer's
  // actual ~/.config/opencode instead of the temp dir.
  delete process.env.XDG_CONFIG_HOME;

  function cleanup() {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    if (prevXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
  return { home, cleanup };
}

// Import a fresh copy of plugin.js so its module-level path constants pick up the current
// $HOME. Must be called AFTER withTempHome(). Returns the TokenUsagePlugin factory.
export async function loadPlugin() {
  const mod = await import(`${PLUGIN_URL.href}?b=${bust++}`);
  return mod.TokenUsagePlugin;
}

// Run fn inside an isolated temp $HOME against a freshly loaded plugin module. fn receives
// (internal, home, Plugin) — `internal` is TokenUsagePlugin.__internal (all testable fns).
export async function inSandbox(fn) {
  const { home, cleanup } = withTempHome();
  try {
    const Plugin = await loadPlugin();
    return await fn(Plugin.__internal, home, Plugin);
  } finally {
    cleanup();
  }
}

// Run fn against a freshly loaded updater.js inside an isolated temp $HOME, with console.log
// muted (install/uninstall are chatty). fn receives (updater, home) where `updater` is the
// whole module — its lifecycle fns (converge/install/uninstall) are top-level exports and its
// testable helpers live on updater.__internal (updater.js is exempt from the single-export
// rule, so it exports freely; see ADR-010).
export async function inUpdaterSandbox(fn) {
  const { home, cleanup } = withTempHome();
  const updater = await import(`${UPDATER_URL.href}?b=${bust++}`);
  const origLog = console.log;
  console.log = () => {};
  try {
    return await fn(updater, home);
  } finally {
    console.log = origLog;
    cleanup();
  }
}

// Replace global.fetch with a recording stub for the duration of a test. handler(url,
// options, callIndex) returns a Response-like object (see makeResponse), or throws to
// simulate a network failure (which fetchWithTimeout maps to null). Returns { calls, restore }.
export function stubFetch(handler) {
  const prev = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options, calls.length - 1);
  };
  return {
    calls,
    restore: () => {
      global.fetch = prev;
    },
  };
}

// Build a minimal Response-like object for the fetch stub.
export function makeResponse({
  status = 200, ok, redirected = false, contentType = 'application/json', json, text,
} = {}) {
  return {
    ok: ok ?? (status >= 200 && status < 300),
    status,
    redirected,
    headers: { get: k => (k.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => json,
    text: async () => text,
  };
}

// A finalized opencode assistant message, with overridable fields.
export function assistantMessage(overrides = {}) {
  return {
    id: 'msg-1',
    sessionID: 'sess-1',
    role: 'assistant',
    modelID: 'claude-sonnet-4-6',
    providerID: 'anthropic',
    cost: 0.0123,
    time: { created: 1000, completed: 2000 },
    tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 200, write: 5 } },
    ...overrides,
  };
}

// --- Path helpers for assertions ---

export const pluginDataDir = home => path.join(home, '.config', 'opencode', 'tokendashboard-plugin');
export const queueDir = home => path.join(pluginDataDir(home), 'queue');
export const deadLetterDir = home => path.join(pluginDataDir(home), 'dead-letter');
export const configPath = home => path.join(pluginDataDir(home), 'config.json');
export const userIdPath = home => path.join(pluginDataDir(home), 'user-id');
export const installedPluginPath = home =>
  path.join(home, '.config', 'opencode', 'plugin', 'tokendashboard-plugin.js');

export function readQueue(home) {
  const dir = queueDir(home);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

export function queueFileNames(home) {
  const dir = queueDir(home);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
}

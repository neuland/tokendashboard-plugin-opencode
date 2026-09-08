#!/usr/bin/env node

// Lifecycle logic for the opencode tokendashboard plugin: install / uninstall (the `npx`
// bin entry) and converge (the self-update). Unlike plugin.js, never stored on the user's
// machine — fetched fresh from the repo and imported in-process by plugin.js's loader (see
// ADR-010). Because of that (and to load under the Node test runner) it must import only
// node: builtins and re-derive every path from os.homedir()/XDG_CONFIG_HOME, never
// __filename.
//
// Not discovered by opencode (never lives under plugin/), so the single-export rule that
// constrains plugin.js (ADR-008) does not apply — it exports freely, and its testable
// internals are exported at the bottom.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Trailing-slash-safe join of a raw-file base URL with a filename. Duplicated in plugin.js
// rather than imported — see ADR-010 on the accepted duplication cost.
const rawUrl = (base, file) => `${base.replace(/\/$/, '')}/${file}`;

const TIMEOUT_MS = 5000;

// Mirror opencode's own config-home resolution ($XDG_CONFIG_HOME/opencode, else
// ~/.config/opencode) so we install/update where opencode actually discovers plugins.
// Must match plugin.js's CONFIG_DIR.
const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
const INSTALLED_PLUGIN_PATH = path.join(CONFIG_DIR, 'plugin', 'tokendashboard-plugin.js');
const PLUGIN_DIR = path.join(CONFIG_DIR, 'tokendashboard-plugin');
const CONFIG_PATH = path.join(PLUGIN_DIR, 'config.json');
const UPDATE_LOCK_FILE = path.join(PLUGIN_DIR, 'update.lock');

// --- Atomic write ---

function atomicWriteSync(filePath, content) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

// --- Config ---

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  atomicWriteSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- Lock (same protocol as plugin.js's queue lock; duplicated by design, see ADR-010) ---

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireUpdateLock(lockFile = UPDATE_LOCK_FILE) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      let pid;
      try {
        pid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10);
      } catch {
        continue; // Lock vanished between wx-fail and read — retry
      }
      if (pid && isProcessAlive(pid)) {
        return false;
      }
      // Stale (dead pid) or NaN (crashed creator before pid write) — steal atomically.
      const aside = `${lockFile}.steal.${process.pid}`;
      try {
        fs.renameSync(lockFile, aside);
      } catch {
        continue; // another stealer moved/replaced it first — retry the wx
      }
      let stolenPid;
      try {
        stolenPid = parseInt(fs.readFileSync(aside, 'utf8'), 10);
      } catch {
        stolenPid = NaN;
      }
      if (stolenPid && stolenPid !== pid && isProcessAlive(stolenPid)) {
        try {
          fs.linkSync(aside, lockFile);
        } catch {}
        try {
          fs.rmSync(aside);
        } catch {}
        return false;
      }
      try {
        fs.rmSync(aside);
      } catch {}
    }
  }
  return false;
}

function releaseUpdateLock(lockFile = UPDATE_LOCK_FILE) {
  try {
    fs.rmSync(lockFile);
  } catch {}
}

// --- HTTP ---

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS, readBody = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!readBody) {
      return res;
    }
    const body = await readBody(res);
    return { res, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Semver ---

function semverGt(a, b) {
  const parse = v => String(v).split('.').map(Number);
  const pa = parse(a);
  const pb = parse(b);
  if ([...pa, ...pb].some(Number.isNaN)) {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) {
      return x > y;
    }
  }
  return false;
}

// --- Local package version (npx/install path only; never in the data: URL path) ---

// Read the version from the package.json shipped alongside this file. Guarded because in
// the fetched-fresh (data: URL) path import.meta.url is not a file URL and fileURLToPath
// throws — but install() (the only caller) never runs in that path.
function getLocalVersion() {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

// --- converge: the self-update (fetched fresh and run in-process by plugin.js's loader) ---

// The loader greps this file for the literal `export async function converge` before
// importing it — a FROZEN marker (see ADR-010). Do not rename converge or change its
// export form without a manual-reinstall break.
export async function converge() {
  const config = loadConfig();
  if (!config.currentVersion) {
    return; // not installed (or uninstalled) — never touch anything
  }

  // Serialize overlapping opencode instances; a stale lock from a crash is stolen.
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  if (!acquireUpdateLock(UPDATE_LOCK_FILE)) {
    return;
  }

  try {
    const rawBase = config.repoRawBaseUrl;
    if (!rawBase) {
      return; // no update source configured — never touch anything
    }

    const pkg = await fetchWithTimeout(
      rawUrl(rawBase, 'package.json'), {}, TIMEOUT_MS, r => r.json());
    if (!pkg?.res?.ok) {
      return;
    }
    const remoteVersion = pkg.body?.version;
    if (!remoteVersion) {
      return;
    }

    // Uninstall race guard: re-read after the round trip and bail if we were uninstalled.
    if (!loadConfig().currentVersion) {
      return;
    }

    // Server reachable: record the check so we don't re-poll for 24h regardless of outcome.
    saveConfig({ ...loadConfig(), lastUpdateCheck: new Date().toISOString() });

    if (!semverGt(remoteVersion, config.currentVersion)) {
      return;
    }

    const plugin = await fetchWithTimeout(
      rawUrl(rawBase, 'plugin.js'), {}, 10000, r => r.text());
    if (!plugin?.res?.ok || plugin.res.redirected) {
      return;
    }

    const newContent = plugin.body;
    // Positive proof of a complete plugin.js payload (rejects empty/HTML/truncated bodies).
    if (!newContent.includes('export const TokenUsagePlugin')) {
      return;
    }

    // Uninstall race guard again, immediately before publishing.
    if (!loadConfig().currentVersion) {
      return;
    }

    fs.mkdirSync(path.dirname(INSTALLED_PLUGIN_PATH), { recursive: true });
    try {
      atomicWriteSync(INSTALLED_PLUGIN_PATH, newContent);
      saveConfig({ ...loadConfig(), currentVersion: remoteVersion });
    } catch {
      // best-effort; a failed write leaves the running plugin untouched, retried next start
    }
  } finally {
    releaseUpdateLock(UPDATE_LOCK_FILE);
  }
}

// --- CLI arg parsing ---

// Parses `--api-base-url <url>` / `--api-base-url=<url>`. The API base URL has no default
// (it is deployment-specific) and is required on every install invocation; flush() (in
// plugin.js) appends the fixed ingest path to it and refuses to send — keeping the queue —
// when it is absent from config.json.
function parseApiBaseUrlArg(args) {
  const eq = args.find(a => a.startsWith('--api-base-url='));
  if (eq) {
    return eq.slice('--api-base-url='.length) || undefined;
  }
  const idx = args.indexOf('--api-base-url');
  if (idx !== -1) {
    return args[idx + 1];
  }
  return undefined;
}

// Parses `--repo-raw-base-url <url>` / `--repo-raw-base-url=<url>`. No default: it is
// deployment-specific (which git host serves the raw files) and is required on every
// install invocation, exactly like --api-base-url.
function parseRepoUrlArg(args) {
  const eq = args.find(a => a.startsWith('--repo-raw-base-url='));
  if (eq) {
    return eq.slice('--repo-raw-base-url='.length) || undefined;
  }
  const idx = args.indexOf('--repo-raw-base-url');
  if (idx !== -1) {
    return args[idx + 1];
  }
  return undefined;
}

// The command is the first non-flag token. Must skip a value-flag's separate-token value
// (e.g. `npx <pkg> --api-base-url <url>`, missing the `install` word) or the URL would be
// misparsed as the command.
const VALUE_FLAGS = ['--api-base-url', '--repo-raw-base-url'];
const HTTP_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// Rejects values that aren't a well-formed http(s) URL so a typo (e.g. `--api-base-url=hase`)
// fails fast at install time instead of surfacing later as silent flush/update failures.
// requirePath: the repo raw-file base URL always points at a specific path (an org/repo/branch
// route) — a bare origin is never valid there. The API base URL, by contrast, is just a host;
// plugin.js appends the fixed ingest path itself, so a bare origin is valid for it.
export function isPlausibleUrl(value, requirePath = true) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:') {
      // ok
    } else if (parsed.protocol === 'http:' && HTTP_ALLOWED_HOSTS.has(parsed.hostname)) {
      // ok — local development only
    } else {
      return false;
    }
    return !requirePath || parsed.pathname.length > 1;
  } catch {
    return false;
  }
}

function extractCommand(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.includes(a)) {
        i++;
      }
      continue;
    }
    return a;
  }
  return undefined;
}

// --- install / uninstall (the npx bin entry) ---

export function install(apiBaseUrl, repoRawBaseUrl) {
  const version = getLocalVersion();
  const dir = path.dirname(fileURLToPath(import.meta.url));

  fs.mkdirSync(path.dirname(INSTALLED_PLUGIN_PATH), { recursive: true });
  fs.copyFileSync(path.join(dir, 'plugin.js'), INSTALLED_PLUGIN_PATH);
  console.log(`Plugin installed: ${INSTALLED_PLUGIN_PATH}`);

  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  const existing = loadConfig();
  atomicWriteSync(CONFIG_PATH, JSON.stringify({
    ...existing,
    currentVersion: version,
    lastUpdateCheck: new Date().toISOString(),
    apiBaseUrl,
    repoRawBaseUrl,
  }, null, 2));
  console.log(`Config written: ${CONFIG_PATH}`);
  console.log(`API base URL: ${apiBaseUrl}`);
  console.log(`Update source: ${repoRawBaseUrl}`);
  console.log(`\nDone. Installed version ${version}.`);
}

export function uninstall() {
  // Clear currentVersion FIRST so any in-flight converge aborts on its existence guard
  // and cannot re-materialize the plugin we are about to remove.
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      fs.rmSync(CONFIG_PATH);
    }
  } catch {}
  // The queue/, user-id, dead-letter/ state is intentionally left in place so any
  // undelivered telemetry can still flush if the plugin is reinstalled (zero data loss).
  if (fs.existsSync(INSTALLED_PLUGIN_PATH)) {
    fs.rmSync(INSTALLED_PLUGIN_PATH);
    console.log(`Plugin removed: ${INSTALLED_PLUGIN_PATH}`);
  }
  console.log('\nDone. Token usage tracking removed.');
}

// `args` is the full flag-bearing argv tail (e.g. process.argv.slice(2)), not just the
// command word — flags must be visible here so `install` can require --api-base-url.
export function run(args) {
  const command = extractCommand(args) ?? 'install';
  if (command === 'install') {
    const apiBaseUrlArg = parseApiBaseUrlArg(args);
    const repoRawBaseUrlArg = parseRepoUrlArg(args);
    if (!apiBaseUrlArg || !repoRawBaseUrlArg) {
      console.error('Missing required --api-base-url <url> and/or --repo-raw-base-url <url>.');
      console.error(
        'Usage: tokendashboard-plugin-opencode install --api-base-url <url> --repo-raw-base-url <url>');
      process.exit(1);
      return;
    }
    if (!isPlausibleUrl(apiBaseUrlArg, false) || !isPlausibleUrl(repoRawBaseUrlArg)) {
      console.error('--api-base-url and --repo-raw-base-url must be valid http(s) URLs.');
      process.exit(1);
      return;
    }
    install(apiBaseUrlArg, repoRawBaseUrlArg);
  } else if (command === 'uninstall') {
    uninstall();
  } else {
    console.error(`Unknown command: ${command}`);
    console.error(
      'Usage: tokendashboard-plugin-opencode [install|uninstall] --api-base-url <url> --repo-raw-base-url <url>');
    process.exit(1);
  }
}

export function main() {
  run(process.argv.slice(2));
}

// Run as a script (`node updater.js …` / the npx bin shim) but NOT when imported — by a
// test, or via the loader's data: URL (whose import.meta.url is a data: URL, never argv[1]).
// realpathSync is required: npm's bin shim is a symlink, and Node's ESM loader resolves
// symlinks before setting import.meta.url, so comparing the raw argv[1] path never matches.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main();
}

// Internals exported for unit tests. Safe here (unlike plugin.js) because opencode never
// loads this file as a plugin.
export const __internal = {
  atomicWriteSync, loadConfig, saveConfig, isProcessAlive, acquireUpdateLock, releaseUpdateLock,
  fetchWithTimeout, semverGt, getLocalVersion,
  parseApiBaseUrlArg, parseRepoUrlArg, extractCommand, rawUrl,
  paths: { CONFIG_DIR, INSTALLED_PLUGIN_PATH, PLUGIN_DIR, CONFIG_PATH, UPDATE_LOCK_FILE },
  constants: { TIMEOUT_MS },
};

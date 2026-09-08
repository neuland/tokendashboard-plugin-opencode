// opencode plugin that captures token usage per model and forwards it to an internal
// HTTP endpoint. Handles offline scenarios (VPN not active) via a local
// store-and-forward queue, and updates the installed plugin file silently in the
// background once per 24h.
//
// opencode loads plugins in-process as ESM modules from ~/.config/opencode/plugin/.
// The module's only export is the plugin factory below — opencode's loader invokes
// EVERY export as a plugin factory, so internals are attached to that factory as
// `__internal` (for tests) rather than exported separately. See docs/decisions/008.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Trailing-slash-safe join of a raw-file base URL with a filename. Duplicated from
// updater.js rather than imported — see ADR-010 on the accepted duplication cost.
const rawUrl = (base, file) => `${base.replace(/\/$/, '')}/${file}`;

// The ingest route lives at a fixed path under the configured API base URL — only the
// host is deployment-specific (see ADR-011).
const INGEST_PATH = 'api/usage/ingest/opencode';

// opencode's config home ($XDG_CONFIG_HOME/opencode, else ~/.config/opencode). Must mirror
// opencode's own globalConfigPath resolution exactly, or under a custom XDG_CONFIG_HOME
// we'd install/update the plugin where opencode never looks.
const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
// The installed, self-updating copy of this file (updater.js install copies plugin.js here).
const INSTALLED_PLUGIN_PATH = path.join(CONFIG_DIR, 'plugin', 'tokendashboard-plugin.js');
const PLUGIN_DIR = path.join(CONFIG_DIR, 'tokendashboard-plugin');
const QUEUE_DIR = path.join(PLUGIN_DIR, 'queue');
const DEAD_LETTER_DIR = path.join(PLUGIN_DIR, 'dead-letter');
const LOCK_FILE = path.join(QUEUE_DIR, '.lock');
const USER_ID_PATH = path.join(PLUGIN_DIR, 'user-id');
const CONFIG_PATH = path.join(PLUGIN_DIR, 'config.json');
const LOG_PATH = path.join(PLUGIN_DIR, 'error.log');

const TIMEOUT_MS = 5000;
// Cap entries per POST so a long offline backlog (many messages × models) never
// produces one oversized request body that the server might reject wholesale.
const FLUSH_BATCH_SIZE = 500;
// Drop queued entries older than this so the queue can't grow without bound when the
// endpoint is unreachable for a very long time (filename is enqueue-time-prefixed).
const MAX_QUEUE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Coalesce the bursts of session.idle events into a single flush.
const FLUSH_DEBOUNCE_MS = 1500;
// Backlog older than this is no longer "waiting for the next flush" — the endpoint has
// been unreachable across multiple sessions, so the startup status toast escalates it.
const STALE_QUEUE_MS = 24 * 60 * 60 * 1000;
// A logged error inside this window is still relevant to the session that's starting now.
const ERROR_RECENCY_MS = 15 * 60 * 1000;

let writeCounter = 0;
// Message ids already queued in THIS process. message.updated fires repeatedly while a
// message streams (each event carries the whole message), so without this every
// streaming snapshot of one assistant message would be queued again. The plugin factory
// runs once per opencode process, so this Set persists for the process lifetime.
const seen = new Set();
let flushTimer = null;
let pluginVersion = null;

// --- Logging ---

function logError(context, err) {
  try {
    ensurePluginDir();
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [${context}] ${err}\n`);
  } catch {}
}

// --- Atomic write ---

function atomicWriteSync(filePath, content) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

// --- Dirs ---

function ensurePluginDir() {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
}

function ensureQueueDir() {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

// --- User ID ---

function getUserId() {
  if (fs.existsSync(USER_ID_PATH)) {
    return fs.readFileSync(USER_ID_PATH, 'utf8').trim();
  }
  ensurePluginDir();
  const id = crypto.randomUUID();
  atomicWriteSync(USER_ID_PATH, id);
  return id;
}

// --- Plugin Version ---

function getPluginVersion() {
  try {
    const currentDir = path.dirname(new URL(import.meta.url).pathname);
    const packagePath = path.join(currentDir, 'package.json');
    const content = fs.readFileSync(packagePath, 'utf8');
    const pkg = JSON.parse(content);
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
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
  ensurePluginDir();
  atomicWriteSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- Queue ---

function writeEntry(entry) {
  ensureQueueDir();
  // Counter guarantees uniqueness when multiple writeEntry calls land in the same
  // millisecond inside one process. Atomic (tmp + rename), not a plain writeFileSync: a
  // concurrent flush in another process snapshots the queue directory and deletes the
  // whole snapshot on success — a non-atomic write could let it see a half-written file
  // (parse-fail → dropped, then deleted anyway). Rename publishes the name only once the
  // content is complete (see ADR-004).
  atomicWriteSync(
    path.join(QUEUE_DIR, `${Date.now()}-${process.pid}-${writeCounter++}.json`),
    JSON.stringify(entry),
  );
}

function getQueueFiles() {
  if (!fs.existsSync(QUEUE_DIR)) {
    return [];
  }
  return fs.readdirSync(QUEUE_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .map(f => path.join(QUEUE_DIR, f));
}

// Queue filenames are `${Date.now()}-${pid}-${counter}.json`, so the leading number is
// the enqueue time in ms. Returns null for any file that doesn't match.
function enqueueTime(filePath) {
  const n = parseInt(path.basename(filePath), 10);
  return Number.isNaN(n) ? null : n;
}

// Delete entries older than MAX_QUEUE_AGE_MS and return the survivors, so a long
// endpoint outage cannot grow the queue without bound.
function pruneOldQueue(files) {
  const now = Date.now();
  return files.filter(f => {
    const t = enqueueTime(f);
    if (t !== null && now - t > MAX_QUEUE_AGE_MS) {
      try {
        fs.rmSync(f);
      } catch {}
      return false;
    }
    return true;
  });
}

// --- Lock ---

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(lockFile = LOCK_FILE) {
  // Two attempts: first the normal wx, then once more after taking over a stale lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // wx is atomic create-if-absent — the canonical acquire.
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      let pid;
      try {
        pid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10);
      } catch {
        continue; // Lock vanished between wx-fail and read — retry
      }
      // A live holder with a valid PID owns the lock — back off.
      if (pid && isProcessAlive(pid)) {
        return false;
      }
      // Stale/stealable: a dead PID, or NaN (a writer killed between O_CREAT|O_EXCL and
      // writing its PID — `wx` creates the file before the PID is written; a living holder
      // always writes a numeric PID). Takeover must be atomic: move the stale lock aside
      // with rename (atomic), so exactly one concurrent stealer wins and the rest get
      // ENOENT and retry the wx.
      const aside = `${lockFile}.steal.${process.pid}`;
      try {
        fs.renameSync(lockFile, aside);
      } catch {
        continue; // another stealer moved/replaced it first — retry the wx
      }
      // A faster stealer could have written its own live lock between our read and our
      // rename. Verify; if we displaced a live holder, restore it with link and back off.
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
      // Confirmed stale — discard it and retry the wx.
      try {
        fs.rmSync(aside);
      } catch {}
    }
  }
  return false;
}

function releaseLock(lockFile = LOCK_FILE) {
  try {
    fs.rmSync(lockFile);
  } catch {}
}

// --- HTTP ---

// The timer must stay armed across the body read, not just the headers: a captive portal
// / proxy can send headers and then stall the body indefinitely. Callers that need the
// body pass a `readBody` reader (res => res.json() / res.text()); it runs while the same
// AbortController is still live, so a stalled body trips the timeout and aborts instead of
// hanging. Returns { res, body } on success, or null on any error/timeout/abort.
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

// --- Usage extraction ---

// Idempotency key for the backend: a finalized assistant message is identified by its
// session, message id and model. Stable across retransmissions of the same entry.
function entryId(sessionId, messageId, model) {
  return crypto.createHash('sha1')
    .update(`${sessionId}|${messageId}|${model}`)
    .digest('hex');
}

// Build one queue entry from a finalized assistant message. opencode reports tokens and a
// precomputed USD cost per message; each message has exactly one model, so no per-model
// split is needed within a message (a multi-step turn produces several messages, each
// captured on its own).
function buildEntry(m) {
  const t = m.tokens ?? {};
  const cache = t.cache ?? {};
  const completed = m.time?.completed;
  return {
    entry_id: entryId(m.sessionID, m.id, m.modelID),
    timestamp: new Date(completed ?? Date.now()).toISOString(),
    plugin_version: pluginVersion,
    session_id: m.sessionID,
    model: m.modelID,
    provider: m.providerID,
    usage: {
      input_tokens: t.input ?? 0,
      output_tokens: t.output ?? 0,
      reasoning_tokens: t.reasoning ?? 0,
      cache_read_tokens: cache.read ?? 0,
      cache_write_tokens: cache.write ?? 0,
    },
    // opencode's own per-message cost (USD). The backend stays authoritative for pricing
    // (it recomputes from the raw tokens above); this is sent as a cross-check.
    cost: m.cost ?? 0,
  };
}

// Queue a finalized assistant message exactly once. Returns true when an entry was
// written, false when the message is not capturable yet (still streaming, not an
// assistant message) or was already captured in this process.
function captureMessage(m) {
  if (!m || m.role !== 'assistant') {
    return false;
  }
  // time.completed is set only on the final update; until then the token totals are not
  // authoritative. Capture once, on the first sighting of the completed message.
  const completed = m.time?.completed;
  if (completed === undefined || completed === null) {
    return false;
  }
  if (seen.has(m.id)) {
    return false;
  }
  seen.add(m.id);
  writeEntry(buildEntry(m));
  return true;
}

// --- Flush ---

// A 2xx status alone does not prove delivery: off-VPN, a captive portal/proxy can answer a
// POST with its own 200 HTML page, or a redirect to one (res.redirected). Accept only a 2xx
// that was not redirected and does not carry an HTML body as proof (see ADR-005).
function isIngestSuccess(res) {
  if (!res || !res.ok || res.redirected) {
    return false;
  }
  const contentType = res.headers?.get?.('content-type') ?? '';
  return !contentType.includes('text/html');
}

// Only a genuine content rejection (400/422) is permanent; everything else stays queued.
// Defaulting to retryable means a transient 4xx never silently dead-letters real data (see
// ADR-005); the trade-off is a genuinely wrong apiBaseUrl grows the queue instead.
function isRetryable(res) {
  if (!res) {
    return true;
  }
  if (res.ok || res.redirected) {
    return true; // 2xx-but-not-genuine (captive portal) or a followed redirect
  }
  return ![400, 422].includes(res.status);
}

// Move a rejected batch out of the live queue into dead-letter/ so it stops being retried
// (and stops blocking the batches behind it) while preserving the data for inspection.
function deadLetter(batch) {
  fs.mkdirSync(DEAD_LETTER_DIR, { recursive: true });
  for (const f of batch) {
    try {
      fs.renameSync(f, path.join(DEAD_LETTER_DIR, path.basename(f)));
    } catch {
      try {
        fs.rmSync(f);
      } catch {}
    }
  }
}

// Deliver one batch: remove files on genuine success, leave them queued and return false on
// a transient failure, or bisect and retry each half on a permanent rejection so one poison
// entry can't drag its neighbours into dead-letter (see ADR-005).
async function deliverBatch(batch, userId, ingestUrl) {
  const batchVersion = batch.length > 0 ? batch[0].entry.plugin_version : 'unknown';
  const res = await fetchWithTimeout(ingestUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, plugin_version: batchVersion, prompts: batch.map(b => b.entry) }),
  });

  if (isIngestSuccess(res)) {
    batch.forEach(b => {
      try {
        fs.rmSync(b.file);
      } catch {}
    });
    return true;
  }

  if (isRetryable(res)) {
    logError('flush', `${res ? `HTTP ${res.status}` : 'network error'} — ${batch.length} entries remain in queue`);
    return false;
  }

  // Permanent client error (400/422). Bisect to isolate a single poison entry.
  if (batch.length === 1) {
    deadLetter(batch.map(b => b.file));
    logError('flush', `HTTP ${res.status} — quarantined 1 entry to dead-letter`);
    return true;
  }
  const mid = Math.floor(batch.length / 2);
  // A transient failure in the first half (false) stops the flush before the second is
  // even attempted, so its files stay queued for the next run — no data lost.
  return (await deliverBatch(batch.slice(0, mid), userId, ingestUrl))
    && deliverBatch(batch.slice(mid), userId, ingestUrl);
}

async function flush() {
  if (getQueueFiles().length === 0) {
    return;
  }

  // The ingest API base URL is deployment-specific with no sane default: required at
  // install time (--api-base-url <url>) and stored in config.json. Without it we cannot
  // know where to send, so we refuse and leave the queue intact rather than
  // guessing/dropping data.
  const apiBaseUrl = loadConfig().apiBaseUrl;
  if (!apiBaseUrl) {
    logError('flush', 'no apiBaseUrl configured in config.json — reinstall with --api-base-url <url>');
    return;
  }
  const ingestUrl = rawUrl(apiBaseUrl, INGEST_PATH);

  if (!acquireLock()) {
    return;
  }

  try {
    const files = pruneOldQueue(getQueueFiles());
    // Pair each file with its parsed entry. A file that won't parse is local corruption
    // (writeEntry is atomic, so never a half-written file) — drop it outright.
    const items = [];
    for (const f of files) {
      let entry;
      try {
        entry = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        try {
          fs.rmSync(f);
        } catch {}
        continue;
      }
      items.push({ file: f, entry });
    }
    if (items.length === 0) {
      return;
    }

    const userId = getUserId();
    for (let i = 0; i < items.length; i += FLUSH_BATCH_SIZE) {
      const batch = items.slice(i, i + FLUSH_BATCH_SIZE);
      if (!(await deliverBatch(batch, userId, ingestUrl))) {
        return; // transient failure — leave this batch and everything after it queued
      }
    }
  } finally {
    releaseLock();
  }
}

// Coalesce the burst of session.idle events into a single flush so we don't POST on every
// idle. The timer is unref'd so a pending flush never keeps opencode alive on its own.
function scheduleFlush() {
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(err => logError('flush', err));
  }, FLUSH_DEBOUNCE_MS);
  flushTimer.unref?.();
}

// --- Startup status toast (session.created) ---

// error.log is only ever appended to by logError(), so its mtime is the last error time —
// no need to parse content.
function hasRecentError(now) {
  try {
    return (now - fs.statSync(LOG_PATH).mtimeMs) < ERROR_RECENCY_MS;
  } catch {
    return false;
  }
}

function getQueueStatus(now) {
  const files = getQueueFiles();
  if (files.length === 0) {
    return { count: 0, oldestAgeMs: 0 };
  }
  let oldest = now;
  for (const f of files) {
    const t = enqueueTime(f);
    if (t !== null && t < oldest) {
      oldest = t;
    }
  }
  return { count: files.length, oldestAgeMs: now - oldest };
}

function formatAge(ms) {
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) {
    return `${days}d`;
  }
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) {
    return `${hours}h`;
  }
  const minutes = Math.floor(ms / (60 * 1000));
  return `${Math.max(minutes, 1)}m`;
}

// Classifies current sync health so a stuck queue (endpoint down across several sessions)
// or an actively-failing send stands out from a normal, harmlessly-brief backlog.
function computeSyncStatus(now) {
  const queue = getQueueStatus(now);
  if ((hasRecentError(now) && queue.count > 0) || queue.oldestAgeMs > STALE_QUEUE_MS) {
    const suffix = queue.count > 0 ? `${queue.count} queued, oldest ${formatAge(queue.oldestAgeMs)}` : 'error sending';
    return { variant: 'error', text: suffix };
  }
  if (queue.count > 0) {
    return { variant: 'warning', text: `${queue.count} queued` };
  }
  return { variant: 'success', text: 'synced' };
}

function buildStartupStatusMessage(now) {
  const config = loadConfig();
  const sync = computeSyncStatus(now);
  const lastChecked = config.lastUpdateCheck ? `${formatAge(now - new Date(config.lastUpdateCheck).getTime())} ago` : 'never';
  return {
    variant: sync.variant,
    message: `v${pluginVersion} · ${sync.text} · last checked ${lastChecked}`,
  };
}

// Best-effort, once per session start. Never throws — a toast failure must not affect
// capture/flush, which is why every call site wraps this in .catch(logError).
async function postStartupStatus(client) {
  if (!client?.tui?.showToast) {
    return;
  }
  const { variant, message } = buildStartupStatusMessage(Date.now());
  await client.tui.showToast({ body: { title: 'tokendashboard-plugin', message, variant } });
}

// --- Self-update loader (in-process, background; the permanently-frozen update surface) ---

// The update/lifecycle logic lives in updater.js, fetched fresh from the repo on each
// throttled check and executed in-process (no subprocess, nothing written to disk) — a bug
// in it self-heals on the next start; only this tiny loader can never be auto-fixed, so keep
// it minimal (see ADR-010).
//
// Bun (opencode's runtime) fails a data: URL import above ~4 KB (resolves it as a filesystem
// path → ENAMETOOLONG); updater.js exceeds that. Bun supports blob: URL imports at any size.
// Node is the reverse: no blob: support, but data: at any size. Choose by CAPABILITY, not a
// runtime-name check (`typeof Bun`) — opencode may not expose that global. Probe blob-import
// support ONCE with a throwaway module, cache it, then import the real module ONCE via the
// chosen scheme — never try-blob-then-fallback on the real module, which could evaluate
// converge() twice.
let blobImportSupported = null;
async function canImportBlobUrl() {
  if (blobImportSupported !== null) {
    return blobImportSupported;
  }
  blobImportSupported = false;
  try {
    if (typeof Blob === 'function' && typeof URL.createObjectURL === 'function') {
      const probe = URL.createObjectURL(new Blob(['export default 0;'], { type: 'text/javascript' }));
      try {
        await import(probe);
        blobImportSupported = true;
      } finally {
        URL.revokeObjectURL(probe);
      }
    }
  } catch {
    blobImportSupported = false;
  }
  return blobImportSupported;
}

async function importModuleSource(src) {
  if (await canImportBlobUrl()) {
    const objUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    try {
      return await import(objUrl);
    } finally {
      URL.revokeObjectURL(objUrl);
    }
  }
  return import(`data:text/javascript;base64,${Buffer.from(src, 'utf8').toString('base64')}`);
}

async function runFetchedUpdate() {
  const rawBase = loadConfig().repoRawBaseUrl;
  if (!rawBase) {
    return; // no update source configured — never touch anything
  }
  const fetched = await fetchWithTimeout(
    rawUrl(rawBase, 'updater.js'), {}, 10000, r => r.text());
  // No response, an error status, or a followed redirect (captive portal / proxy) — no-op.
  if (!fetched?.res?.ok || fetched.res.redirected) {
    return;
  }
  let src = fetched.body;
  if (!src || src.trimStart().startsWith('<')) {
    return; // empty body or an HTML error/login page
  }
  // Strip a leading shebang (present because updater.js is also the npx bin entry).
  src = src.replace(/^#![^\n]*\n/, '');
  // Positive proof of a genuine updater payload. FROZEN marker shared with updater.js's
  // converge export (see ADR-010) — do not change its export form.
  if (!src.includes('export async function converge')) {
    return;
  }
  // A malformed payload makes import() throw; the caller's .catch turns that into a safe
  // no-op. converge() re-checks install state and does all writes atomically.
  const mod = await importModuleSource(src);
  await mod.converge();
}

// Throttle the update check to once per 24h. Only self-updates when installed (config
// .currentVersion present); running the source directly in dev never self-updates.
async function maybeUpdate() {
  const config = loadConfig();
  if (!config.currentVersion) {
    return;
  }
  const lastCheck = config.lastUpdateCheck ? new Date(config.lastUpdateCheck) : null;
  if (lastCheck && (Date.now() - lastCheck.getTime()) < UPDATE_INTERVAL_MS) {
    return;
  }
  await runFetchedUpdate();
}

// --- Plugin factory (the single export; see file header) ---

// FROZEN marker: the deployed predecessor's self-update requires the literal
// `export const TokenUsagePlugin` before overwriting the installed file. Do not
// rename/reshape this export (see ADR-010).
export const TokenUsagePlugin = async ({ client } = {}) => {
  // Initialize version at factory startup (once per process lifetime)
  pluginVersion = getPluginVersion();

  // Both run in the background so plugin load never blocks opencode startup:
  //  - flush(): drain any queue a previous crashed/offline run left behind.
  //  - maybeUpdate(): roll out a newer plugin version (throttled to once/24h).
  flush().catch(err => logError('init-flush', err));
  maybeUpdate().catch(err => logError('init-update', err));

  return {
    // The event hook is fire-and-forget (opencode does not await it), so capture must be
    // synchronous and atomic — writeEntry is. Flush is async but safe: entries are removed
    // only on a genuine 2xx, so a flush cut off by process exit loses nothing.
    event: async ({ event }) => {
      try {
        if (event?.type === 'message.updated') {
          captureMessage(event.properties?.info);
        } else if (event?.type === 'session.idle') {
          scheduleFlush();
        } else if (event?.type === 'session.created') {
          postStartupStatus(client).catch(err => logError('status-toast', err));
        }
      } catch (err) {
        logError('event', err);
      }
    },
    // Best-effort final flush on a clean teardown. Not guaranteed on SIGKILL — the
    // next start's init flush is the backstop.
    dispose: async () => {
      try {
        await flush();
      } catch (err) {
        logError('dispose-flush', err);
      }
    },
  };
};

// Internals exposed for unit tests only. They are attached to the factory rather than
// exported separately because opencode's loader invokes every module export as a plugin
// factory (see docs/decisions/008); a property on the factory is invisible to that loader.
TokenUsagePlugin.__internal = {
  atomicWriteSync,
  getUserId,
  getPluginVersion,
  loadConfig,
  saveConfig,
  writeEntry,
  getQueueFiles,
  enqueueTime,
  pruneOldQueue,
  isProcessAlive,
  acquireLock,
  releaseLock,
  entryId,
  buildEntry,
  captureMessage,
  isIngestSuccess,
  isRetryable,
  deadLetter,
  deliverBatch,
  flush,
  runFetchedUpdate,
  maybeUpdate,
  rawUrl,
  seen,
  hasRecentError,
  getQueueStatus,
  formatAge,
  computeSyncStatus,
  buildStartupStatusMessage,
  postStartupStatus,
  paths: {
    INSTALLED_PLUGIN_PATH, PLUGIN_DIR, QUEUE_DIR, DEAD_LETTER_DIR,
    LOCK_FILE, USER_ID_PATH, CONFIG_PATH, LOG_PATH,
  },
  constants: {
    FLUSH_BATCH_SIZE, MAX_QUEUE_AGE_MS, UPDATE_INTERVAL_MS, STALE_QUEUE_MS, ERROR_RECENCY_MS,
  },
};

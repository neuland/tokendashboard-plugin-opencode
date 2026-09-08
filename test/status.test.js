import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inSandbox, stubFetch, makeResponse } from './helpers.js';

// --- computeSyncStatus ---

test('computeSyncStatus reports synced when the queue is empty', async () => {
  await inSandbox(async (hook) => {
    // given, when
    const status = hook.computeSyncStatus(Date.now());
    // then
    assert.deepEqual(status, { variant: 'success', text: 'synced' });
  });
});

test('computeSyncStatus reports queued (warning) for a small, recent backlog', async () => {
  await inSandbox(async (hook) => {
    // given one freshly-queued entry
    hook.writeEntry({ entry_id: 'a', model: 'm' });

    // when
    const status = hook.computeSyncStatus(Date.now());

    // then
    assert.equal(status.variant, 'warning');
    assert.equal(status.text, '1 queued');
  });
});

test('computeSyncStatus escalates to error once the oldest entry is stale', async () => {
  await inSandbox(async (hook) => {
    // given a queue file whose name encodes an enqueue time far in the past
    fs.mkdirSync(hook.paths.QUEUE_DIR, { recursive: true });
    const staleName = `${Date.now() - hook.constants.STALE_QUEUE_MS - 1000}-1-0.json`;
    fs.writeFileSync(path.join(hook.paths.QUEUE_DIR, staleName), JSON.stringify({ entry_id: 'a' }));

    // when
    const status = hook.computeSyncStatus(Date.now());

    // then
    assert.equal(status.variant, 'error');
    assert.match(status.text, /1 queued, oldest/);
  });
});

test('computeSyncStatus escalates to error when a recent error.log write coincides with a queued entry', async () => {
  await inSandbox(async (hook) => {
    // given a queued entry and an error logged just now
    hook.writeEntry({ entry_id: 'a', model: 'm' });
    fs.mkdirSync(hook.paths.PLUGIN_DIR, { recursive: true });
    fs.writeFileSync(hook.paths.LOG_PATH, 'boom\n');

    // when
    const status = hook.computeSyncStatus(Date.now());

    // then
    assert.equal(status.variant, 'error');
  });
});

// --- buildStartupStatusMessage ---

test('buildStartupStatusMessage reports "never" when no update check has run yet', async () => {
  await inSandbox(async (hook, home, Plugin) => {
    // given the factory has initialized pluginVersion but no config.lastUpdateCheck exists
    await Plugin();

    // when
    const { message } = hook.buildStartupStatusMessage(Date.now());

    // then
    assert.match(message, /synced/);
    assert.match(message, /last checked never/);
  });
});

test('buildStartupStatusMessage includes the age of the last update check', async () => {
  await inSandbox(async (hook, home, Plugin) => {
    // given a check that ran 3 hours ago
    hook.saveConfig({ lastUpdateCheck: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });
    await Plugin();

    // when
    const { message } = hook.buildStartupStatusMessage(Date.now());

    // then
    assert.match(message, /last checked 3h ago/);
  });
});

// --- postStartupStatus ---

test('postStartupStatus shows a toast via client.tui.showToast', async () => {
  await inSandbox(async (hook, home, Plugin) => {
    await Plugin();
    const calls = [];
    const client = { tui: { showToast: async args => calls.push(args) } };

    // when
    await hook.postStartupStatus(client);

    // then
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.title, 'tokendashboard-plugin');
    assert.equal(calls[0].body.variant, 'success');
    assert.match(calls[0].body.message, /synced/);
  });
});

test('postStartupStatus is a no-op when the client has no tui.showToast (never throws)', async () => {
  await inSandbox(async (hook, home, Plugin) => {
    await Plugin();
    // when, then (no throw)
    await hook.postStartupStatus(undefined);
    await hook.postStartupStatus({});
  });
});

test('a session.created event posts the startup status toast when a client is provided', async () => {
  await inSandbox(async (hook, home, Plugin) => {
    const stub = stubFetch(() => makeResponse({ status: 200, json: { ok: true } }));
    const calls = [];
    const client = { tui: { showToast: async args => calls.push(args) } };
    const hooks = await Plugin({ client });

    // when
    await hooks.event({ event: { type: 'session.created', properties: {} } });

    // then
    stub.restore();
    assert.equal(calls.length, 1);
  });
});

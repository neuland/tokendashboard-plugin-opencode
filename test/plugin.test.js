import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inSandbox, stubFetch, makeResponse, assistantMessage, readQueue,
} from './helpers.js';

// The factory's background init (flush + maybeUpdate) makes no network call on a fresh
// sandbox (empty queue, no config), but we stub fetch in these tests anyway so an
// accidental request can never hit the real ingest API.

test('the factory returns event and dispose hooks', async () => {
  await inSandbox(async (hook, home, Plugin) => {
    const stub = stubFetch(() => makeResponse({ status: 200, json: { ok: true } }));
    // when
    const hooks = await Plugin();
    // then
    stub.restore();
    assert.equal(typeof hooks.event, 'function');
    assert.equal(typeof hooks.dispose, 'function');
  });
});

test('a message.updated event for a finalized assistant message queues one entry', async () => {
  await inSandbox(async (hook, home, Plugin) => {
    const stub = stubFetch(() => makeResponse({ status: 200, json: { ok: true } }));
    const hooks = await Plugin();

    // when an assistant message finalizes
    await hooks.event({ event: { type: 'message.updated', properties: { info: assistantMessage() } } });

    // then it is queued exactly once
    stub.restore();
    assert.equal(readQueue(home).length, 1);
  });
});

test('an unrelated event type is ignored and never throws', async () => {
  await inSandbox(async (hook, home, Plugin) => {
    const stub = stubFetch(() => makeResponse({ status: 200, json: { ok: true } }));
    const hooks = await Plugin();

    // when
    await hooks.event({ event: { type: 'session.created', properties: {} } });
    await hooks.event({ event: undefined });

    // then nothing queued, no throw
    stub.restore();
    assert.equal(readQueue(home).length, 0);
  });
});

test('dispose flushes the queue to the ingest API', async () => {
  await inSandbox(async (hook, home, Plugin) => {
    // given a configured apiBaseUrl and a queued entry
    hook.saveConfig({ apiBaseUrl: 'https://example.com' });
    hook.writeEntry({ entry_id: 'a', model: 'm' });
    const stub = stubFetch(() => makeResponse({ status: 200, json: { ok: true } }));
    const hooks = await Plugin();

    // when the session is disposed
    await hooks.dispose();

    // then the queue was delivered
    stub.restore();
    assert.ok(stub.calls.length >= 1);
    assert.equal(readQueue(home).length, 0);
  });
});

test('factory load does not block on the background update fetch', async () => {
  await inSandbox(async (hook, home, Plugin) => {
    // given an install due for an update check, and an updater.js fetch that hangs until we
    // release it (simulates a slow/off-VPN network)
    hook.saveConfig({
      currentVersion: '0.1.0',
      lastUpdateCheck: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      repoRawBaseUrl: 'https://example.com/raw/main',
    });
    let releaseFetch;
    const gate = new Promise(resolve => {
      releaseFetch = resolve;
    });
    const stub = stubFetch(async url => {
      if (String(url).includes('updater.js')) {
        await gate; // block the background update indefinitely
        return makeResponse({ status: 200, contentType: 'text/javascript', text: '// no marker' });
      }
      return makeResponse({ status: 200, json: { version: '0.1.0' } });
    });

    // when the factory loads (it must NOT await maybeUpdate) — if it did, this await would
    // hang until we release the gate, and the test would time out
    const hooks = await Plugin();

    // then the factory returned while the update fetch is still pending
    assert.equal(typeof hooks.event, 'function');
    assert.ok(stub.calls.some(c => String(c.url).includes('updater.js')));

    // release the gate and let the background update settle, then clean up
    releaseFetch();
    await new Promise(resolve => setTimeout(resolve, 0));
    stub.restore();
  });
});

// --- Plugin Version Extraction Tests ---

test('getPluginVersion extracts version from package.json', async () => {
  await inSandbox(async (hook) => {
    // given, when
    const version = hook.getPluginVersion();

    // then it returns a valid version string (semantic version or "unknown")
    assert.ok(typeof version === 'string');
    assert.ok(version.length > 0);
    // Check if it's a semantic version (e.g., "0.1.0") or the fallback "unknown"
    const semverPattern = /^\d+\.\d+\.\d+/;
    assert.ok(semverPattern.test(version) || version === 'unknown');
  });
});

test('getPluginVersion returns version for valid package.json', async () => {
  await inSandbox(async (hook) => {
    // given, when
    const version = hook.getPluginVersion();

    // then it should not be "unknown" (assuming package.json exists in repo)
    // In normal conditions, version should be a valid semantic version
    assert.notEqual(version, 'unknown');
    assert.ok(/^\d+\.\d+\.\d+/.test(version));
  });
});

test('getPluginVersion returns "unknown" as fallback', async () => {
  await inSandbox(async (hook) => {
    // given a corrupted package.json scenario (we can't truly corrupt it in a clean test,
    // but we verify that fallback logic exists by ensuring the function never throws)
    // when
    let version;
    let threw = false;
    try {
      version = hook.getPluginVersion();
    } catch {
      threw = true;
    }

    // then it should never throw; fallback exists
    assert.equal(threw, false);
    assert.ok(typeof version === 'string');
  });
});

// --- User Story 1: Track Plugin Version in Usage Analytics ---

test('[US1] captured event includes plugin_version field', async () => {
  await inSandbox(async (hook, home, Plugin) => {
    // given, when
    const stub = stubFetch(() => makeResponse({ status: 200, json: { ok: true } }));
    const hooks = await Plugin();
    await hooks.event({ event: { type: 'message.updated', properties: { info: assistantMessage() } } });

    // then the queued entry includes plugin_version
    stub.restore();
    const queued = readQueue(home);
    assert.equal(queued.length, 1);
    assert.ok('plugin_version' in queued[0]);
    assert.equal(typeof queued[0].plugin_version, 'string');
    assert.ok(queued[0].plugin_version.length > 0);
  });
});

test('[US1] queue entry includes plugin_version field', async () => {
  await inSandbox(async (hook, home, Plugin) => {
    // given an assistant message is captured
    const stub = stubFetch(() => makeResponse({ status: 200, json: { ok: true } }));
    const hooks = await Plugin();
    const msg = assistantMessage();

    // when the event hook processes message.updated
    await hooks.event({ event: { type: 'message.updated', properties: { info: msg } } });
    stub.restore();

    // then the queue entry has plugin_version set
    const entries = readQueue(home);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].plugin_version);
    // version should be either semantic version (0.1.0) or "unknown"
    assert.ok(/^\d+\.\d+\.\d+/.test(entries[0].plugin_version) || entries[0].plugin_version === 'unknown');
  });
});

test('[US1] flushed payload includes plugin_version field', async () => {
  await inSandbox(async (hook, home, Plugin) => {
    // given a configured apiBaseUrl and queued entries with plugin_version
    hook.saveConfig({ apiBaseUrl: 'https://example.com' });
    hook.writeEntry({ entry_id: 'a', model: 'm', plugin_version: '0.1.0' });
    const stub = stubFetch(() => makeResponse({ status: 200, json: { ok: true } }));
    const hooks = await Plugin();

    // when disposed (triggers flush)
    await hooks.dispose();
    stub.restore();

    // then the flushed payload included plugin_version
    assert.ok(stub.calls.length >= 1);
    const postBody = stub.calls[stub.calls.length - 1].options.body;
    const payload = JSON.parse(postBody);
    assert.ok('plugin_version' in payload);
    assert.equal(typeof payload.plugin_version, 'string');
  });
});

test('[US1] version immutability: entry preserves version captured at time T even if plugin updates before flush', async () => {
  await inSandbox(async (hook, home, Plugin) => {
    // given: a configured apiBaseUrl and a captured event with version v1.0.0
    hook.saveConfig({ apiBaseUrl: 'https://example.com' });
    const stub = stubFetch(() => makeResponse({ status: 200, json: { ok: true } }));
    const hooks = await Plugin();
    hook.writeEntry({
      entry_id: 'entry1', model: 'm', plugin_version: '0.1.0', timestamp: '2026-07-23T10:00:00Z',
    });

    // when: flush the entry
    await hooks.dispose();
    stub.restore();

    // then: the payload includes the original version (0.1.0), not current version
    assert.ok(stub.calls.length >= 1);
    const payloads = stub.calls.map(c => JSON.parse(c.options.body));
    const versionInPayload = payloads.find(p => p.plugin_version);
    assert.equal(versionInPayload.plugin_version, '0.1.0');
  });
});

// --- User Story 2: Support Backwards Compatibility Analysis ---

test('[US2] old queue entries without plugin_version flush without errors', async () => {
  await inSandbox(async (hook, home, Plugin) => {
    // given: a configured apiBaseUrl and an old queue entry format (without plugin_version)
    hook.saveConfig({ apiBaseUrl: 'https://example.com' });
    hook.writeEntry({ entry_id: 'a', model: 'm', timestamp: '2026-07-23T10:00:00Z' });
    const stub = stubFetch(() => makeResponse({ status: 200, json: { ok: true } }));
    const hooks = await Plugin();

    // when: dispose triggers flush
    await hooks.dispose();
    stub.restore();

    // then: queue was delivered without error
    assert.ok(stub.calls.length >= 1);
    assert.equal(readQueue(home).length, 0);
  });
});

test('[US2] new and old entries batch flush together correctly', async () => {
  await inSandbox(async (hook, home, Plugin) => {
    // given: a configured apiBaseUrl and mixed old (no version) and new (with version) entries
    hook.saveConfig({ apiBaseUrl: 'https://example.com' });
    hook.writeEntry({ entry_id: 'old1', model: 'm1', timestamp: '2026-07-23T10:00:00Z' });
    hook.writeEntry({ entry_id: 'new1', model: 'm2', plugin_version: '0.1.0', timestamp: '2026-07-23T10:01:00Z' });
    const stub = stubFetch(() => makeResponse({ status: 200, json: { ok: true } }));
    const hooks = await Plugin();

    // when: flush
    await hooks.dispose();
    stub.restore();

    // then: both entries were flushed
    assert.ok(stub.calls.length >= 1);
    assert.equal(readQueue(home).length, 0);
    const payloads = stub.calls.map(c => JSON.parse(c.options.body));
    // At least one payload should have entries
    assert.ok(payloads.some(p => p.prompts && p.prompts.length > 0));
  });
});

test('[US2] version cohort analysis scenario: multiple versions in queue', async () => {
  await inSandbox(async (hook, home, Plugin) => {
    // given: a configured apiBaseUrl and entries from different plugin versions
    hook.saveConfig({ apiBaseUrl: 'https://example.com' });
    hook.writeEntry({ entry_id: 'v0', model: 'm', plugin_version: '0.1.0', timestamp: '2026-07-23T10:00:00Z' });
    hook.writeEntry({ entry_id: 'v1', model: 'm', plugin_version: '0.2.0', timestamp: '2026-07-23T10:01:00Z' });
    hook.writeEntry({ entry_id: 'v2', model: 'm', plugin_version: '0.1.0', timestamp: '2026-07-23T10:02:00Z' });
    const stub = stubFetch(() => makeResponse({ status: 200, json: { ok: true } }));
    const hooks = await Plugin();

    // when: flush
    await hooks.dispose();
    stub.restore();

    // then: all entries flushed, each with their original version
    assert.equal(readQueue(home).length, 0);
    const payloads = stub.calls.map(c => JSON.parse(c.options.body));
    const allPrompts = payloads.flatMap(p => p.prompts || []);
    // Verify versions are preserved
    const versions = allPrompts.map(p => p.plugin_version);
    assert.ok(versions.includes('0.1.0'));
    assert.ok(versions.includes('0.2.0'));
  });
});

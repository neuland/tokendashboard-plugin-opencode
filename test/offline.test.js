import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  inSandbox, stubFetch, makeResponse, installedPluginPath,
  assistantMessage, readQueue,
} from './helpers.js';

test('with the update source unreachable, capture still queues and a later flush delivers', async () => {
  await inSandbox(async (plugin, home) => {
    // given an install with a configured apiBaseUrl and a network where EVERY request fails (VPN off)
    plugin.saveConfig({
      currentVersion: '0.1.0',
      apiBaseUrl: 'https://example.com',
      repoRawBaseUrl: 'https://example.com/raw/main',
    });
    let stub = stubFetch(() => {
      throw new Error('network down');
    });

    // when the background update runs and a message is captured while offline
    await plugin.runFetchedUpdate();
    const captured = plugin.captureMessage(assistantMessage());

    // then the update is a no-op (installed file untouched) but capture wrote a queue entry
    assert.equal(captured, true);
    assert.equal(fs.existsSync(installedPluginPath(home)), false);
    assert.equal(readQueue(home).length, 1);

    // a flush while still offline changes nothing (entry stays queued)
    await plugin.flush();
    assert.equal(readQueue(home).length, 1);
    stub.restore();

    // when the ingest API becomes reachable and we flush again
    stub = stubFetch(() => makeResponse({ status: 200 }));
    await plugin.flush();
    stub.restore();

    // then the queued entry is delivered and removed
    assert.equal(readQueue(home).length, 0);
  });
});

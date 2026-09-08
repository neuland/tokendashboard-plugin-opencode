import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inUpdaterSandbox, stubFetch, makeResponse, installedPluginPath } from './helpers.js';

const VALID_PAYLOAD = '// plugin\nexport const TokenUsagePlugin = async () => ({});\n';

function updateStub(remoteVersion) {
  return stubFetch(url => {
    if (String(url).includes('package.json')) {
      return makeResponse({ status: 200, json: { version: remoteVersion } });
    }
    return makeResponse({ status: 200, text: VALID_PAYLOAD });
  });
}

test('two concurrent converge runs: exactly one acquires the lock and writes, the other no-ops', async () => {
  await inUpdaterSandbox(async (updater, home) => {
    // given an install and a newer remote
    updater.__internal.saveConfig({
      currentVersion: '0.1.0', repoRawBaseUrl: 'https://example.com/raw/main',
    });
    const fetchStub = updateStub('0.2.0');

    // when two converge runs are started concurrently (the first grabs the lock synchronously
    // before its first await; the second sees a live holder and backs off)
    await Promise.all([updater.converge(), updater.converge()]);

    // then only one run did the work: exactly one pair of fetches (package.json + plugin.js)
    fetchStub.restore();
    assert.equal(fetchStub.calls.length, 2);
    assert.equal(fs.readFileSync(installedPluginPath(home), 'utf8'), VALID_PAYLOAD);
    assert.equal(updater.__internal.loadConfig().currentVersion, '0.2.0');
  });
});

test('a stale update lock (dead owner pid) is stolen on the next acquire', async () => {
  await inUpdaterSandbox(updater => {
    // given a lock file left behind by a dead process
    const { PLUGIN_DIR, UPDATE_LOCK_FILE } = updater.__internal.paths;
    fs.mkdirSync(PLUGIN_DIR, { recursive: true });
    fs.writeFileSync(UPDATE_LOCK_FILE, '999999'); // a pid that is not alive

    // when we try to acquire it
    const got = updater.__internal.acquireUpdateLock();

    // then the stale lock is stolen and we hold it (our own pid is written)
    assert.equal(got, true);
    assert.equal(fs.readFileSync(UPDATE_LOCK_FILE, 'utf8'), String(process.pid));
    updater.__internal.releaseUpdateLock();
  });
});

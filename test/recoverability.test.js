import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  inSandbox, stubFetch, makeResponse, installedPluginPath,
  assistantMessage, readQueue,
} from './helpers.js';

const VALID_PAYLOAD = '// plugin\nexport const TokenUsagePlugin = async () => ({});\n';

// The genuine updater.js source — what the repo would serve at main/updater.js. Reading it
// from disk means the loader exercises the REAL fetch -> base64 import -> converge() chain.
const REAL_UPDATER = fs.readFileSync(new URL('../updater.js', import.meta.url), 'utf8');

// A "broken" release whose fetched update logic can never apply an update: the converge
// marker is renamed, so the loader's marker guard rejects it (the class of bug this feature
// exists to make self-healing).
// replaceAll: the marker phrase appears in a comment too, so a single replace would leave the
// real export intact. Renaming every occurrence makes the loader's marker guard reject it.
const BROKEN_UPDATER = REAL_UPDATER.replaceAll(
  'export async function converge', 'export async function brokenconverge');

// Serve main/updater.js (updaterSrc), main/package.json ({version}), main/plugin.js (payload).
function repoStub(updaterSrc, remoteVersion) {
  return stubFetch(url => {
    const u = String(url);
    if (u.includes('updater.js')) {
      return makeResponse({ status: 200, contentType: 'text/javascript', text: updaterSrc });
    }
    if (u.includes('package.json')) {
      return makeResponse({ status: 200, json: { version: remoteVersion } });
    }
    return makeResponse({ status: 200, text: VALID_PAYLOAD });
  });
}

// importModuleSource() imports the fetched text via a `data:` URL when blob: import is
// unsupported (the plain-Node path — see ADR-010); Node's dynamic-import cache is keyed by
// the resulting URL, so byte-identical source text imported in two different tests would
// resolve to the SAME cached module instance — including its module-scope path constants
// closed over a now-cleaned-up sandbox $HOME from the earlier test. Each test that actually
// imports updater.js in-process therefore needs source text unique to it (a trailing
// comment suffices) so it gets its own cache entry.
test('runFetchedUpdate is a no-op when repoRawBaseUrl is unconfigured — no fallback default', async () => {
  await inSandbox(async plugin => {
    // given an install with no repoRawBaseUrl configured
    plugin.saveConfig({ currentVersion: '0.1.0' });
    const stub = repoStub(`${REAL_UPDATER}\n// test-marker: no-base-url\n`, '0.1.0');

    // when
    await plugin.runFetchedUpdate();
    stub.restore();

    // then nothing is fetched — there is no built-in update source to fall back to
    assert.equal(stub.calls.length, 0);
  });
});

test('runFetchedUpdate fetches updater.js from config.repoRawBaseUrl when configured', async () => {
  await inSandbox(async plugin => {
    // given an install with a configured custom raw base URL
    const customBase = 'https://github.example.com/org/repo/raw/main';
    plugin.saveConfig({ currentVersion: '0.1.0', repoRawBaseUrl: customBase });
    const stub = repoStub(`${REAL_UPDATER}\n// test-marker: custom-base-url\n`, '0.1.0');

    // when
    await plugin.runFetchedUpdate();
    stub.restore();

    // then the updater.js fetch went to the custom base, not the default
    const updaterCall = stub.calls.find(c => String(c.url).includes('updater.js'));
    assert.ok(updaterCall);
    assert.ok(String(updaterCall.url).startsWith(customBase));
  });
});

test('a broken fetched updater is a safe no-op; a corrected release then heals with no reinstall', async () => {
  await inSandbox(async (plugin, home) => {
    // given an install on 0.1.0
    plugin.saveConfig({ currentVersion: '0.1.0', repoRawBaseUrl: 'https://example.com/raw/main' });

    // when the fetched update logic is broken (marker renamed) and a newer version exists
    let stub = repoStub(BROKEN_UPDATER, '0.2.0');
    await plugin.runFetchedUpdate();
    stub.restore();

    // then nothing is applied and telemetry capture is unaffected
    assert.equal(fs.existsSync(installedPluginPath(home)), false);
    assert.equal(plugin.loadConfig().currentVersion, '0.1.0');
    assert.equal(plugin.captureMessage(assistantMessage()), true);
    assert.equal(readQueue(home).length, 1);

    // when a corrected updater is published (same higher version)
    stub = repoStub(REAL_UPDATER, '0.2.0');
    await plugin.runFetchedUpdate();
    stub.restore();

    // then the install heals itself: plugin overwritten and version bumped, zero reinstall
    assert.equal(fs.readFileSync(installedPluginPath(home), 'utf8'), VALID_PAYLOAD);
    assert.equal(plugin.loadConfig().currentVersion, '0.2.0');
  });
});

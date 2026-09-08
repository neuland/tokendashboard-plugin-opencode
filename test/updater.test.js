import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inUpdaterSandbox, stubFetch, makeResponse, installedPluginPath } from './helpers.js';

const VALID_PAYLOAD = '// plugin\nexport const TokenUsagePlugin = async () => ({});\n';

// Stub that serves a package.json version and a plugin.js body, distinguishing the two
// requests by URL. `pluginResponseOpts` lets a test tweak the plugin.js response.
function updateStub(remoteVersion, pluginResponseOpts = { text: VALID_PAYLOAD }) {
  return stubFetch(url => {
    if (String(url).includes('package.json')) {
      return makeResponse({ status: 200, json: { version: remoteVersion } });
    }
    return makeResponse({ status: 200, ...pluginResponseOpts });
  });
}

test('converge installs a newer plugin payload and bumps currentVersion', async () => {
  await inUpdaterSandbox(async (updater, home) => {
    // given an installed 0.1.0 and a newer 0.2.0 published
    updater.__internal.saveConfig({
      currentVersion: '0.1.0', repoRawBaseUrl: 'https://example.com/raw/main',
    });
    const fetchStub = updateStub('0.2.0');

    // when
    await updater.converge();

    // then the installed file is rewritten and the version recorded
    fetchStub.restore();
    assert.equal(fs.readFileSync(installedPluginPath(home), 'utf8'), VALID_PAYLOAD);
    assert.equal(updater.__internal.loadConfig().currentVersion, '0.2.0');
    assert.ok(updater.__internal.loadConfig().lastUpdateCheck);
  });
});

test('converge records the check but does not rewrite when not newer', async () => {
  await inUpdaterSandbox(async (updater, home) => {
    // given the remote version equals the installed one
    updater.__internal.saveConfig({
      currentVersion: '0.2.0', repoRawBaseUrl: 'https://example.com/raw/main',
    });
    const fetchStub = updateStub('0.2.0');

    // when
    await updater.converge();

    // then only package.json was fetched, no file written, but the check is timestamped
    fetchStub.restore();
    assert.equal(fetchStub.calls.length, 1);
    assert.equal(fs.existsSync(installedPluginPath(home)), false);
    assert.ok(updater.__internal.loadConfig().lastUpdateCheck);
  });
});

test('converge refuses a payload missing the export marker (captive-portal HTML)', async () => {
  await inUpdaterSandbox(async (updater, home) => {
    // given a newer version but an HTML body for plugin.js
    updater.__internal.saveConfig({
      currentVersion: '0.1.0', repoRawBaseUrl: 'https://example.com/raw/main',
    });
    const fetchStub = updateStub('0.2.0', { contentType: 'text/html', text: '<html>login</html>' });

    // when
    await updater.converge();

    // then nothing is written and the version is not bumped
    fetchStub.restore();
    assert.equal(fs.existsSync(installedPluginPath(home)), false);
    assert.equal(updater.__internal.loadConfig().currentVersion, '0.1.0');
  });
});

test('converge ignores a redirected plugin.js download', async () => {
  await inUpdaterSandbox(async (updater, home) => {
    // given a newer version but the plugin.js download was redirected
    updater.__internal.saveConfig({
      currentVersion: '0.1.0', repoRawBaseUrl: 'https://example.com/raw/main',
    });
    const fetchStub = updateStub('0.2.0', { redirected: true, text: VALID_PAYLOAD });

    // when
    await updater.converge();

    // then nothing is written
    fetchStub.restore();
    assert.equal(fs.existsSync(installedPluginPath(home)), false);
  });
});

test('converge is a no-op when not installed (no currentVersion) — never hits the network', async () => {
  await inUpdaterSandbox(async updater => {
    // given no config
    const fetchStub = updateStub('9.9.9');

    // when
    await updater.converge();

    // then no request is made
    fetchStub.restore();
    assert.equal(fetchStub.calls.length, 0);
  });
});

test('converge is a no-op when the update source is unreachable', async () => {
  await inUpdaterSandbox(async (updater, home) => {
    // given an install and a network that fails every request
    updater.__internal.saveConfig({
      currentVersion: '0.1.0', repoRawBaseUrl: 'https://example.com/raw/main',
    });
    const fetchStub = stubFetch(() => {
      throw new Error('network down');
    });

    // when
    await updater.converge();

    // then nothing is written and the version is untouched
    fetchStub.restore();
    assert.equal(fs.existsSync(installedPluginPath(home)), false);
    assert.equal(updater.__internal.loadConfig().currentVersion, '0.1.0');
  });
});

test('converge is a no-op when config.repoRawBaseUrl is absent — no fallback default', async () => {
  await inUpdaterSandbox(async (updater, home) => {
    // given an installed 0.1.0 with no repoRawBaseUrl configured and a newer 0.2.0 published
    updater.__internal.saveConfig({ currentVersion: '0.1.0' });
    const fetchStub = updateStub('0.2.0');

    // when
    await updater.converge();

    // then nothing is fetched or written — there is no built-in update source to fall back to
    fetchStub.restore();
    assert.equal(fetchStub.calls.length, 0);
    assert.equal(fs.existsSync(installedPluginPath(home)), false);
  });
});

test('converge fetches from config.repoRawBaseUrl when configured', async () => {
  await inUpdaterSandbox(async updater => {
    // given a configured raw base URL and a newer version published there
    const customBase = 'https://github.example.com/org/repo/raw/main';
    updater.__internal.saveConfig({ currentVersion: '0.1.0', repoRawBaseUrl: customBase });
    const fetchStub = updateStub('0.2.0');

    // when
    await updater.converge();

    // then both fetches went to the configured base
    fetchStub.restore();
    assert.equal(fetchStub.calls.length, 2);
    for (const call of fetchStub.calls) {
      assert.ok(String(call.url).startsWith(customBase));
    }
  });
});

test('converge does not run while the update lock is held', async () => {
  await inUpdaterSandbox(async (updater, home) => {
    // given an install and the update lock already held by a (live) process — this one
    updater.__internal.saveConfig({
      currentVersion: '0.1.0', repoRawBaseUrl: 'https://example.com/raw/main',
    });
    updater.__internal.acquireUpdateLock(); // defaults to UPDATE_LOCK_FILE
    const fetchStub = updateStub('0.2.0');

    // when
    await updater.converge();

    // then it backed off without fetching or writing
    fetchStub.restore();
    updater.__internal.releaseUpdateLock();
    assert.equal(fetchStub.calls.length, 0);
    assert.equal(fs.existsSync(installedPluginPath(home)), false);
  });
});

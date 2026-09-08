import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inUpdaterSandbox, installedPluginPath, configPath, queueDir,
} from './helpers.js';

const UPDATER_URL = new URL('../updater.js', import.meta.url);

test('install copies the plugin into ~/.config/opencode/plugin and writes config', async () => {
  await inUpdaterSandbox((updater, home) => {
    // when
    updater.install();

    // then the plugin file is installed and config carries a semver + check timestamp
    assert.equal(fs.existsSync(installedPluginPath(home)), true);
    const cfg = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    assert.match(cfg.currentVersion, /^\d+\.\d+\.\d+$/);
    assert.ok(cfg.lastUpdateCheck);
  });
});

test('install is idempotent — re-running leaves a single loadable installed file', async () => {
  await inUpdaterSandbox((updater, home) => {
    // when installed twice
    updater.install();
    updater.install();

    // then the plugin file still exists (no duplication/corruption) and stays loadable
    const content = fs.readFileSync(installedPluginPath(home), 'utf8');
    assert.match(content, /export const TokenUsagePlugin/);
  });
});

test('install honors XDG_CONFIG_HOME instead of ~/.config (mirrors opencode discovery)', async () => {
  // given a HOME and a DIFFERENT XDG_CONFIG_HOME, as opencode itself resolves them
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tup-xdg-home-'));
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'tup-xdg-config-'));
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = xdg;
  const origLog = console.log;
  console.log = () => {};
  try {
    // when installing with a fresh module that reads the env above at load
    const updater = await import(`${UPDATER_URL.href}?xdg=${process.pid}`);
    updater.install();

    // then the plugin lands under $XDG_CONFIG_HOME/opencode, not ~/.config/opencode
    assert.equal(
      fs.existsSync(path.join(xdg, 'opencode', 'plugin', 'tokendashboard-plugin.js')), true);
    assert.equal(
      fs.existsSync(path.join(home, '.config', 'opencode', 'plugin', 'tokendashboard-plugin.js')),
      false);
  } finally {
    console.log = origLog;
    process.env.HOME = prev.HOME;
    process.env.USERPROFILE = prev.USERPROFILE;
    if (prev.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(xdg, { recursive: true, force: true });
  }
});

test('uninstall clears currentVersion first, then removes the installed file, keeping the queue', async () => {
  await inUpdaterSandbox((updater, home) => {
    // given an installed plugin and a leftover queued entry
    updater.install();
    assert.equal(fs.existsSync(installedPluginPath(home)), true);
    fs.mkdirSync(queueDir(home), { recursive: true });
    const queued = path.join(queueDir(home), '1-1-0.json');
    fs.writeFileSync(queued, '{}');

    // when
    updater.uninstall();

    // then the plugin file and config are gone (currentVersion cleared) but the queue survives
    assert.equal(fs.existsSync(installedPluginPath(home)), false);
    assert.equal(fs.existsSync(configPath(home)), false);
    assert.equal(fs.existsSync(queued), true);
  });
});

test('run() with an unknown command reports usage and exits non-zero', async () => {
  await inUpdaterSandbox(updater => {
    // given process.exit and console.error stubbed to capture the failure without killing the runner
    const origExit = process.exit;
    const origErr = console.error;
    let exitCode = null;
    process.exit = code => {
      exitCode = code;
      throw new Error('exit'); // stop execution the way a real exit would
    };
    console.error = () => {};

    // when / then
    try {
      updater.run(['bogus']);
    } catch {
      // expected from the stubbed exit
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
    assert.equal(exitCode, 1);
  });
});

test('run() install without --api-base-url and no prior config exits non-zero, installs nothing', async () => {
  await inUpdaterSandbox((updater, home) => {
    // given process.exit stubbed to stop execution the way a real exit would
    const origExit = process.exit;
    const origErr = console.error;
    let exitCode = null;
    process.exit = code => {
      exitCode = code;
      throw new Error('exit');
    };
    console.error = () => {};

    // when running install with no --api-base-url and no pre-existing config
    try {
      updater.run(['install']);
    } catch {
      // expected from the stubbed exit
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }

    // then it refused before writing anything
    assert.equal(exitCode, 1);
    assert.equal(fs.existsSync(installedPluginPath(home)), false);
  });
});

test('run() install with --api-base-url and --repo-raw-base-url succeeds and stores both', async () => {
  await inUpdaterSandbox((updater, home) => {
    // when
    updater.run([
      'install', '--api-base-url', 'https://example.com',
      '--repo-raw-base-url', 'https://github.example.com/org/repo/raw/main',
    ]);

    // then the plugin is installed and both values are persisted
    assert.equal(fs.existsSync(installedPluginPath(home)), true);
    const cfg = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    assert.equal(cfg.apiBaseUrl, 'https://example.com');
    assert.equal(cfg.repoRawBaseUrl, 'https://github.example.com/org/repo/raw/main');
  });
});

test('run() install with the = form of both flags also works', async () => {
  await inUpdaterSandbox((updater, home) => {
    // when
    updater.run([
      'install', '--api-base-url=https://example.com',
      '--repo-raw-base-url=https://github.example.com/org/repo/raw/main',
    ]);

    // then
    const cfg = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    assert.equal(cfg.apiBaseUrl, 'https://example.com');
    assert.equal(cfg.repoRawBaseUrl, 'https://github.example.com/org/repo/raw/main');
  });
});

test('run() re-install without --api-base-url fails — no fallback to a previously stored value', async () => {
  await inUpdaterSandbox((updater, home) => {
    // given a first install with both required flags
    updater.run([
      'install', '--api-base-url', 'https://example.com',
      '--repo-raw-base-url', 'https://github.example.com/org/repo/raw/main',
    ]);
    const origExit = process.exit;
    const origErr = console.error;
    let exitCode = null;
    process.exit = code => {
      exitCode = code;
      throw new Error('exit');
    };
    console.error = () => {};

    // when re-installing (e.g. a manual npx re-run) without repeating --api-base-url
    try {
      updater.run(['install', '--repo-raw-base-url', 'https://github.example.com/org/repo/raw/main']);
    } catch {
      // expected from the stubbed exit
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }

    // then it refuses — config.json is never consulted as a fallback
    assert.equal(exitCode, 1);
    const cfg = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    assert.equal(cfg.apiBaseUrl, 'https://example.com'); // untouched by the failed re-run
  });
});

test('run() install without --repo-raw-base-url exits non-zero, installs nothing', async () => {
  await inUpdaterSandbox((updater, home) => {
    const origExit = process.exit;
    const origErr = console.error;
    let exitCode = null;
    process.exit = code => {
      exitCode = code;
      throw new Error('exit');
    };
    console.error = () => {};

    // when running install with --api-base-url but no --repo-raw-base-url
    try {
      updater.run(['install', '--api-base-url', 'https://example.com']);
    } catch {
      // expected from the stubbed exit
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }

    // then it refused before writing anything
    assert.equal(exitCode, 1);
    assert.equal(fs.existsSync(installedPluginPath(home)), false);
  });
});

test('install stores --repo-raw-base-url when passed', async () => {
  await inUpdaterSandbox((updater, home) => {
    // when
    updater.install('https://example.com', 'https://github.example.com/org/repo/raw/main');

    // then
    const cfg = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    assert.equal(cfg.repoRawBaseUrl, 'https://github.example.com/org/repo/raw/main');
  });
});

test('isPlausibleUrl (default requirePath) accepts http(s) URLs with a path and rejects everything else', async () => {
  await inUpdaterSandbox(updater => {
    // given / when / then — this is the --repo-raw-base-url shape: it always points at a
    // specific route (e.g. /org/repo/raw/main), never a domain root
    assert.equal(updater.isPlausibleUrl('https://example.com/ingest/opencode'), true);
    assert.equal(updater.isPlausibleUrl('http://example.com/ingest'), false);
    assert.equal(updater.isPlausibleUrl('http://localhost/ingest'), true);
    assert.equal(updater.isPlausibleUrl('http://127.0.0.1:3000/ingest'), true);
    assert.equal(updater.isPlausibleUrl('https://example.com'), false);
    assert.equal(updater.isPlausibleUrl('https://example.com/'), false);
    assert.equal(updater.isPlausibleUrl('anything'), false);
    assert.equal(updater.isPlausibleUrl('ftp://example.com/ingest'), false);
    assert.equal(updater.isPlausibleUrl(''), false);
  });
});

test('isPlausibleUrl(url, false) also accepts a bare origin — the --api-base-url shape', async () => {
  await inUpdaterSandbox(updater => {
    // given / when / then — plugin.js appends the fixed ingest path itself, so the
    // configured API base URL is just a host with no required path
    assert.equal(updater.isPlausibleUrl('https://example.com', false), true);
    assert.equal(updater.isPlausibleUrl('https://example.com/', false), true);
    assert.equal(updater.isPlausibleUrl('https://example.com/api', false), true);
    assert.equal(updater.isPlausibleUrl('anything', false), false);
    assert.equal(updater.isPlausibleUrl('ftp://example.com', false), false);
  });
});

test('run() install rejects an implausible --api-base-url (e.g. "anything")', async () => {
  await inUpdaterSandbox((updater, home) => {
    const origExit = process.exit;
    const origErr = console.error;
    let exitCode = null;
    let errOutput = '';
    process.exit = code => {
      exitCode = code;
      throw new Error('exit');
    };
    console.error = msg => {
      errOutput += msg;
    };

    // when
    try {
      updater.run([
        'install', '--api-base-url', 'anything',
        '--repo-raw-base-url', 'https://github.example.com/org/repo/raw/main',
      ]);
    } catch {
      // expected from the stubbed exit
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }

    // then it refuses before writing anything
    assert.equal(exitCode, 1);
    assert.match(errOutput, /valid http\(s\) URLs/);
    assert.equal(fs.existsSync(installedPluginPath(home)), false);
  });
});

test('parseApiBaseUrlArg reads both the space-separated and = forms', async () => {
  await inUpdaterSandbox(updater => {
    const { parseApiBaseUrlArg } = updater.__internal;
    // given/when/then: space form, = form, and absent
    assert.equal(parseApiBaseUrlArg(['install', '--api-base-url', 'https://x.test']), 'https://x.test');
    assert.equal(parseApiBaseUrlArg(['install', '--api-base-url=https://x.test']), 'https://x.test');
    assert.equal(parseApiBaseUrlArg(['install']), undefined);
  });
});

test('parseRepoUrlArg reads both the space-separated and = forms', async () => {
  await inUpdaterSandbox(updater => {
    const { parseRepoUrlArg } = updater.__internal;
    // given/when/then: space form, = form, and absent
    assert.equal(
      parseRepoUrlArg(['install', '--repo-raw-base-url', 'https://x.test']), 'https://x.test');
    assert.equal(
      parseRepoUrlArg(['install', '--repo-raw-base-url=https://x.test']), 'https://x.test');
    assert.equal(parseRepoUrlArg(['install']), undefined);
  });
});

test('extractCommand skips a value-flag\'s separate-token value so the URL is never misread as the command', async () => {
  await inUpdaterSandbox(updater => {
    const { extractCommand } = updater.__internal;
    // given/when/then: missing the "install" word — the flag's value must not be taken as the command
    assert.equal(extractCommand(['--api-base-url', 'https://x.test']), undefined);
    assert.equal(extractCommand(['--api-base-url', 'https://x.test', 'install']), 'install');
    assert.equal(extractCommand(['install', '--api-base-url', 'https://x.test']), 'install');
  });
});

test('rawUrl joins a base and file, trailing-slash safe', async () => {
  await inUpdaterSandbox(updater => {
    const { rawUrl } = updater.__internal;
    // given/when/then
    assert.equal(rawUrl('https://x.test/-/raw/main', 'plugin.js'), 'https://x.test/-/raw/main/plugin.js');
    assert.equal(rawUrl('https://x.test/-/raw/main/', 'plugin.js'), 'https://x.test/-/raw/main/plugin.js');
  });
});

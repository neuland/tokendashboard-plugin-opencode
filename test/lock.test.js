import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inSandbox, pluginDataDir } from './helpers.js';

const lockPath = home => path.join(pluginDataDir(home), 'test.lock');

test('acquireLock takes a free lock and releaseLock frees it', async () => {
  await inSandbox((hook, home) => {
    // given a lock dir
    fs.mkdirSync(pluginDataDir(home), { recursive: true });
    const lf = lockPath(home);

    // when/then
    assert.equal(hook.acquireLock(lf), true);
    assert.equal(fs.existsSync(lf), true);
    hook.releaseLock(lf);
    assert.equal(fs.existsSync(lf), false);
  });
});

test('acquireLock backs off when a live process holds the lock', async () => {
  await inSandbox((hook, home) => {
    // given a lock owned by this (alive) process
    fs.mkdirSync(pluginDataDir(home), { recursive: true });
    const lf = lockPath(home);
    fs.writeFileSync(lf, String(process.pid));

    // when a second acquire is attempted
    // then it fails (the holder is alive)
    assert.equal(hook.acquireLock(lf), false);
  });
});

test('acquireLock steals a stale lock left by a dead process', async () => {
  await inSandbox((hook, home) => {
    // given a lock file pointing at a PID that cannot be alive
    fs.mkdirSync(pluginDataDir(home), { recursive: true });
    const lf = lockPath(home);
    fs.writeFileSync(lf, '2147483647'); // implausible PID — process.kill(pid,0) throws

    // when
    const got = hook.acquireLock(lf);

    // then the stale lock is stolen and now owned by us
    assert.equal(got, true);
    assert.equal(fs.readFileSync(lf, 'utf8'), String(process.pid));
  });
});

test('acquireLock steals an empty (crashed-creator) lock', async () => {
  await inSandbox((hook, home) => {
    // given an empty lock file (writer died between create and PID write → NaN)
    fs.mkdirSync(pluginDataDir(home), { recursive: true });
    const lf = lockPath(home);
    fs.writeFileSync(lf, '');

    // when/then
    assert.equal(hook.acquireLock(lf), true);
  });
});

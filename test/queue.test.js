import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inSandbox, queueDir, queueFileNames } from './helpers.js';

test('writeEntry creates a timestamp-pid-counter named json file and getQueueFiles lists it', async () => {
  await inSandbox((hook, home) => {
    // when two entries are written in the same process
    hook.writeEntry({ a: 1 });
    hook.writeEntry({ a: 2 });

    // then both land as distinct .json files matching the naming scheme
    const names = queueFileNames(home);
    assert.equal(names.length, 2);
    for (const n of names) {
      assert.match(n, /^\d+-\d+-\d+\.json$/);
    }
    assert.equal(hook.getQueueFiles().length, 2);
  });
});

test('getQueueFiles ignores dotfiles (e.g. the lock) and non-json', async () => {
  await inSandbox((hook, home) => {
    // given a queue with a lock file and a stray file alongside a real entry
    hook.writeEntry({ a: 1 });
    fs.writeFileSync(path.join(queueDir(home), '.lock'), '123');
    fs.writeFileSync(path.join(queueDir(home), 'notes.txt'), 'x');

    // then only the real entry is returned
    assert.equal(hook.getQueueFiles().length, 1);
  });
});

test('enqueueTime parses the leading timestamp and rejects non-matching names', async () => {
  await inSandbox(hook => {
    // given/when/then
    assert.equal(hook.enqueueTime('/q/1700000000000-42-0.json'), 1700000000000);
    assert.equal(hook.enqueueTime('/q/not-a-number.json'), null);
  });
});

test('pruneOldQueue deletes entries older than the age cap and keeps fresh ones', async () => {
  await inSandbox((hook, home) => {
    // given one stale and one fresh queue file (named by enqueue time)
    fs.mkdirSync(queueDir(home), { recursive: true });
    const old = path.join(queueDir(home), `${Date.now() - hook.constants.MAX_QUEUE_AGE_MS - 1000}-1-0.json`);
    const fresh = path.join(queueDir(home), `${Date.now()}-1-1.json`);
    fs.writeFileSync(old, '{}');
    fs.writeFileSync(fresh, '{}');

    // when
    const survivors = hook.pruneOldQueue([old, fresh]);

    // then the stale file is gone, the fresh one remains
    assert.deepEqual(survivors, [fresh]);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true);
  });
});

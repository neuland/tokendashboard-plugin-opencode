import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  inSandbox, stubFetch, makeResponse, readQueue, queueFileNames, deadLetterDir,
} from './helpers.js';

const TEST_API_BASE_URL = 'https://example.com';
const TEST_INGEST_URL = 'https://example.com/api/usage/ingest/opencode';

test('flush is a no-op (queue kept) when no apiBaseUrl is configured', async () => {
  await inSandbox(async (hook, home) => {
    // given a queued entry but no apiBaseUrl in config.json (e.g. a pre-existing queue from
    // before install stored one, or a stripped/corrupt config)
    hook.writeEntry({ entry_id: 'a' });
    const fetchStub = stubFetch(() => makeResponse({ status: 200, json: { ok: true } }));

    // when
    await hook.flush();

    // then no request was made and the entry stays queued
    fetchStub.restore();
    assert.equal(fetchStub.calls.length, 0);
    assert.equal(readQueue(home).length, 1);
  });
});

test('flush posts { user_id, prompts } and clears the queue on a genuine 2xx', async () => {
  await inSandbox(async (hook, home) => {
    // given a configured apiBaseUrl and two queued entries
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ entry_id: 'a', model: 'm' });
    hook.writeEntry({ entry_id: 'b', model: 'm' });
    const fetchStub = stubFetch(() => makeResponse({ status: 200, json: { ok: true } }));

    // when
    await hook.flush();

    // then one POST went to the configured apiBaseUrl's ingest path, carried both prompts, and the queue is empty
    fetchStub.restore();
    assert.equal(fetchStub.calls.length, 1);
    assert.equal(String(fetchStub.calls[0].url), TEST_INGEST_URL);
    const body = JSON.parse(fetchStub.calls[0].options.body);
    assert.ok(body.user_id);
    assert.equal(body.prompts.length, 2);
    assert.equal(readQueue(home).length, 0);
  });
});

test('flush leaves entries queued on a network error (transient)', async () => {
  await inSandbox(async (hook, home) => {
    // given a configured apiBaseUrl, a queued entry and a network that throws
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ entry_id: 'a' });
    const fetchStub = stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });

    // when
    await hook.flush();

    // then the entry survives for the next flush
    fetchStub.restore();
    assert.equal(readQueue(home).length, 1);
  });
});

test('flush treats a captive-portal 200-HTML as failure and keeps the queue', async () => {
  await inSandbox(async (hook, home) => {
    // given a configured apiBaseUrl, a queued entry and a captive portal answering 200 with HTML
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ entry_id: 'a' });
    const fetchStub = stubFetch(() => makeResponse({ status: 200, contentType: 'text/html', text: '<html>' }));

    // when
    await hook.flush();

    // then nothing is deleted
    fetchStub.restore();
    assert.equal(readQueue(home).length, 1);
  });
});

test('flush treats a followed redirect as failure and keeps the queue', async () => {
  await inSandbox(async (hook, home) => {
    // given a configured apiBaseUrl, a queued entry and a 2xx that was redirected
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ entry_id: 'a' });
    const fetchStub = stubFetch(() => makeResponse({ status: 200, redirected: true, json: { ok: true } }));

    // when
    await hook.flush();

    // then nothing is deleted
    fetchStub.restore();
    assert.equal(readQueue(home).length, 1);
  });
});

test('flush dead-letters a permanently rejected (400) single entry', async () => {
  await inSandbox(async (hook, home) => {
    // given a configured apiBaseUrl and a queued entry the server rejects with 400
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ entry_id: 'bad' });
    const fetchStub = stubFetch(() => makeResponse({ status: 400, json: { error: 'bad' } }));

    // when
    await hook.flush();

    // then it leaves the live queue and lands in dead-letter/
    fetchStub.restore();
    assert.equal(readQueue(home).length, 0);
    assert.equal(fs.readdirSync(deadLetterDir(home)).length, 1);
  });
});

test('flush bisects a poisoned batch, delivering the good entry and quarantining the poison', async () => {
  await inSandbox(async (hook, home) => {
    // given a configured apiBaseUrl, one good and one poison entry; the server 400s any batch
    // containing the poison
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ entry_id: 'good', model: 'ok' });
    hook.writeEntry({ entry_id: 'poison', model: 'poison' });
    const fetchStub = stubFetch((url, options) => {
      const { prompts } = JSON.parse(options.body);
      const hasPoison = prompts.some(p => p.model === 'poison');
      return makeResponse(hasPoison ? { status: 400, json: {} } : { status: 200, json: { ok: true } });
    });

    // when
    await hook.flush();

    // then the good entry is delivered (queue empty) and only the poison is dead-lettered
    fetchStub.restore();
    assert.equal(readQueue(home).length, 0);
    const dead = fs.readdirSync(deadLetterDir(home));
    assert.equal(dead.length, 1);
  });
});

test('flush is a no-op with an empty queue (no fetch)', async () => {
  await inSandbox(async hook => {
    // given an empty queue
    const fetchStub = stubFetch(() => makeResponse({}));

    // when
    await hook.flush();

    // then no request is made
    fetchStub.restore();
    assert.equal(fetchStub.calls.length, 0);
  });
});

test('flush drops a locally corrupt (unparseable) queue file without sending it', async () => {
  await inSandbox(async (hook, home) => {
    // given a configured apiBaseUrl, a valid entry and a corrupt file
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ entry_id: 'a' });
    const dir = `${home}/.config/opencode/tokendashboard-plugin/queue`;
    fs.writeFileSync(`${dir}/9999999999999-1-9.json`, '{ not json');
    const fetchStub = stubFetch(() => makeResponse({ status: 200, json: { ok: true } }));

    // when
    await hook.flush();

    // then the corrupt file is gone, the valid one was sent, queue is empty
    fetchStub.restore();
    const body = JSON.parse(fetchStub.calls[0].options.body);
    assert.equal(body.prompts.length, 1);
    assert.equal(queueFileNames(home).length, 0);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inSandbox, assistantMessage, readQueue } from './helpers.js';

test('captureMessage writes one entry with tokens, cost and provider', async () => {
  await inSandbox((hook, home) => {
    // given a finalized assistant message
    const m = assistantMessage();

    // when
    const written = hook.captureMessage(m);

    // then one queue entry carries the full token breakdown plus cost
    assert.equal(written, true);
    const entries = readQueue(home);
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.session_id, 'sess-1');
    assert.equal(e.model, 'claude-sonnet-4-6');
    assert.equal(e.provider, 'anthropic');
    assert.deepEqual(e.usage, {
      input_tokens: 100,
      output_tokens: 50,
      reasoning_tokens: 10,
      cache_read_tokens: 200,
      cache_write_tokens: 5,
    });
    assert.equal(e.cost, 0.0123);
    assert.equal(e.timestamp, new Date(2000).toISOString());
  });
});

test('captureMessage dedupes repeated message.updated for the same message', async () => {
  await inSandbox((hook, home) => {
    // given the same finalized message seen several times (streaming snapshots)
    const m = assistantMessage();

    // when captured repeatedly
    assert.equal(hook.captureMessage(m), true);
    assert.equal(hook.captureMessage(m), false);
    assert.equal(hook.captureMessage({ ...m }), false);

    // then it is queued exactly once
    assert.equal(readQueue(home).length, 1);
  });
});

test('captureMessage ignores non-finalized messages (no time.completed)', async () => {
  await inSandbox((hook, home) => {
    // given a message still streaming
    const m = assistantMessage({ time: { created: 1000 } });

    // when / then
    assert.equal(hook.captureMessage(m), false);
    assert.equal(readQueue(home).length, 0);
  });
});

test('captureMessage ignores user messages and nullish input', async () => {
  await inSandbox((hook, home) => {
    // given non-assistant inputs
    assert.equal(hook.captureMessage(assistantMessage({ role: 'user' })), false);
    assert.equal(hook.captureMessage(null), false);
    assert.equal(hook.captureMessage(undefined), false);

    // then nothing is queued
    assert.equal(readQueue(home).length, 0);
  });
});

test('two finalized messages in one turn produce two entries', async () => {
  await inSandbox((hook, home) => {
    // given a tool-call loop: two finalized assistant messages, possibly different models
    hook.captureMessage(assistantMessage({ id: 'msg-1', modelID: 'claude-sonnet-4-6' }));
    hook.captureMessage(assistantMessage({ id: 'msg-2', modelID: 'claude-opus-4-8' }));

    // then both are captured, one per message/model
    const models = readQueue(home).map(e => e.model).sort();
    assert.deepEqual(models, ['claude-opus-4-8', 'claude-sonnet-4-6']);
  });
});

test('entryId is stable for the same session/message/model and differs otherwise', async () => {
  await inSandbox(hook => {
    // given/when/then — same inputs hash equal, a changed field hashes different
    const a = hook.entryId('s', 'm', 'model');
    assert.equal(a, hook.entryId('s', 'm', 'model'));
    assert.notEqual(a, hook.entryId('s', 'm', 'other-model'));
    assert.notEqual(a, hook.entryId('s', 'other-m', 'model'));
  });
});

test('buildEntry defaults missing token fields to 0', async () => {
  await inSandbox(hook => {
    // given a message with no tokens object
    const e = hook.buildEntry(assistantMessage({ tokens: undefined, cost: undefined }));

    // then usage is fully zero-filled and cost defaults to 0
    assert.deepEqual(e.usage, {
      input_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
      cache_read_tokens: 0, cache_write_tokens: 0,
    });
    assert.equal(e.cost, 0);
  });
});

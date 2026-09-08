import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inUpdaterSandbox } from './helpers.js';

// semverGt moved from plugin.js to updater.js (the update logic now lives there); it is
// exported on updater.__internal (ADR-010).
test('semverGt compares versions and rejects non-numeric input', async () => {
  await inUpdaterSandbox(updater => {
    const { semverGt } = updater.__internal;
    // greater
    assert.equal(semverGt('0.2.0', '0.1.9'), true);
    assert.equal(semverGt('1.0.0', '0.9.9'), true);
    assert.equal(semverGt('0.1.10', '0.1.9'), true);
    // not greater
    assert.equal(semverGt('0.1.0', '0.1.0'), false);
    assert.equal(semverGt('0.1.0', '0.2.0'), false);
    // missing trailing segments padded with 0
    assert.equal(semverGt('1.2', '1.2.0'), false);
    assert.equal(semverGt('1.2.1', '1.2'), true);
    // non-numeric / pre-release tags are rejected (false), not silently mishandled
    assert.equal(semverGt('0.3.0-beta', '0.2.0'), false);
    assert.equal(semverGt('garbage', '0.1.0'), false);
  });
});

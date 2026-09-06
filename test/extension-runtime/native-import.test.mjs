import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeLibraryImportProducer } from '../../.trace-build/extension-runtime/native-import.mjs';
import { BrowserFirstStoryInitiator } from '../../.trace-build/extension-runtime/first-story-initiation.mjs';

const requestID = '00000000-0000-4000-8000-000000000001';
const handoffID = '00000000-0000-4000-8000-000000000002';
const now = 1800000000000;
const scope = { accountId: 'synthetic-account', epoch: 7 };
const payload = { s: 'ao3', at: 'synthetic', items: [{ src: 'ao3', u: 'https://archiveofourown.org/works/123', notes: 'café 📚' }] };
function fixture({ intercept = () => undefined, collectResult, mode = 'promise', randomID = () => requestID,
  clock = () => now } = {}) {
  const messages = [];
  const events = [];
  let current = true;
  const runtime = {
    sendNativeMessage(...args) {
      const message = args.find((value) => value && typeof value === 'object');
      messages.push(message); events.push(message.type);
      const override = intercept(message, { setCurrent: (value) => current = value });
      const result = override ?? (message.type === 'TRACE_IOS_IMPORT_PREPARE'
        ? { type: message.type, protocolVersion: 1, ok: true, state: 'prepared', handoffID,
          expiresAtMs: now + 600000, maximumPayloadBytes: 524288, maximumItems: 250 }
        : message.type === 'TRACE_IOS_IMPORT_STAGE'
          ? { type: message.type, protocolVersion: 1, ok: true, state: 'ready_to_open', handoffID, expiresAtMs: now + 600000 }
          : { type: message.type, protocolVersion: 1, ok: true, state: 'cancelled' });
      if (mode === 'callback') { Promise.resolve(result).then(args.at(-1)); return; }
      return Promise.resolve(result);
    },
  };
  let webCreates = 0;
  const tabs = {
    async query() { return [{ id: 1, url: 'https://archiveofourown.org/works/123' }]; },
    async sendMessage() { events.push('collect'); return collectResult ?? { ok: true, payload }; },
    async create() { webCreates += 1; return { id: 2 }; },
  };
  const collector = new BrowserFirstStoryInitiator({ runtime, tabs, mode: 'promise', webOrigin: 'https://web.example.test' });
  const producer = new NativeLibraryImportProducer({ runtime, mode,
    apiOrigin: 'https://development.example.test', randomID, now: clock });
  return { producer, collector, messages, events, webCreates: () => webCreates,
    setCurrent: (value) => current = value,
    run: () => producer.run(scope, async () => current, (stage) => collector.importActivePage(stage)) };
}
for (const mode of ['promise', 'callback']) {
  test(`native ${mode} producer reserves before collect; returns only opaque continuation`, async () => {
    const f = fixture({ mode });
    assert.deepEqual(await f.run(), { ok: true, state: 'ready_to_open', handoffID, expiresAtMs: now + 600000 });
    assert.deepEqual(f.events, ['TRACE_IOS_IMPORT_PREPARE', 'collect', 'TRACE_IOS_IMPORT_STAGE']);
    assert.deepEqual(JSON.parse(Buffer.from(f.messages[1].payloadBase64, 'base64').toString('utf8')), payload);
    assert.equal(f.webCreates(), 0);
    assert.equal(f.messages[0].accountID, scope.accountId);
    assert.equal(f.messages[0].accountEpoch, scope.epoch);
    assert.ok(f.messages.every((message) => !('credential' in message) && !('token' in message) && !('profileID' in message)));
  });
}
test('unsupported native candidate never collects or opens web import', async () => {
  const f = fixture({ intercept: () => ({ ok: false, error: 'unsupported' }) });
  assert.deepEqual(await f.run(), { ok: false, error: 'native_import_unavailable' });
  assert.deepEqual(f.events, ['TRACE_IOS_IMPORT_PREPARE']);
  assert.equal(f.webCreates(), 0);
});
test('lost capability after prepare cancels exact reservation before collection', async () => {
  const f = fixture({ intercept: (message, context) => { if (message.type.endsWith('PREPARE')) context.setCurrent(false); } });
  assert.equal((await f.run()).ok, false);
  assert.deepEqual(f.events, ['TRACE_IOS_IMPORT_PREPARE', 'TRACE_IOS_IMPORT_CANCEL']);
  assert.deepEqual(f.messages[1], { type: 'TRACE_IOS_IMPORT_CANCEL', protocolVersion: 1, requestID, handoffID });
});
test('lost capability while staging cannot publish a continuation and cancels exact bytes slot', async () => {
  const f = fixture({ intercept: (message, context) => { if (message.type.endsWith('STAGE')) context.setCurrent(false); } });
  assert.equal((await f.run()).ok, false);
  assert.equal(f.events.at(-1), 'TRACE_IOS_IMPORT_CANCEL');
  assert.equal(f.webCreates(), 0);
});
test('collector retains existing safe unsupported outcome and cancels prepared slot', async () => {
  const f = fixture({ collectResult: { ok: false, error: 'page_contains_password_field' } });
  assert.deepEqual(await f.run(), { ok: false, error: 'unsupported_page' });
  assert.deepEqual(f.events, ['TRACE_IOS_IMPORT_PREPARE', 'collect', 'TRACE_IOS_IMPORT_CANCEL']);
});
test('conflicting native acknowledgement cannot become a URL', async () => {
  const f = fixture({ intercept: (message) => message.type.endsWith('STAGE')
    ? { type: message.type, protocolVersion: 1, ok: true, state: 'ready_to_open', handoffID: requestID, expiresAtMs: now + 600000 } : undefined });
  assert.equal((await f.run()).ok, false);
  assert.equal(f.events.at(-1), 'TRACE_IOS_IMPORT_CANCEL');
});
test('overlapping clicks do not create duplicate active native reservations', async () => {
  const f = fixture();
  let resume;
  const first = f.producer.run(scope, () => new Promise((resolve) => resume = resolve), () => Promise.resolve({ ok: false, error: 'collect_failed' }));
  await Promise.resolve();
  assert.equal((await f.run()).ok, false);
  resume(false);
  assert.equal((await first).ok, false);
  assert.equal(f.messages.length, 0);
});
test('ordinary desktop collector still creates its web Import URL', async () => {
  const f = fixture();
  assert.deepEqual(await f.collector.importActivePage(), { ok: true, state: 'opened' });
  assert.equal(f.webCreates(), 1);
  assert.equal(f.messages.length, 0);
});

test('a fresh admitted Import cancels only its own earlier unclaimed handoff before reserving', async () => {
  const f = fixture();
  assert.equal((await f.run()).state, 'ready_to_open');
  f.events.length = 0;
  assert.equal((await f.run()).state, 'ready_to_open');
  assert.deepEqual(f.events, ['TRACE_IOS_IMPORT_CANCEL', 'TRACE_IOS_IMPORT_PREPARE', 'collect', 'TRACE_IOS_IMPORT_STAGE']);
});

test('native call-form fallback preserves exact request IDs and body bytes', async () => {
  let first = true;
  const f = fixture({ intercept: () => { if (first) { first = false; throw new Error('signature unavailable'); } } });
  assert.equal((await f.run()).state, 'ready_to_open');
  assert.deepEqual(f.messages[0], f.messages[1]);
});

test('native call-form fallback does not replay PREPARE after capability departure', async () => {
  const f = fixture({ intercept: (_message, context) => {
    context.setCurrent(false);
    throw new Error('transport failed after capability departure');
  } });
  assert.equal((await f.run()).ok, false);
  assert.deepEqual(f.events, ['TRACE_IOS_IMPORT_PREPARE']);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const prepareAck = { type: 'TRACE_IOS_IMPORT_PREPARE', protocolVersion: 1, ok: true,
  state: 'prepared', handoffID, expiresAtMs: now + 600000, maximumPayloadBytes: 524288, maximumItems: 250 };

for (const mode of ['promise', 'callback']) {
  for (const phase of ['PREPARE', 'STAGE']) {
    test(`${mode} recovers a committed ${phase} with a lost acknowledgement using the same body`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
      let dropped = false;
      const f = fixture({ mode, intercept: (message) => {
        if (message.type.endsWith(phase) && !dropped) {
          dropped = true;
          return new Promise(() => {});
        }
      } });
      const result = f.run();
      await flush();
      assert.equal(f.events.filter((event) => event === 'collect').length, phase === 'PREPARE' ? 0 : 1);
      t.mock.timers.tick(2500);
      assert.equal((await result).state, 'ready_to_open');
      const attempts = f.messages.filter((message) => message.type.endsWith(phase));
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0], attempts[1], 'retry keeps the same request object');
      assert.equal(f.events.filter((event) => event === 'collect').length, 1);
      assert.equal(f.webCreates(), 0);
    });
  }

  test(`${mode} retains two ambiguous PREPARE attempts across clicks and cancels before minting a new ID`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
    let prepares = 0; let ids = 0;
    const f = fixture({ mode,
      randomID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
      intercept: (message) => {
        if (message.type.endsWith('PREPARE') && ++prepares <= 2) return new Promise(() => {});
      },
    });
    const first = f.run();
    await flush();
    t.mock.timers.tick(2500);
    await flush();
    t.mock.timers.tick(2500);
    assert.deepEqual(await first, { ok: false, error: 'native_import_unavailable' });
    assert.equal(ids, 1);
    assert.equal(f.events.includes('collect'), false);
    assert.equal((await f.run()).state, 'ready_to_open');
    assert.equal(ids, 2);
    assert.deepEqual(f.events, ['TRACE_IOS_IMPORT_PREPARE', 'TRACE_IOS_IMPORT_PREPARE',
      'TRACE_IOS_IMPORT_PREPARE', 'TRACE_IOS_IMPORT_CANCEL', 'TRACE_IOS_IMPORT_PREPARE',
      'collect', 'TRACE_IOS_IMPORT_STAGE']);
    assert.equal(f.messages[0], f.messages[2]);
    assert.equal(f.messages[3].requestID, f.messages[0].requestID);
    assert.notEqual(f.messages[4].requestID, f.messages[0].requestID);
  });

  test(`${mode} stale ambiguous PREPARE cannot retry or recollect; a late acknowledgement only cancels`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
    let acknowledge;
    const f = fixture({ mode, intercept: (message) => {
      if (message.type.endsWith('PREPARE')) return new Promise((resolve) => acknowledge = resolve);
    } });
    const result = f.run();
    await flush();
    f.setCurrent(false);
    t.mock.timers.tick(2500);
    assert.equal((await result).ok, false);
    assert.equal((await f.run()).ok, false);
    assert.deepEqual(f.events, ['TRACE_IOS_IMPORT_PREPARE']);
    acknowledge(prepareAck);
    await flush();
    assert.deepEqual(f.events, ['TRACE_IOS_IMPORT_PREPARE', 'TRACE_IOS_IMPORT_CANCEL']);
    assert.deepEqual(f.messages[1], { type: 'TRACE_IOS_IMPORT_CANCEL', protocolVersion: 1, requestID, handoffID });
    assert.equal(f.webCreates(), 0);
  });
}

test('lost cancellation acknowledgement retains its exact ID until a retry confirms it is terminal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  let cancellations = 0; let ids = 0;
  const f = fixture({ randomID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    intercept: (message) => {
      if (message.type.endsWith('CANCEL')) {
        if (++cancellations <= 2) return new Promise(() => {});
        return { type: message.type, protocolVersion: 1, ok: false, error: 'replayed' };
      }
    },
  });
  assert.equal((await f.run()).state, 'ready_to_open');
  const second = f.run();
  await flush();
  t.mock.timers.tick(2500);
  await flush();
  t.mock.timers.tick(2500);
  assert.equal((await second).ok, false);
  assert.equal(ids, 1);
  assert.equal((await f.run()).state, 'ready_to_open');
  assert.equal(ids, 2);
  const cancelled = f.messages.filter((message) => message.type.endsWith('CANCEL'));
  assert.equal(cancelled.length, 3);
  assert.deepEqual(cancelled[0], cancelled[2]);
});

test('unresolved PREPARE ownership expires finitely without replaying a departed capability', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  let prepares = 0; let ids = 0; let drop = true;
  const f = fixture({ clock: Date.now,
    randomID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    intercept: (message) => {
      if (message.type.endsWith('PREPARE')) {
        prepares += 1;
        return drop ? new Promise(() => {}) : { ...prepareAck, expiresAtMs: Date.now() + 600000 };
      }
      if (message.type.endsWith('STAGE')) return { type: message.type, protocolVersion: 1,
        ok: true, state: 'ready_to_open', handoffID, expiresAtMs: Date.now() + 600000 };
    },
  });
  let originalCurrent = true;
  const first = f.producer.run(scope, async () => originalCurrent, async () => assert.fail('must not collect'));
  await flush();
  originalCurrent = false;
  t.mock.timers.tick(2500);
  assert.equal((await first).ok, false);
  // A delivered PREPARE may have created a native reservation just before the
  // request admission window closed. Keep ownership for that second lifetime.
  t.mock.timers.tick(600000);
  assert.equal((await f.run()).ok, false);
  assert.equal(prepares, 1);
  assert.equal(ids, 1);
  t.mock.timers.tick(600000);
  drop = false;
  assert.equal((await f.run()).state, 'ready_to_open');
  assert.equal(prepares, 2);
  assert.equal(ids, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { BrowserDeviceSessionProvider } from '../../.trace-build/extension-runtime/browser-device-session.mjs';
import { BrowserCredentialPort } from '../../.trace-build/extension-runtime/browser-adapters.mjs';
import { BrowserPrivateRecordDatabase, PRIVATE_RECORD_KEYS } from '../../.trace-build/extension-runtime/private-database.mjs';
import { installSessionRuntime } from '../../.trace-build/extension-runtime/controller.mjs';
const token = `trd_v1_${'a'.repeat(43)}`;
const issued = (id) => ({ status: 'issued', credential: token, session: { installationId: id, id: '00000000-0000-4000-8000-000000000002', absoluteExpiresAt: '2099-01-01T00:00:00.000Z' } });
function fixture({ native = false, fetch: override } = {}) {
  const database = new BrowserPrivateRecordDatabase(new IDBFactory());
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, ...init });
    if (override) return override(url, init);
    return new Response(JSON.stringify(url.endsWith('/device-sessions') ? issued(JSON.parse(init.body).installationId) : { ok: true }), { status: 200 });
  };
  const provider = new BrowserDeviceSessionProvider({ database, fetch, apiBase: 'https://api.tracefiction.com', isNative: async () => native,
    provider: { acquire: async () => ({ kind: 'credential', credential: 'page-access-token' }), cancel() {} } });
  return { provider, database, requests };
}
test('page access grant becomes a scoped background-only credential', async () => {
  const { provider, requests, database } = fixture();
  assert.deepEqual(await provider.acquire('connect'), { kind: 'credential', credential: token });
  assert.equal(requests[0].headers.Authorization, 'Bearer page-access-token');
  const body = JSON.parse(requests[0].body);
  assert.equal(body.platform, 'browser');
  assert.equal(body.installationId, await database.get(PRIVATE_RECORD_KEYS.browserInstallationId));
  assert.equal(requests[0].credentials, 'omit');
});
test('upgrade survives port reconstruction; opaque credentials do not consult a page or exchange again', async () => {
  const { provider, database, requests } = fixture();
  await database.put(PRIVATE_RECORD_KEYS.sessionCredentials, { version: 1, entries: { old: 'page-access-token' } });
  const port = new BrowserCredentialPort(database, provider, () => 'id');
  assert.equal(await port.load('old'), token);
  const restarted = new BrowserCredentialPort(database, provider, () => 'id2');
  assert.equal(await restarted.load('old'), token);
  assert.equal(requests.length, 1);
  await restarted.delete('old');
  await new Promise(r => setImmediate(r));
  assert.equal(requests[1].method, 'DELETE');
  assert.equal(requests[1].headers.Authorization, `Bearer ${token}`);
  assert.equal(await restarted.load('old'), null);
});
test('iOS acquisition and cleanup never exchange or revoke app-owned credentials', async () => {
  const { provider, requests } = fixture({ native: true });
  assert.equal((await provider.acquire('connect')).credential, 'page-access-token');
  assert.equal(await provider.upgrade('native-token'), 'native-token');
  await provider.release(token);
  assert.equal(requests.length, 0);
});
test('Disconnect during issuance revokes late credential and cannot return authority', async () => {
  let resolve, entered;
  const started = new Promise(r => entered = r);
  const { provider, requests } = fixture({ fetch: async (url, init) => {
    if (!url.endsWith('/device-sessions')) return new Response('{}');
    entered();
    await new Promise(r => resolve = r);
    return new Response(JSON.stringify(issued(JSON.parse(init.body).installationId)));
  } });
  const connecting = provider.acquire('connect');
  await started; provider.cancel(); resolve();
  assert.deepEqual(await connecting, { kind: 'cancelled' });
  await new Promise(r => setImmediate(r));
  assert.equal(requests.at(-1).method, 'DELETE');
});
test('failed exchange cannot silently create a new short-lived connection; existing access is preserved for verification', async () => {
  const { provider } = fixture({ fetch: async () => new Response('', { status: 503 }) });
  assert.deepEqual(await provider.acquire('connect'), { kind: 'unavailable' });
  assert.equal(await provider.upgrade('old-access-token'), 'old-access-token');
});
test('runtime cold starts with a scoped browser session and zero Trace tabs after the old access token is rejected', async () => {
  const databaseFactory = new IDBFactory(), db = new BrowserPrivateRecordDatabase(databaseFactory);
  await db.put(PRIVATE_RECORD_KEYS.sessionEnvelope, { version: 1, epoch: 1, desired: 'connected', accountId: 'a', credentialRef: 'current' });
  await db.put(PRIVATE_RECORD_KEYS.sessionCredentials, { version: 1, entries: { current: token } });
  let pages = 0, exchanges = 0;
  const controller = installSessionRuntime({ mode: 'kernel', browserDeviceSessions: true, databaseFactory, privateDatabase: db,
    runtime: { onMessage: { addListener() {} }, getPlatformInfo: async () => ({ os: 'android' }) },
    tabs: { query: async () => { pages++; return []; }, sendMessage: async () => null, create: async () => ({}) },
    storageArea: { get: async () => ({}), set: async () => {}, remove: async () => {} }, storageMode: 'promise',
    alarms: { clear: async () => true }, apiBase: 'https://api.tracefiction.com', webOrigin: 'https://www.tracefiction.com', randomId: () => 'id',
    fetch: async (url, init) => {
      if (url.endsWith('/device-sessions')) exchanges++;
      return init.headers.Authorization === `Bearer ${token}` ? new Response(JSON.stringify({ account_id: 'a' })) : new Response('', { status: 401 });
    } });
  await controller.start();
  assert.equal(controller.snapshot().state, 'connected');
  assert.equal(controller.snapshot().canExecuteAuthenticated, true);
  assert.equal(pages, 0); assert.equal(exchanges, 0);
});

test('credential storage failure revokes the issued browser credential', async () => {
  const { provider, database, requests } = fixture();
  const acquisition = await provider.acquire('connect');
  const failingDatabase = { get: key => database.get(key), delete: key => database.delete(key), put: async () => { throw Error('quota'); } };
  const port = new BrowserCredentialPort(failingDatabase, provider, () => 'id');
  await assert.rejects(port.storeUnique(acquisition.credential, 1), /quota/);
  await new Promise(r => setImmediate(r));
  assert.equal(requests.at(-1).method, 'DELETE');
  assert.equal(await database.get(PRIVATE_RECORD_KEYS.sessionCredentials), null);
});

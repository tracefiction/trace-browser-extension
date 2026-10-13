import assert from "node:assert/strict";
import test from "node:test";

import {
  readStoryMembership,
  StoryMembershipApi,
} from "../../.trace-build/extension-runtime/story-membership.mjs";

// The network is stood in for throughout: no request leaves these tests.

const API = "https://api.trace.test";
const ENTRY_ID = "00000000-0000-4000-8000-000000000456";
const WORK_KEY = "ao3:4521";
const present = (overrides = {}) => ({
  success: true,
  data: {
    work_key: WORK_KEY,
    membership: "present",
    entry_id: ENTRY_ID,
    entry: { status: "PLANNING", readerStatus: "PLANNING", canonicalReaderStatus: "SAVED", entryId: ENTRY_ID },
    ...overrides,
  },
});
const absent = (overrides = {}) => ({ success: true, data: { work_key: WORK_KEY, membership: "absent", ...overrides } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const UNAVAILABLE = { kind: "success", value: { kind: "unavailable" } };
const INVALID = { kind: "success", value: { kind: "invalid_response" } };

function apiAnswering(answer) {
  const requests = [];
  const api = new StoryMembershipApi(async (url, init) => {
    requests.push({ url: String(url), init });
    return answer(url, init);
  }, `${API}/`);
  return { api, requests };
}

test("the membership read asks for one story by its key, with the account's sign-in and nothing else", async () => {
  for (const workKey of [WORK_KEY, "ffn:981"]) {
    const { api, requests } = apiAnswering(() => json(absent({ work_key: workKey })));
    assert.deepEqual(await api.read("credential", workKey), { kind: "success", value: { kind: "absent" } });
    assert.equal(requests.length, 1);
    const [{ url, init }] = requests;
    assert.equal(url, `${API}/api/extension/library-membership?work_key=${workKey}`);
    assert.deepEqual([...new URL(url).searchParams.keys()], ["work_key"], "the key is the only thing sent");
    assert.equal(init.method, "GET");
    assert.equal(init.cache, "no-store", "never answered from a kept copy");
    assert.deepEqual(init.headers, { Authorization: "Bearer credential" });
    assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal, "and it does not wait for ever");
  }
});

test("present carries the entry's own status; absent is absent", async () => {
  const found = apiAnswering(() => json(present()));
  assert.deepEqual(await found.api.read("credential", WORK_KEY), {
    kind: "success",
    value: { kind: "present", entry: { status: "PLANNING", readerStatus: "PLANNING", canonicalReaderStatus: "SAVED" } },
  });
  const missing = apiAnswering(() => json(absent()));
  assert.deepEqual(await missing.api.read("credential", WORK_KEY), { kind: "success", value: { kind: "absent" } });
});

test("a sign-in Trace turns down is reported as that, and nothing is read from its answer", async () => {
  for (const status of [401, 403]) {
    const { api } = apiAnswering(() => json(absent(), status));
    assert.deepEqual(await api.read("credential", WORK_KEY), { kind: "auth_rejected" });
  }
});

test("too many requests, a server error, a refused request or no network is not known, never absent", async () => {
  for (const status of [400, 404, 429, 500, 502, 503]) {
    const { api } = apiAnswering(() => json(absent(), status));
    assert.deepEqual(await api.read("credential", WORK_KEY), UNAVAILABLE, String(status));
  }
  const offline = apiAnswering(() => { throw new TypeError("network unavailable"); });
  assert.deepEqual(await offline.api.read("credential", WORK_KEY), UNAVAILABLE);
  const cutOff = apiAnswering((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    init.signal.dispatchEvent(new Event("abort"));
  }));
  assert.deepEqual(await cutOff.api.read("credential", WORK_KEY), UNAVAILABLE);
});

test("an answer that cannot be read, or is about another story, is not known, never absent", async () => {
  for (const [name, answer] of [
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["an empty body", () => new Response("", { status: 200 })],
    ["no data", () => json({ success: true })],
    ["not a success", () => json({ ...absent(), success: false })],
    ["another story, absent", () => json(absent({ work_key: "ao3:9" }))],
    ["another story, present", () => json(present({ work_key: "ao3:9" }))],
    ["no key", () => json({ success: true, data: { membership: "absent" } })],
    ["an unknown answer", () => json(absent({ membership: "maybe" }))],
    ["present with no entry", () => json(present({ entry: undefined }))],
    ["present with no entry id", () => json(present({ entry_id: undefined }))],
    ["present with an entry id that is not one", () => json(present({ entry_id: "123" }))],
    ["present with another entry's id", () => json(present({ entry_id: "00000000-0000-4000-8000-000000000999" }))],
    ["present with no status at all", () => json(present({ entry: { entryId: ENTRY_ID } }))],
  ]) {
    const { api } = apiAnswering(answer);
    assert.deepEqual(await api.read("credential", WORK_KEY), INVALID, name);
  }
});

test("a key that is not a story's key is never sent", async () => {
  for (const workKey of ["", "ao3:", "ao3:0123", "ao3:12&x=1", "ao3:12 ", "wattpad:12", "ffn:12/3", "AO3:12"]) {
    const { api, requests } = apiAnswering(() => json(absent({ work_key: workKey })));
    assert.deepEqual(await api.read("credential", workKey), UNAVAILABLE, workKey);
    assert.deepEqual(requests, [], workKey);
  }
});

// --- For the account that asked ---------------------------------------------------

function session({ recoveries = [] } = {}) {
  const state = { scope: { accountId: "account-a", epoch: 1 }, credentials: [] };
  return {
    state,
    publicationScope: () => state.scope,
    async executeAuthenticated(effect) {
      if (state.scope === null) return { kind: "unavailable" };
      const starting = state.scope;
      state.credentials.push(`credential-${state.credentials.length + 1}`);
      const result = await effect(state.credentials.at(-1));
      if (state.scope !== starting) return { kind: "stale" };
      if (result.kind === "success") return { kind: "published", value: result.value };
      if (result.kind === "auth_rejected") return { kind: "auth_rejected", recovery: recoveries.shift() ?? "reconnect_required" };
      return { kind: "unavailable" };
    },
  };
}

test("for the account that asked: present, absent, and everything else not known", async () => {
  const entry = { status: "READING", readerStatus: "READING", canonicalReaderStatus: "READING" };
  for (const [value, expected] of [
    [{ kind: "present", entry }, { kind: "present", entry }],
    [{ kind: "absent" }, { kind: "absent" }],
    [{ kind: "invalid_response" }, { kind: "unknown" }],
    [{ kind: "unavailable" }, { kind: "unknown" }],
  ]) {
    let asked = 0;
    const answer = await readStoryMembership(session(), {
      async read(credential, workKey) {
        asked += 1;
        assert.equal(credential, "credential-1");
        assert.equal(workKey, WORK_KEY);
        return { kind: "success", value };
      },
    }, WORK_KEY);
    assert.deepEqual(answer, expected);
    assert.equal(asked, 1, "one request");
  }
  const thrown = await readStoryMembership(session(), { async read() { throw new Error("offline"); } }, WORK_KEY);
  assert.deepEqual(thrown, { kind: "unknown" });
});

test("a refused sign-in is the account's state; one that then reconnects is asked once more and no further", async () => {
  let asked = 0;
  const refuse = { async read() { asked += 1; return { kind: "auth_rejected" }; } };
  assert.deepEqual(await readStoryMembership(session(), refuse, WORK_KEY), { kind: "account_refused" });
  assert.equal(asked, 1);

  // The account reconnected after the refusal: that request answered nothing, so one more is made.
  const answers = [{ kind: "auth_rejected" }, { kind: "success", value: { kind: "absent" } }];
  const reconnecting = session({ recoveries: ["connected"] });
  const second = await readStoryMembership(reconnecting, { async read() { return answers.shift(); } }, WORK_KEY);
  assert.deepEqual(second, { kind: "absent" });
  assert.deepEqual(reconnecting.state.credentials, ["credential-1", "credential-2"]);

  asked = 0;
  assert.deepEqual(
    await readStoryMembership(session({ recoveries: ["connected", "connected"] }), refuse, WORK_KEY),
    { kind: "unknown" },
    "refused again after reconnecting: not known, and not asked a third time",
  );
  assert.equal(asked, 2);
  assert.deepEqual(
    await readStoryMembership(session({ recoveries: ["stale"] }), refuse, WORK_KEY),
    { kind: "unknown" },
  );
});

test("with no account, or one that changed while Trace answered, nothing is known", async () => {
  const none = session();
  none.state.scope = null;
  let asked = 0;
  const api = { async read() { asked += 1; return { kind: "success", value: { kind: "absent" } }; } };
  assert.deepEqual(await readStoryMembership(none, api, WORK_KEY), { kind: "unknown" });
  assert.equal(asked, 0, "nothing is asked with no account");

  const changing = session();
  const answer = await readStoryMembership(changing, {
    async read() {
      changing.state.scope = { accountId: "account-b", epoch: 2 };
      return { kind: "success", value: { kind: "absent" } };
    },
  }, WORK_KEY);
  assert.deepEqual(answer, { kind: "unknown" }, "another account's Library says nothing of this one");
});

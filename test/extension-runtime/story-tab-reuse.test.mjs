import assert from 'node:assert/strict';
import test from 'node:test';
import { installStoryTabReuse, isWholeStoryLink, storyTabKey, STORY_TAB_REUSE_MESSAGE } from '../../.trace-build/extension-runtime/story-tab-reuse.mjs';

const chapter = 'https://archiveofourown.org/works/123/chapters/456';
const SITES = ['https://*.archiveofourown.org/*', 'https://www.fanfiction.net/*', 'https://m.fanfiction.net/*', 'https://trace.example.test/*'];

function harness({ open = [], origins = SITES, update, remove, removeMissing = false, now } = {}) {
  const calls = [];
  let listener = null;
  const runtime = { id: 'trace', onMessage: { addListener(fn) { listener = fn; } } };
  const tabs = {
    query: async (query) => { calls.push(['query', query]); return open; },
    sendMessage: async () => undefined,
    create: async () => undefined,
    update: update ?? (async (id, props) => { calls.push(['update', id, props]); return { id }; }),
    ...(removeMissing ? {} : { remove: remove ?? (async (id) => { calls.push(['remove', id]); }) }),
  };
  const permissions = { getAll: async () => ({ origins }) };
  const handle = installStoryTabReuse({ runtime, tabs, permissions, mode: 'promise', ...(now ? { now } : {}) });
  const ask = (url, tab = { id: 9, url }) => handle({ type: STORY_TAB_REUSE_MESSAGE, payload: { url } }, { id: 'trace', frameId: 0, tab });
  return { calls, ask, handle, listener: () => listener };
}

test('story keys name the site, the story and the chapter', () => {
  assert.equal(storyTabKey(chapter), 'ao3:123:456');
  assert.equal(storyTabKey(`${chapter}#trace-open`), 'ao3:123:456');
  assert.equal(storyTabKey(`${chapter}?view_adult=true#workskin`), 'ao3:123:456');
  assert.equal(storyTabKey('https://archiveofourown.org/collections/fest/works/123/chapters/456'), 'ao3:123:456');
  assert.equal(storyTabKey('https://archiveofourown.org/works/123'), 'ao3:123:work');
  assert.equal(storyTabKey('https://archiveofourown.org/works/123?view_full_work=true'), 'ao3:123:full');
  assert.equal(storyTabKey('https://www.fanfiction.net/s/789'), 'ffn:789:1');
  assert.equal(storyTabKey('https://www.fanfiction.net/s/789/1/Title'), 'ffn:789:1');
  assert.equal(storyTabKey('https://m.fanfiction.net/s/789/4/'), 'ffn:789:4');
  for (const raw of ['https://archiveofourown.org/works/123/comments', 'https://archiveofourown.org/users/login',
    'https://archiveofourown.org.evil.test/works/123', 'http://archiveofourown.org/works/123',
    'https://name:pw@archiveofourown.org/works/123', 'https://archiveofourown.org:444/works/123', 'not a url', 7]) {
    assert.equal(storyTabKey(raw), null, String(raw));
  }
});

test('a link to the story itself is the work page or the chapterless story page', () => {
  for (const raw of ['https://archiveofourown.org/works/123', 'https://archiveofourown.org/works/123/',
    'https://archiveofourown.org/works/123?view_adult=true', 'https://archiveofourown.org/collections/fest/works/123',
    'https://www.fanfiction.net/s/789', 'https://m.fanfiction.net/s/789/']) {
    assert.equal(isWholeStoryLink(raw), true, raw);
  }
  for (const raw of [chapter, 'https://archiveofourown.org/works/123?view_full_work=true',
    'https://www.fanfiction.net/s/789/1/Title', 'https://www.fanfiction.net/s/789/4/', 'https://archiveofourown.org/works/123/comments', 'not a url', 7]) {
    assert.equal(isWholeStoryLink(raw), false, String(raw));
  }
});

test('a link to the story itself brings forward the most recent tab anywhere in that story', async () => {
  const work = 'https://archiveofourown.org/works/123';
  const { calls, ask } = harness({ open: [
    { id: 9, url: work },
    { id: 3, url: 'https://archiveofourown.org/works/123/chapters/455', lastAccessed: 20 },
    { id: 4, url: `${chapter}#workskin`, lastAccessed: 50 },
    { id: 5, url: 'https://archiveofourown.org/works/123?view_full_work=true', lastAccessed: 30 },
    { id: 6, url: chapter, incognito: true, lastAccessed: 99 },
    { id: 7, url: 'https://archiveofourown.org/works/124/chapters/456', lastAccessed: 98 },
  ] });
  assert.deepEqual(await ask(work), { ok: true, reused: true, closed: true });
  assert.deepEqual(calls.slice(1), [['update', 4, { active: true }], ['remove', 9]]);

  const unknown = harness({ open: [{ id: 9, url: work },
    { id: 3, url: 'https://archiveofourown.org/works/123/chapters/455' }, { id: 4, url: chapter }] });
  assert.equal((await unknown.ask(work)).reused, true);
  assert.deepEqual(unknown.calls.slice(1), [['update', 3, { active: true }], ['remove', 9]]);

  const elsewhere = harness({ open: [{ id: 9, url: work }, { id: 7, url: 'https://archiveofourown.org/works/124/chapters/456' }] });
  assert.equal((await elsewhere.ask(work)).reused, false);
  assert.deepEqual(elsewhere.calls.slice(1), []);
});

test('a chapterless FanFiction.net link brings forward any chapter of that story', async () => {
  const { calls, ask } = harness({ open: [{ id: 9, url: 'https://www.fanfiction.net/s/789' },
    { id: 2, url: 'https://m.fanfiction.net/s/789/5/Title' }, { id: 3, url: 'https://www.fanfiction.net/s/790/5/Title', lastAccessed: 9 }] });
  assert.deepEqual(await ask('https://www.fanfiction.net/s/789'), { ok: true, reused: true, closed: true });
  assert.deepEqual(calls.slice(1), [['update', 2, { active: true }], ['remove', 9]]);
});

test('a marked new tab brings forward the open tab on the same chapter and closes itself', async () => {
  const { calls, ask } = harness({ open: [
    { id: 9, url: chapter },
    { id: 3, url: 'https://archiveofourown.org/works/123/chapters/455', lastAccessed: 50 },
    { id: 4, url: `${chapter}#workskin`, lastAccessed: 10 },
    { id: 5, url: chapter, lastAccessed: 40 },
    { id: 6, url: chapter, incognito: true, lastAccessed: 99 },
  ] });
  assert.deepEqual(await ask(`${chapter}`), { ok: true, reused: true, closed: true });
  assert.deepEqual(calls, [
    ['query', { url: ['https://*.archiveofourown.org/*', 'https://www.fanfiction.net/*', 'https://m.fanfiction.net/*'] }],
    ['update', 5, { active: true }],
    ['remove', 9],
  ]);
});

test('a different chapter, story or view leaves every tab alone', async () => {
  for (const url of ['https://archiveofourown.org/works/123/chapters/455', 'https://archiveofourown.org/works/123',
    'https://archiveofourown.org/works/123?view_full_work=true', 'https://archiveofourown.org/works/124/chapters/456']) {
    const { calls, ask } = harness({ open: [{ id: 9, url: chapter }, { id: 3, url }] });
    assert.deepEqual(await ask(chapter), { ok: true, reused: false, closed: false }, url);
    assert.deepEqual(calls.filter(([name]) => name !== 'query'), [], url);
  }
  const ffn = harness({ open: [{ id: 9, url: 'https://www.fanfiction.net/s/789/4/Title' }, { id: 3, url: 'https://www.fanfiction.net/s/789/5/Title' }] });
  assert.equal((await ffn.ask('https://www.fanfiction.net/s/789/4/Title')).reused, false);
  const whole = 'https://archiveofourown.org/works/123?view_full_work=true';
  const full = harness({ open: [{ id: 9, url: whole }, { id: 3, url: chapter }, { id: 4, url: 'https://archiveofourown.org/works/123' }] });
  assert.equal((await full.ask(whole)).reused, false);
});

test('FanFiction.net reuses the same chapter on either site', async () => {
  const { calls, ask } = harness({ open: [{ id: 9, url: 'https://www.fanfiction.net/s/789/4/Title' }, { id: 2, url: 'https://m.fanfiction.net/s/789/4/' }] });
  assert.deepEqual(await ask('https://www.fanfiction.net/s/789/4/Title'), { ok: true, reused: true, closed: true });
  assert.deepEqual(calls.slice(1), [['update', 2, { active: true }], ['remove', 9]]);
});

test('only the asking tab ever closes, and only after the open tab came forward', async () => {
  const failed = harness({ open: [{ id: 9, url: chapter }, { id: 5, url: chapter }],
    update: async () => { throw new Error('no such tab'); } });
  assert.deepEqual(await failed.ask(chapter), { ok: true, reused: false, closed: false });
  assert.equal(failed.calls.some(([name]) => name === 'remove'), false);

  const noRemove = harness({ open: [{ id: 9, url: chapter }, { id: 5, url: chapter }], removeMissing: true });
  assert.deepEqual(await noRemove.ask(chapter), { ok: true, reused: true, closed: false });

  const removeFails = harness({ open: [{ id: 9, url: chapter }, { id: 5, url: chapter }], remove: async () => { throw new Error('denied'); } });
  assert.deepEqual(await removeFails.ask(chapter), { ok: true, reused: true, closed: false });
});

test('two marked tabs never close each other', async () => {
  const open = [{ id: 9, url: chapter }, { id: 10, url: chapter }];
  const { calls, ask } = harness({ open });
  const [first, second] = await Promise.all([ask(chapter, { id: 9, url: chapter }), ask(chapter, { id: 10, url: chapter })]);
  assert.deepEqual([first.reused, second.reused], [false, false]);
  assert.equal(calls.some(([name]) => name === 'remove' || name === 'update'), false);
});

test('a tab asks once; a repeat or a malformed or foreign message does nothing', async () => {
  const { calls, ask, handle } = harness({ open: [{ id: 9, url: chapter }, { id: 5, url: chapter }] });
  const refused = { ok: false, reused: false, closed: false };
  const sender = { id: 'trace', frameId: 0, tab: { id: 9, url: chapter } };
  assert.deepEqual(await handle({ type: STORY_TAB_REUSE_MESSAGE }, sender), refused);
  assert.deepEqual(await handle({ type: STORY_TAB_REUSE_MESSAGE, payload: { url: chapter, close: 5 } }, sender), refused);
  assert.deepEqual(await handle({ type: STORY_TAB_REUSE_MESSAGE, payload: { url: chapter }, tabId: 5 }, sender), refused);
  assert.deepEqual(await handle({ type: STORY_TAB_REUSE_MESSAGE, payload: { url: chapter } }, { ...sender, id: 'other' }), refused);
  assert.deepEqual(await handle({ type: STORY_TAB_REUSE_MESSAGE, payload: { url: chapter } }, { ...sender, frameId: 2 }), refused);
  assert.deepEqual(await handle({ type: STORY_TAB_REUSE_MESSAGE, payload: { url: chapter } }, { id: 'trace', url: chapter }), refused);
  assert.deepEqual(await ask('https://archiveofourown.org/works/123/chapters/455', { id: 9, url: chapter }), refused);
  assert.deepEqual(await ask('https://trace.example.test/works/123', { id: 9, url: 'https://trace.example.test/works/123' }), refused);
  assert.deepEqual(calls, []);
  assert.equal((await ask(chapter)).reused, true);
  assert.equal((await ask(chapter)).reused, false);
});

test('without story-site access or a tab list, nothing is looked at or changed', async () => {
  const none = harness({ open: [{ id: 9, url: chapter }, { id: 5, url: chapter }], origins: ['https://trace.example.test/*'] });
  assert.deepEqual(await none.ask(chapter), { ok: true, reused: false, closed: false });
  assert.deepEqual(none.calls, []);
});

test('nothing comes forward once the reader has had time to move on', async () => {
  let clock = 1_000;
  const slow = harness({ open: [{ id: 9, url: chapter }, { id: 5, url: chapter }], now: () => clock });
  const pending = slow.ask(chapter);
  clock += 6_000;
  assert.deepEqual(await pending, { ok: true, reused: false, closed: false });
  assert.equal(slow.calls.some(([name]) => name === 'update' || name === 'remove'), false);
});

test('the runtime listener answers only its own message', async () => {
  const { listener } = harness({ open: [] });
  assert.equal(listener()({ type: 'TRACE_OTHER' }, { id: 'trace' }, () => {}), undefined);
  const reply = await new Promise((resolve) => {
    assert.equal(listener()({ type: STORY_TAB_REUSE_MESSAGE, payload: { url: chapter } }, { id: 'trace', frameId: 0, tab: { id: 9, url: chapter } }, resolve), true);
  });
  assert.deepEqual(reply, { ok: true, reused: false, closed: false });
});

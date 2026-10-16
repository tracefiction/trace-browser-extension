import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { collectOpenStoryTabs, encodeOpenStoryTabs, openStoryIdentity, readOpenStory } from '../../.trace-build/extension-runtime/open-story-tabs.mjs';
import { firstStoryInitiationFromMessage } from '../../.trace-build/extension-runtime/first-story-initiation.mjs';

const ao3 = 'https://archiveofourown.org/works/123/chapters/456';
const ffn = 'https://www.fanfiction.net/s/789/4/Synthetic';
const ao3HTML = `<div id="workskin"><h2 class="title heading">Snow &amp; Stars 雪</h2><h3 class="byline"><a rel="author">Synthetic Author</a></h3>
  <dl class="work meta group"><dd class="words">12,345</dd><dd class="chapters">8/?</dd></dl>
  <div class="chapter"><h3 class="title">Chapter 4</h3><div class="userstuff">PRIVATE STORY TEXT</div></div></div>`;
const ffnHTML = `<div id="profile_top"><b class="xcontrast_txt">Synthetic story</b><a href="/u/99">Writer</a>
  <span class="xgray">Rated: Fiction T - Chapters: 8 - Words: 12,000 - Status: Complete</span></div><select id="chap_select"><option selected>4. Four</option></select><div id="storytext">PRIVATE STORY TEXT</div>`;
function domRead(html, url, key = openStoryIdentity(url), deadline = Date.now() + 10000) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  try { return dom.window.eval(`(${readOpenStory.toString()})`)(key, deadline); }
  finally { dom.window.close(); }
}

test('reads metadata from hidden loaded AO3 and FFN DOMs without story text or URL resolution', () => {
  const a = domRead(ao3HTML, ao3);
  assert.equal(a.t, 'Snow & Stars 雪'); assert.equal(a.chn, 4); assert.equal(a.chPub, 8);
  assert.equal(a.w, 12345); assert.equal(a.s, 'wip'); assert.equal(a.ctx, 'tab');
  const f = domRead(ffnHTML, ffn);
  assert.equal(f.a, 'Writer'); assert.equal(f.s, 'complete'); assert.equal(f.chPub, 8);
  assert.equal(f.chn, 4); assert.equal(f.chu, ffn);
  assert.doesNotMatch(JSON.stringify([a, f]), /PRIVATE STORY TEXT|password|cookie|token/);
  assert.equal(domRead('<title>A URL alone is not enough</title>', ao3), null);
});
test('reads only the work byline author: anonymous works stay authorless, co-authors keep the first', () => {
  const fixture = name => fs.readFileSync(new URL(`../fixtures/ao3-author/${name}`, import.meta.url), 'utf8');
  const anonymous = domRead(fixture('anonymous-work-comments.html'), 'https://archiveofourown.org/works/41000010');
  assert.equal(anonymous.t, "The Lamplighter's Ledger");
  assert.equal(anonymous.a, undefined);
  const coAuthored = domRead(fixture('co-authored-work.html'), 'https://archiveofourown.org/works/41000012');
  assert.equal(coAuthored.a, 'Quill Fennimore');
});

test('excludes changed pages, expired injections and credential forms; permits the known AO3 sign-in header', () => {
  assert.equal(domRead(ao3HTML, ao3, 'ao3:124'), null);
  assert.equal(domRead(ao3HTML, ao3, 'ao3:123', 1), null);
  assert.equal(domRead(ao3HTML + '<form><input type="password" value="SECRET"></form>', ao3), null);
  const header = '<div id="header"><form id="new_user_session_small" action="/users/login"><input type="password" value="SECRET"></form></div>';
  assert.equal(domRead(header + ao3HTML, ao3).t, 'Snow & Stars 雪');
  assert.equal(openStoryIdentity('https://archiveofourown.org.evil.test/works/123'), null);
  assert.equal(openStoryIdentity('https://name:password@archiveofourown.org/works/123'), null);
  assert.equal(openStoryIdentity('https://archiveofourown.org/users/login'), null);
  assert.equal(domRead(ao3HTML, 'https://archiveofourown.org/collections/test/works/123/chapters/456').key, 'ao3:123');
});
test('partial scan deduplicates works, skips private/discarded tabs and never activates, reloads or runs normal collectors', async () => {
  const scripts = []; const queries = [];
  const tabs = [{ id: 1, url: ao3 }, { id: 2, url: ao3 }, { id: 3, url: ffn },
    { id: 4, url: 'https://archiveofourown.org/works/888?secret=value#private', title: 'Sleeping story', discarded: true },
    { id: 5, url: 'https://archiveofourown.org/works/999' },
    { id: 6, url: ao3, incognito: true }, { id: 7, url: 'https://unrelated.example.test/private' }];
  const result = await collectOpenStoryTabs({ runtime: {}, mode: 'promise',
    permissions: { getAll: async () => ({ origins: ['https://*.archiveofourown.org/*', 'https://www.fanfiction.net/*', 'https://unrelated.example.test/*'] }) },
    tabs: { query: async query => { queries.push(query); return tabs; } },
    scripting: { executeScript: async options => {
      scripts.push(options); if (options.target.tabId === 5) throw new Error('not allowed');
      return [{ frameId: 0, result: options.target.tabId === 3 ? domRead(ffnHTML, ffn) : domRead(ao3HTML, ao3) }];
    } },
  });
  assert.equal(queries.length, 2); assert.ok(queries[0].url.every(url => url.startsWith('https://') && !url.includes('<all_urls>')));
  assert.deepEqual(queries[1], { active: true, currentWindow: true });
  assert.deepEqual(result.items.map(item => item.key), ['ao3:123', 'ffn:789']);
  assert.deepEqual(result.scan, { considered: 5, unreadable: 2, duplicates: 1, limited: 0 });
  assert.deepEqual(result.unreadableTabs, [
    { u: 'https://archiveofourown.org/works/888', t: 'Sleeping story' },
    { u: 'https://archiveofourown.org/works/999', t: '' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret=value|#private|unrelated/);
  assert.deepEqual(scripts.map(script => script.target.tabId).sort(), [1, 2, 3, 5]);
  assert.ok(scripts.every(script => script.func === readOpenStory && !script.files && !script.target.allFrames));
  assert.equal(JSON.parse(Buffer.from(encodeOpenStoryTabs(result), 'base64').toString()).items[0].t, 'Snow & Stars 雪');
});
test('bounds scan and payload, reports partial failures, rejects subframe-only and mismatched replies', async () => {
  const result = await collectOpenStoryTabs({ runtime: {}, mode: 'promise',
    permissions: { getAll: async () => ({ origins: ['https://*.archiveofourown.org/*', 'https://www.fanfiction.net/*', 'https://unrelated.example.test/*'] }) },
    tabs: { query: async () => Array.from({ length: 251 }, (_, i) => ({ id: i, url: ao3 })) },
    scripting: { executeScript: async ({ target }) => target.tabId === 0 ? [{ frameId: 0, result: domRead(ao3HTML, ao3) }]
      : [{ frameId: 1, result: domRead(ao3HTML, ao3) }] },
  });
  assert.deepEqual(result.scan, { considered: 250, unreadable: 249, duplicates: 0, limited: 1 });
  assert.equal(encodeOpenStoryTabs({ ...result, items: [], unreadableTabs: [] }), null);
  assert.equal(encodeOpenStoryTabs({ ...result, items: [{ ...result.items[0], t: 'x'.repeat(524288) }] }), null);
  assert.equal(await collectOpenStoryTabs({ runtime: {}, tabs: {}, mode: 'promise' }), null);
});
test('open-tabs command belongs only to the extension popup, including Safari resource senders', () => {
  const command = { type: 'TRACE_IMPORT_OPEN_TABS' };
  assert.equal(firstStoryInitiationFromMessage(command, { url: ao3, tab: { id: 1, url: ao3 } }, 'trace', 'https://trace.test'), null);
  assert.equal(firstStoryInitiationFromMessage(command, { id: 'trace' }, 'trace', 'https://trace.test').kind, 'popup_open_tabs');
  assert.equal(firstStoryInitiationFromMessage(command, { url: 'safari-web-extension://bundle/Resources/popup.html' }, 'trace', 'https://trace.test').kind, 'popup_open_tabs');
});


test('without a persistent archive grant, only the explicitly used active tab is queried', async () => {
  const queries = [];
  const result = await collectOpenStoryTabs({ runtime: {}, mode: 'promise',
    permissions: { getAll: async () => ({ origins: ['https://unrelated.example.test/*'] }) },
    tabs: { query: async query => { queries.push(query); return [{ id: 1, url: ao3 }]; } },
    scripting: { executeScript: async () => [{ frameId: 0, result: domRead(ao3HTML, ao3) }] },
  });
  assert.deepEqual(queries, [{ active: true, currentWindow: true }]);
  assert.equal(result.items.length, 1);
});

for (const mode of ['promise', 'callback']) {
  test(`combines persistent and temporary access and reads each tab once (${mode})`, async () => {
    const queries = [], scripts = [];
    const api = value => (...args) => mode === 'callback' ? args.at(-1)(value(...args)) : Promise.resolve(value(...args));
    const result = await collectOpenStoryTabs({ runtime: {}, mode,
      permissions: { getAll: api(() => ({ origins: ['https://*.archiveofourown.org/*'] })) },
      tabs: { query: api(query => {
        queries.push(query);
        return query.active ? [{ id: 2, url: ffn }]
          : [{ id: 1, url: ao3 }, { id: 2, url: ffn }];
      }) },
      scripting: { executeScript: api(options => {
        scripts.push(options.target.tabId);
        return [{ frameId: 0, result: options.target.tabId === 2 ? domRead(ffnHTML, ffn) : domRead(ao3HTML, ao3) }];
      }) },
    });
    assert.deepEqual(queries, [{ url: ['https://*.archiveofourown.org/*'] }, { active: true, currentWindow: true }]);
    assert.deepEqual(result.items.map(item => item.key), ['ffn:789', 'ao3:123']);
    assert.deepEqual(result.scan, { considered: 2, unreadable: 0, duplicates: 0, limited: 0 });
    assert.deepEqual(scripts.sort(), [1, 2]);
  });
}

test('a failed query preserves tabs from the other permission scope', async () => {
  for (const failActive of [false, true]) {
    const result = await collectOpenStoryTabs({ runtime: {}, mode: 'promise',
      permissions: { getAll: async () => ({ origins: ['https://*.archiveofourown.org/*'] }) },
      tabs: { query: async query => {
        if (Boolean(query.active) === failActive) throw new Error('query failed');
        return [{ id: 1, url: ao3 }];
      } },
      scripting: { executeScript: async () => [{ frameId: 0, result: domRead(ao3HTML, ao3) }] },
    });
    assert.equal(result.items[0].key, 'ao3:123');
  }
});

test('unresolved browser reads retain the four-slot bound through timeouts and retries', async t => {
  const story = domRead(ao3HTML, ao3);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const scripts = [], completions = [];
  let outstanding = 0, maximum = 0;
  const ports = { runtime: {}, mode: 'promise',
    tabs: { query: async () => Array.from({ length: 8 }, (_, id) => ({ id, url: ao3 })) },
    scripting: { executeScript: options => {
      scripts.push(options);
      maximum = Math.max(maximum, ++outstanding);
      return new Promise(resolve => completions.push(() => { outstanding--; resolve([{ frameId: 0, result: story }]); }));
    } },
  };
  const first = collectOpenStoryTabs(ports);
  await setImmediate();
  assert.equal(scripts.length, 4);
  assert.ok(scripts.every(script => script.args[1] === 1_002_000));
  t.mock.timers.tick(2000); await setImmediate();
  assert.equal(scripts.length, 4, 'timed-out calls have not released browser capacity');
  t.mock.timers.tick(13000); await setImmediate();
  assert.deepEqual((await first).scan, { considered: 8, unreadable: 8, duplicates: 0, limited: 0 });
  const retry = collectOpenStoryTabs(ports);
  await setImmediate();
  assert.equal(scripts.length, 4, 'a retry must not pile more reads onto unresolved calls');
  completions[0](); await setImmediate();
  assert.equal(scripts.length, 5, 'only actual completion releases a slot');
  assert.equal(scripts[4].args[1], 1_017_000);
  t.mock.timers.tick(15000); await setImmediate();
  const result = await retry;
  assert.equal(result.items.length, 0, 'a late result from the previous scan cannot enter the retry');
  assert.equal(maximum, 4);
  for (const complete of completions.slice(1)) complete();
  await setImmediate();
  assert.equal(result.items.length, 0, 'late results cannot mutate a returned payload');
});

test('a late completion releases capacity without importing its stale result', async t => {
  const story = domRead(ao3HTML, ao3);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const scripts = [], completions = [];
  const scan = collectOpenStoryTabs({ runtime: {}, mode: 'promise',
    tabs: { query: async () => Array.from({ length: 5 }, (_, id) => ({ id, url: ao3 })) },
    scripting: { executeScript: options => {
      scripts.push(options);
      if (options.target.tabId === 4) return Promise.resolve([{ frameId: 0, result: story }]);
      return new Promise(resolve => completions.push(() => resolve([{ frameId: 0, result: story }])));
    } },
  });
  await setImmediate();
  t.mock.timers.tick(2500); await setImmediate();
  completions[0](); await setImmediate();
  assert.equal(scripts.length, 5);
  assert.equal(scripts[4].args[1], 1_004_500);
  const result = await scan;
  assert.deepEqual(result.scan, { considered: 5, unreadable: 4, duplicates: 0, limited: 0 });
  for (const complete of completions.slice(1)) complete();
});

test('the overall scan deadline includes permission and tab lookup time', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let releaseGrants, releaseTabs;
  const scripts = [];
  let returned = false;
  const scan = collectOpenStoryTabs({ runtime: {}, mode: 'promise',
    permissions: { getAll: () => new Promise(resolve => { releaseGrants = resolve; }) },
    tabs: { query: () => new Promise(resolve => { releaseTabs = resolve; }) },
    scripting: { executeScript: options => { scripts.push(options); return new Promise(() => {}); } },
  }).then(result => { returned = true; return result; });
  t.mock.timers.tick(1500); releaseGrants({ origins: [] }); await setImmediate();
  t.mock.timers.tick(1500); releaseTabs(Array.from({ length: 8 }, (_, id) => ({ id, url: ao3 }))); await setImmediate();
  assert.ok(scripts.every(script => script.args[1] === 1_005_000));
  t.mock.timers.tick(2000); await setImmediate();
  t.mock.timers.tick(9999); await setImmediate();
  assert.equal(returned, false);
  t.mock.timers.tick(1); await setImmediate();
  assert.equal(returned, true);
  assert.equal((await scan).scan.unreadable, 8);
});

test('reads the real mobile FFN header including abbreviated word counts', () => {
  const html = fs.readFileSync(new URL('../fixtures/ffn_story_mobile.html', import.meta.url), 'utf8');
  const result = domRead(html, 'https://m.fanfiction.net/s/7038840/1/A-Chance-Encounter');
  assert.equal(result.t, 'A Chance Encounter'); assert.equal(result.a, 'spectre4hire');
  assert.equal(result.w, 226000); assert.equal(result.chn, 1);
  assert.equal(result.chPub, undefined); assert.equal(result.s, undefined);
});

test('reads mobile chapter and completion metadata without inferring completion from the last chapter', () => {
  const completed = fs.readFileSync(new URL('../fixtures/end-of-story/ffn_last_chapter_mobile.html', import.meta.url), 'utf8');
  const result = domRead(completed, 'https://m.fanfiction.net/s/13500001/5/');
  assert.equal(result.t, 'Letters from Pemberley'); assert.equal(result.w, 7412);
  assert.equal(result.chPub, 5); assert.equal(result.cht, 5); assert.equal(result.chn, 5); assert.equal(result.s, 'complete');
  const unfinished = fs.readFileSync(new URL('../fixtures/end-of-story/ffn_wip_mobile.html', import.meta.url), 'utf8');
  const wip = domRead(unfinished, 'https://m.fanfiction.net/s/13500002/6/');
  assert.equal(wip.t, 'The Attic Plays'); assert.equal(wip.chPub, 6); assert.equal(wip.chn, 6);
  assert.equal(wip.s, undefined); assert.equal(wip.cht, undefined);
});

test('mobile header capture excludes nested story text, scripts and inputs', () => {
  const html = `<div id="content"><div align="center"><b>Rendered title</b> by <a href="/u/1/">Writer</a></div><hr>
    Rated: T, Words: 1.2k+, Chapters: 2
    <script>Words: 999999, Status: Complete</script><input value="SECRET">
    <div id="storycontent" class="gray">Words: 999999, Status: Complete, PRIVATE STORY TEXT</div><hr>
    Chapter 1: A start<br></div>`;
  const result = domRead(html, 'https://m.fanfiction.net/s/13500001/1/');
  assert.equal(result.w, 1200); assert.equal(result.chPub, 2); assert.equal(result.chn, 1);
  assert.equal(result.s, undefined);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE STORY TEXT|SECRET|999999/);
});

test('all unreadable tabs still produce a bounded review handoff with safe references', async () => {
  const result = await collectOpenStoryTabs({ runtime: {}, mode: 'promise',
    tabs: { query: async () => [{ id: 1, url: ao3 + '?private=value#secret', title: '  A   sleeping story  ', discarded: true }] },
    scripting: { executeScript: async () => { throw new Error('must not run'); } },
  });
  assert.equal(result.items.length, 0);
  assert.deepEqual(result.unreadableTabs, [{ u: ao3, t: 'A sleeping story' }]);
  assert.ok(encodeOpenStoryTabs(result));
  assert.deepEqual(JSON.parse(Buffer.from(encodeOpenStoryTabs(result), 'base64')), result);
});

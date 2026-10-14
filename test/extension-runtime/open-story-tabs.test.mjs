import assert from 'node:assert/strict';
import test from 'node:test';
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
    { id: 4, url: 'https://archiveofourown.org/works/888', discarded: true },
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
  assert.equal(queries.length, 1); assert.ok(queries[0].url.every(url => url.startsWith('https://') && !url.includes('<all_urls>')));
  assert.deepEqual(result.items.map(item => item.key), ['ao3:123', 'ffn:789']);
  assert.deepEqual(result.scan, { considered: 5, unreadable: 2, duplicates: 1, limited: 0 });
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
  assert.equal(encodeOpenStoryTabs({ ...result, items: [] }), null);
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

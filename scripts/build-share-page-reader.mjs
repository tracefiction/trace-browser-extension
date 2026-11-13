#!/usr/bin/env node
// Builds the page reader the Trace iPhone app gives Safari when a story page
// is shared to Trace. Safari runs it once, on the page that was shared, and
// hands what it read to the app.
//
// The file is collector.js up to the end of its reading functions, with a
// short ending that calls them. That stretch of collector.js also holds code
// the extension uses for other things (messages, the summary lookups). It is
// in the built file because it sits between the reading functions, but the
// ending never calls it and nothing in the file runs by itself:
// test/share-page-reader.test.mjs checks that reading a page sends no
// request, stores nothing, starts no timer and leaves the page as it was.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLLECTOR_PATH = path.join(ROOT, "Shared (Extension)", "Resources", "collector.js");
const CORE_START = "// COLLECTOR_CORE_START";
const READ_END = "\n// COLLECTOR_READ_END";
const READS_WITH = [
  "collectForSave", "hasStableAo3ChapterSignal", "shouldDisableTraceContentScript", "one",
];

// The collector expects an extension to talk to, and reads its switches from
// globalThis. A shared page has neither, so it gets an extension that does
// nothing and no switches. The stand-ins inherit from nothing, so the page
// can't set a switch through Object.prototype.
const HEAD = `var ExtensionPreprocessingJS = (function () {
var globalThis = { __proto__: null, chrome: { __proto__: null, runtime: { __proto__: null, lastError: null, sendMessage: function () {} } } };
`;

// Only a single AO3 or FanFiction.net story page is answered, on the sites
// the extension itself runs on. Anything else gives back nothing at all: no
// address, no title.
const TAIL = `
function sharedStorySite() {
  if (location.protocol !== "https:" || location.port) return null;
  var host = String(location.hostname).toLowerCase();
  var path = String(location.pathname || "");
  if (
    host === "archiveofourown.org" || host.endsWith(".archiveofourown.org") ||
    host === "archiveofourown.gay" || host.endsWith(".archiveofourown.gay") ||
    host === "archive.transformativeworks.org"
  ) {
    return /^\\/(?:collections\\/[A-Za-z0-9_]{1,255}\\/)?works\\/\\d+(?:\\/chapters\\/\\d+)?\\/?$/.test(path) ? "ao3" : null;
  }
  if (host === "www.fanfiction.net" || host === "m.fanfiction.net") {
    return /^\\/s\\/\\d+(?:\\/|$)/.test(path) ? "ffn" : null;
  }
  return null;
}

function readSharedStoryPage() {
  try {
    var site = sharedStorySite();
    if (!site || shouldDisableTraceContentScript()) return {};
    // The tests the extension makes before it saves a story page by itself:
    // the chapter is really on the page, and the story has a title.
    if (site === "ao3" && !hasStableAo3ChapterSignal()) return {};
    if (site === "ffn" && !one(document, "#storytext, #storytextp, #storycontent")) return {};
    var collected = collectForSave();
    var item = collected.items.length === 1 ? collected.items[0] : null;
    if (collected.source !== site || !item || item.ctx !== "story" || !item.t) return {};
    return { url: location.origin + location.pathname, source: site, item: item };
  } catch (_) {
    return {};
  }
}
return {
  run: function (request) {
    request.completionFunction({ tracePage: JSON.stringify(readSharedStoryPage()) });
  },
};
})();
`;

export function sharePageReader(collector = fs.readFileSync(COLLECTOR_PATH, "utf8")) {
  const start = collector.indexOf(CORE_START);
  const end = collector.indexOf(READ_END);
  if (start < 0 || end < start) {
    throw new Error("collector.js is missing the markers the share page reader is cut by");
  }
  const reading = collector.slice(start + CORE_START.length, end);
  for (const name of READS_WITH) {
    if (!reading.includes(`\nfunction ${name}(`)) {
      throw new Error(`collector.js no longer has ${name}() among its reading functions`);
    }
  }
  return HEAD + reading + TAIL;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) {
    console.error("usage: node scripts/build-share-page-reader.mjs <output.js>");
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, sharePageReader());
}

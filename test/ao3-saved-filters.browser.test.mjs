import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Real layout for the saved-filters panel inside a narrow AO3 Filters side
// bar: nothing inside the panel may clip or scroll, and the page must not
// scroll sideways, with long and many filters, on a light and a dark host.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = fs.readFileSync(path.join(ROOT, "Shared (Extension)", "Resources", "ao3-saved-filters.js"), "utf8");
const LISTING = fs.readFileSync(path.join(ROOT, "test", "fixtures", "ao3_listing.html"), "utf8");
const FORM = LISTING.match(/<form class="narrow-hidden filters" id="work-filters"[\s\S]*?<\/form>/)[0]
  .replace(/<script\b[\s\S]*?<\/script>/gi, "")
  .replace('class="narrow-hidden filters"', 'class="filters"');

// The parts of AO3's skin that reach the panel: buttons with a fixed em
// height and nowrap, and the grey filter fieldset.
function pageHtml(dark) {
  const bg = dark ? "#2a2a2a" : "#fff";
  const fieldset = dark ? "#333" : "#ddd";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
    html, body { background: ${bg}; margin: 0; }
    .landmark { position: absolute; left: -10000px; height: 1px; width: 1px; overflow: hidden; }
    .hidden { display: none !important; }
    button, input[type="submit"] { line-height: 1.286; height: 1.286em; padding: 0.25em 0.75em; white-space: nowrap; display: inline; border: 1px solid #bbb; }
    form.filters fieldset { background: ${fieldset}; border: 1px solid #bbb; margin: 0.643em 0; min-width: 0; padding: 0.643em; }
    form.filters dt { border-top: 1px solid #bbb; padding: 0.5em 0 0.25em; font-weight: bold; }
    form.filters dd { margin: 0 0 0.5em; }
    form.filters input[type="text"], form.filters select { box-sizing: border-box; max-width: 100%; border: 2px solid red; padding: 1px; }
    .drawer { margin-left: auto; width: 85vw; padding: 0 12px; box-sizing: border-box; }
  </style></head><body><div class="drawer">${FORM}</div></body></html>`;
}

const TAG = "Harry+Potter+-+J*d*+K*d*+Rowling";
const SELECTED = [
  ["include_work_search[rating_ids][]", "11"],
  ["include_work_search[archive_warning_ids][]", "16"],
  ["include_work_search[category_ids][]", "23"],
  ["include_work_search[relationship_ids][]", "1110"],
  ["include_work_search[freeform_ids][]", "143795"],
  ["include_work_search[freeform_ids][]", "2379"],
  ["exclude_work_search[archive_warning_ids][]", "18"],
  ["work_search[other_tag_names]", "Found Family,Emotional Hurt/Comfort with a Very Long Happy Ending"],
  ["work_search[complete]", "T"],
  ["work_search[words_from]", "10000"],
  ["work_search[words_to]", "50000"],
  ["work_search[sort_column]", "kudos_count"],
];
const URL_WITH_FILTERS = "https://archiveofourown.org/works?" +
  SELECTED.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&") +
  `&tag_id=${TAG}`;

function presets(withActive) {
  const list = Array.from({ length: 14 }, (_, index) => ({
    id: `p${index}`,
    name: `Saved filter number ${index + 1} with a fairly long name`,
    scope: index % 3 === 2 ? "global" : "context",
    params: [["include_work_search[relationship_ids][]", "1110"], ["include_work_search[freeform_ids][]", "103132"], ["work_search[words_from]", "50000"]],
    summary: [],
  }));
  if (withActive) {
    list.unshift({ id: "long", name: "Wolfstar hurt/comfort, complete, mid-length, no major character death", scope: "context", params: SELECTED, summary: [] });
  }
  return list;
}

const STATES = [
  { name: "unsaved", storage: { traceAo3SavedFiltersV1: presets(false) } },
  { name: "save form", storage: { traceAo3SavedFiltersV1: presets(false) }, click: "[data-trace-sf-action='save-open']" },
  { name: "long saved filter", storage: { traceAo3SavedFiltersV1: presets(true) }, click: "[data-trace-sf-action='show-all']" },
];

function storageStub(storage) {
  return `(() => {
    const state = ${JSON.stringify(storage)};
    window.chrome = window.browser = {
      runtime: { lastError: null, sendMessage(message, cb) { if (cb) cb({}); return Promise.resolve({}); } },
      storage: {
        local: {
          get(keys, cb) { const out = {}; for (const key of [].concat(keys)) out[key] = state[key]; cb(out); },
          set(patch, cb) { Object.assign(state, patch); if (cb) cb(); },
        },
        onChanged: { addListener() {} },
      },
    };
  })();`;
}

test("saved filters never clip or scroll inside a narrow AO3 side bar", async () => {
  const browser = await chromium.launch({ headless: true });
  const problems = [];
  try {
    for (const width of [320, 390]) {
      for (const dark of [false, true]) {
        for (const state of STATES) {
          const page = await browser.newPage({ viewport: { width, height: 800 } });
          await page.route("https://archiveofourown.org/**", (route) =>
            route.fulfill({ status: 200, contentType: "text/html", body: pageHtml(dark) }));
          await page.goto(URL_WITH_FILTERS);
          await page.evaluate(storageStub(state.storage));
          await page.evaluate(SCRIPT);
          await page.waitForSelector("[data-trace-ao3-saved-filters] .trace-sf-card");
          if (state.click) {
            await page.click(state.click);
            await page.waitForTimeout(50);
          }
          const found = await page.evaluate(() => {
            const out = [];
            const root = document.querySelector("[data-trace-ao3-saved-filters]");
            for (const el of [root, ...root.querySelectorAll("*")]) {
              if (el instanceof SVGElement || el.tagName === "INPUT") continue;
              const name = String(el.className || el.tagName);
              if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1) out.push(`${name} clips vertically`);
              if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) out.push(`${name} clips horizontally`);
            }
            const input = root.querySelector(".trace-sf-input");
            if (input) {
              const style = getComputedStyle(input);
              if (style.paddingLeft !== "12px" || style.borderTopWidth !== "0px") out.push("AO3's text input styles reach the name field");
            }
            if (document.documentElement.scrollWidth > window.innerWidth) out.push("the page scrolls sideways");
            return out;
          });
          for (const problem of found) problems.push(`${width}px ${dark ? "dark" : "light"} ${state.name}: ${problem}`);
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(problems, []);
});
